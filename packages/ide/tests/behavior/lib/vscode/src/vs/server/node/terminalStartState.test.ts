import { afterEach, describe, expect, test, vi } from "vitest";

import { TerminalStartState } from "../../../../../../../../overlay/lib/vscode/src/vs/server/node/terminalStartState.ts";

// A start resolves through a promise the test holds, so the window where the
// client owns the replay is observable rather than inferred from timing.
function pendingStart() {
	let begun = false;
	const gate = Promise.withResolvers<void>();
	return {
		get begun() {
			return begun;
		},
		finish: gate.resolve,
		start: async () => {
			begun = true;
			await gate.promise;
		}
	};
}

const expectsReplay = () => true;
const noReplay = () => false;

afterEach(() => {
	vi.useRealTimers();
});

describe("terminal start state", () => {
	test("the starting client owns the replay until its start finishes", async () => {
		const state = new TerminalStartState();
		const pending = pendingStart();

		const run = state.run(1, "phone", noReplay, pending.start);
		await vi.waitFor(() => expect(state.target(1)).toBe("phone"));

		pending.finish();
		await run;
		expect(state.target(1)).toBeUndefined();
	});

	test("a start expecting a replay finishes when the replay lands", async () => {
		const state = new TerminalStartState();

		const run = state.run(1, "phone", expectsReplay, () =>
			Promise.resolve("started")
		);
		await vi.waitFor(() => expect(state.target(1)).toBe("phone"));
		state.replay(1);

		await expect(run).resolves.toBe("started");
	});

	// The pty exiting during a start is the case the timeout would otherwise
	// swallow for ten seconds, and the client would spend them attached to a
	// terminal that no longer exists.
	test("a terminal that exits before replaying fails its start", async () => {
		const state = new TerminalStartState();

		const run = state.run(1, "phone", expectsReplay, () =>
			Promise.resolve("started")
		);
		await vi.waitFor(() => expect(state.target(1)).toBe("phone"));
		state.exit(1);

		await expect(run).rejects.toThrow(
			'Terminal "1" exited before its replay completed'
		);
		expect(state.target(1)).toBeUndefined();
	});

	test("a replay that never arrives fails the start rather than hanging", async () => {
		vi.useFakeTimers();
		const state = new TerminalStartState();

		const run = state.run(1, "phone", expectsReplay, () =>
			Promise.resolve("started")
		);
		const settled = expect(run).rejects.toThrow(
			'Terminal "1" timed out before its replay completed'
		);
		await vi.advanceTimersByTimeAsync(10_000);

		await settled;
	});

	// Nothing else clears the timer, and a pty host serving a long-lived window
	// starts terminals for its whole life.
	test("a landed replay leaves no timer behind", async () => {
		vi.useFakeTimers();
		const state = new TerminalStartState();

		const run = state.run(1, "phone", expectsReplay, () =>
			Promise.resolve("started")
		);
		await vi.waitFor(() => expect(state.target(1)).toBe("phone"));
		state.replay(1);
		await run;

		expect(vi.getTimerCount()).toBe(0);
	});

	test("two clients starting one terminal are served one at a time", async () => {
		const state = new TerminalStartState();
		const first = pendingStart();
		const second = pendingStart();

		const one = state.run(1, "phone", noReplay, first.start);
		const two = state.run(1, "laptop", noReplay, second.start);

		await vi.waitFor(() => expect(first.begun).toBe(true));
		expect(second.begun).toBe(false);
		expect(state.target(1)).toBe("phone");

		first.finish();
		await one;
		await vi.waitFor(() => expect(state.target(1)).toBe("laptop"));
		second.finish();
		await two;
	});

	test("starts of different terminals do not wait on each other", async () => {
		const state = new TerminalStartState();
		const first = pendingStart();
		const second = pendingStart();

		const one = state.run(1, "phone", noReplay, first.start);
		const two = state.run(2, "phone", noReplay, second.start);

		await vi.waitFor(() => {
			expect(first.begun).toBe(true);
			expect(second.begun).toBe(true);
		});

		first.finish();
		second.finish();
		await Promise.all([one, two]);
	});

	// A rejected start must release the queue, or the terminal can never be
	// started again by anyone.
	test("a failed start releases the terminal for the next client", async () => {
		const state = new TerminalStartState();

		await expect(
			state.run(1, "phone", noReplay, () =>
				Promise.reject(new Error("no shell"))
			)
		).rejects.toThrow("no shell");

		expect(state.target(1)).toBeUndefined();
		await expect(
			state.run(1, "laptop", noReplay, () => Promise.resolve("started"))
		).resolves.toBe("started");
	});

	test("a start that expects no replay does not wait for one", async () => {
		vi.useFakeTimers();
		const state = new TerminalStartState();

		await expect(
			state.run(1, "phone", noReplay, () => Promise.resolve("started"))
		).resolves.toBe("started");
		expect(vi.getTimerCount()).toBe(0);
	});
});
