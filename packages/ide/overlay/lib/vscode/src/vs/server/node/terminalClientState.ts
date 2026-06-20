/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Which clients hold a terminal, which of them are receiving its output, and
 * which one the single-recipient workbench events go to. Sizing and flow
 * control are not here: the pty host arbitrates those per client itself, in
 * TerminalClients.
 */
export class TerminalClientState {
	private readonly _clients = new Map<number, Set<string>>();
	private readonly _uiTargets = new Map<number, string>();
	private readonly _streaming = new Map<number, Set<string>>();

	attach(id: number, clientId: string, makeUiTarget: boolean, streaming: boolean = false): void {
		let clients = this._clients.get(id);
		if (!clients) {
			clients = new Set();
			this._clients.set(id, clients);
		}
		clients.add(clientId);
		if (makeUiTarget || !this._uiTargets.has(id)) {
			this._uiTargets.set(id, clientId);
		}
		if (streaming) {
			this.markStreaming(id, clientId);
		}
	}

	detach(id: number, clientId: string): { attached: boolean; final: boolean } {
		const clients = this._clients.get(id);
		if (!clients?.delete(clientId)) {
			return { attached: false, final: false };
		}
		this._streaming.get(id)?.delete(clientId);
		if (!clients.size) {
			this.clear(id);
			return { attached: true, final: true };
		}
		if (this._uiTargets.get(id) === clientId) {
			this._uiTargets.set(id, clients.values().next().value as string);
		}
		return { attached: true, final: false };
	}

	detachClient(clientId: string): { id: number; final: boolean }[] {
		const detached: { id: number; final: boolean }[] = [];
		for (const id of [...this._clients.keys()]) {
			if (this._clients.get(id)?.has(clientId)) {
				detached.push({ id, final: this.detach(id, clientId).final });
			}
		}
		return detached;
	}

	isAttached(id: number, clientId: string): boolean { return this._clients.get(id)?.has(clientId) ?? false; }
	isUiTarget(id: number, clientId: string): boolean { return this._uiTargets.get(id) === clientId; }
	isStreaming(id: number, clientId: string): boolean { return this._streaming.get(id)?.has(clientId) ?? false; }

	takeUiControl(id: number, clientId: string): void {
		if (this.isAttached(id, clientId)) {
			this._uiTargets.set(id, clientId);
		}
	}

	markStreaming(id: number, clientId: string): void {
		if (!this.isAttached(id, clientId)) {
			return;
		}
		let streamingClients = this._streaming.get(id);
		if (!streamingClients) {
			streamingClients = new Set();
			this._streaming.set(id, streamingClients);
		}
		streamingClients.add(clientId);
	}

	clear(id: number): void {
		this._clients.delete(id);
		this._uiTargets.delete(id);
		this._streaming.delete(id);
	}
}
