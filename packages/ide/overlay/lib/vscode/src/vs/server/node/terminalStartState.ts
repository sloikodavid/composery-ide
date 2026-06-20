/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Binds a terminal's replay to the client that asked for it.
 *
 * A pty emits one replay per start, addressed to nobody in particular, so two
 * clients starting the same terminal at once would each receive the other's
 * buffer. Starts are therefore serialised per terminal, and while one is in
 * flight that client is the replay target - it is the only client the channel
 * forwards the replay and the ready event to, and live output reaches it only
 * once its own replay has landed.
 *
 * A start that expects a replay waits for it, because the client is not caught
 * up until it arrives. Two things end that wait early: the pty exiting (there
 * will be no replay) and the timeout (something went wrong upstream of us), and
 * both fail the start rather than leaving a client attached to a terminal it
 * has never seen.
 */

const REPLAY_TIMEOUT_MS = 10_000;

type ReplayOutcome = 'replay' | 'exit' | 'timeout';

interface IResolvers<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
}

function resolvers<T>(): IResolvers<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(settle => { resolve = settle; });
	return { promise, resolve };
}

export class TerminalStartState {
	private readonly _queues = new Map<number, Promise<void>>();
	private readonly _targets = new Map<number, string>();
	private readonly _replayWaiters = new Map<number, IResolvers<ReplayOutcome>>();

	target(id: number): string | undefined { return this._targets.get(id); }
	replay(id: number): void { this._replayWaiters.get(id)?.resolve('replay'); }
	exit(id: number): void { this._replayWaiters.get(id)?.resolve('exit'); }

	async run<T>(id: number, clientId: string, expectReplay: (result: T) => boolean, start: () => Promise<T>): Promise<T> {
		const previous = this._queues.get(id);
		const completion = resolvers<void>();
		this._queues.set(id, completion.promise);
		await previous;
		const replay = resolvers<ReplayOutcome>();
		this._targets.set(id, clientId);
		this._replayWaiters.set(id, replay);
		try {
			const result = await start();
			if (expectReplay(result)) {
				const outcome = await this._awaitReplay(replay.promise);
				if (outcome !== 'replay') {
					throw new Error(`Terminal "${id}" ${outcome === 'exit' ? 'exited' : 'timed out'} before its replay completed`);
				}
			}
			return result;
		} finally {
			// Still ours to clear, always: the next start is parked on `completion`
			// and cannot have claimed the terminal until the line below releases it.
			// Guarding this on the target still being clientId would be a condition
			// that cannot be false, which reports success forever.
			this._targets.delete(id);
			this._replayWaiters.delete(id);
			completion.resolve();
			// The queue is the other way round - a start that queued behind this one
			// has already replaced the entry, and that one is not ours to remove.
			if (this._queues.get(id) === completion.promise) {
				this._queues.delete(id);
			}
		}
	}

	private async _awaitReplay(replay: Promise<ReplayOutcome>): Promise<ReplayOutcome> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				replay,
				new Promise<ReplayOutcome>(resolve => {
					timer = setTimeout(() => resolve('timeout'), REPLAY_TIMEOUT_MS);
				})
			]);
		} finally {
			// The waiter outlives a resolved race, so an uncleared timer would hold
			// the pty host awake for the rest of the window on every start.
			clearTimeout(timer);
		}
	}
}
