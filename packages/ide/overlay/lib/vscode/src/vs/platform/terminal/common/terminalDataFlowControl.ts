/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Arbitrates the pty's single acknowledgement counter between every client
 * receiving the same terminal data. The furthest-ahead client drives it, so a
 * client that stops reading pauses only its own socket rather than the terminal
 * everyone else is watching, and acknowledgements never count the same bytes
 * twice.
 */
export class TerminalDataFlowControl {
	private readonly _clients = new Map<string, number>();
	private _produced = 0;
	private _acknowledged = 0;
	private readonly _acknowledge: (charCount: number) => void;

	// Written out rather than declared as a constructor parameter property: this
	// file is the one piece of the overlay a root test imports directly, and the
	// root tsconfig sets `erasableSyntaxOnly`, which that shorthand violates.
	constructor(acknowledge: (charCount: number) => void) {
		this._acknowledge = acknowledge;
	}

	acceptData(charCount: number): void {
		if (!Number.isSafeInteger(charCount) || charCount < 0) {
			throw new Error(`Invalid terminal data length: ${charCount}`);
		}
		this._produced += charCount;
		this._advance();
	}

	register(clientId: string): void {
		if (!this._clients.has(clientId)) {
			// At the tail: a client that arrives mid-command owes nothing for the
			// output that ran before it, and the serializer replays that anyway.
			this._clients.set(clientId, this._produced);
		}
	}

	unregister(clientId: string): void {
		if (this._clients.delete(clientId)) {
			this._advance();
		}
	}

	acknowledge(clientId: string, charCount: number): void {
		const previous = this._clients.get(clientId);
		if (previous === undefined) {
			throw new Error(`Terminal client "${clientId}" is not registered`);
		}
		if (!Number.isSafeInteger(charCount) || charCount < 0) {
			throw new Error(`Invalid terminal acknowledgement: ${charCount}`);
		}
		this._clients.set(clientId, Math.min(previous + charCount, this._produced));
		this._advance();
	}

	/**
	 * Replay clears the pty's native counter. Every registered client receives
	 * that replay broadcast, so live flow control resumes at the current tail.
	 */
	resetAfterReplay(): void {
		this._acknowledged = this._produced;
		for (const clientId of this._clients.keys()) {
			this._clients.set(clientId, this._produced);
		}
	}

	private _advance(): void {
		// With nobody registered there is no client that could ever acknowledge, and
		// the pty pauses above its high watermark until something does - a terminal
		// whose last reader disconnected would stall mid-command instead of running
		// on. So everything produced counts as acknowledged. Nothing is lost: the
		// serializer still records the output for replay.
		let next = this._produced;
		if (this._clients.size > 0) {
			next = 0;
			for (const position of this._clients.values()) {
				next = Math.max(next, position);
			}
		}
		if (next <= this._acknowledged) {
			return;
		}
		const delta = next - this._acknowledged;
		this._acknowledged = next;
		this._acknowledge(delta);
	}
}
