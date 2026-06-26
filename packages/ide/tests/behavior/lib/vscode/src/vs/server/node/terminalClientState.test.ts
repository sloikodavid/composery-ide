import { describe, expect, test } from "vitest";

import { TerminalClientState } from "../../../../../../../../overlay/lib/vscode/src/vs/server/node/terminalClientState.ts";

describe("terminal client state", () => {
	test("the pty is released by the final detach and no earlier one", () => {
		const clients = new TerminalClientState();
		clients.attach(1, "phone", true, true);
		clients.attach(1, "laptop", false);

		expect(clients.detach(1, "phone")).toEqual({
			attached: true,
			final: false
		});
		expect(clients.detach(1, "laptop")).toEqual({
			attached: true,
			final: true
		});
	});

	// A detach arriving from a client that never attached - a reconnect racing a
	// teardown - must not read as the last one out, or it takes the terminal down
	// under the clients that are still watching it.
	test("a client that does not hold the terminal detaches from nothing", () => {
		const clients = new TerminalClientState();
		clients.attach(1, "phone", true);

		expect(clients.detach(1, "laptop")).toEqual({
			attached: false,
			final: false
		});
		expect(clients.isAttached(1, "phone")).toBe(true);
		expect(clients.detach(2, "phone")).toEqual({
			attached: false,
			final: false
		});
	});

	test("the first client to attach is the UI target until one claims it", () => {
		const clients = new TerminalClientState();
		clients.attach(1, "phone", false);
		clients.attach(1, "laptop", false);
		expect(clients.isUiTarget(1, "phone")).toBe(true);

		clients.attach(1, "desktop", true);
		expect(clients.isUiTarget(1, "desktop")).toBe(true);
		expect(clients.isUiTarget(1, "phone")).toBe(false);

		clients.takeUiControl(1, "laptop");
		expect(clients.isUiTarget(1, "laptop")).toBe(true);
	});

	// Single-recipient events (the orphan question, an executeCommand) go to the UI
	// target alone, so a target that leaves has to be replaced: nobody holding it
	// means nobody answers, and the prompt never appears in any window.
	test("a departing UI target hands off to a client still holding the terminal", () => {
		const clients = new TerminalClientState();
		clients.attach(1, "phone", true);
		clients.attach(1, "laptop", false);

		clients.detach(1, "phone");

		expect(clients.isUiTarget(1, "laptop")).toBe(true);
	});

	// The other half of that: a window closing somewhere else must not move the
	// menus and prompts of the window the user is actually looking at.
	test("a client that was not the UI target leaves it where it was", () => {
		const clients = new TerminalClientState();
		clients.attach(1, "phone", true);
		clients.attach(1, "laptop", false);

		clients.detach(1, "laptop");

		expect(clients.isUiTarget(1, "phone")).toBe(true);
	});

	test("UI control cannot be taken by a client that is not attached", () => {
		const clients = new TerminalClientState();
		clients.attach(1, "phone", true);

		clients.takeUiControl(1, "laptop");

		expect(clients.isUiTarget(1, "laptop")).toBe(false);
		expect(clients.isUiTarget(1, "phone")).toBe(true);
	});

	// Output reaches a client only once its own replay has landed, so streaming is
	// granted per client and never inferred from being attached - the second window
	// would otherwise receive live bytes on top of a buffer it has not been sent.
	test("output streams only to clients whose replay has landed", () => {
		const clients = new TerminalClientState();
		clients.attach(1, "phone", true, true);
		clients.attach(1, "laptop", false);

		expect(clients.isStreaming(1, "phone")).toBe(true);
		expect(clients.isStreaming(1, "laptop")).toBe(false);

		clients.markStreaming(1, "laptop");
		expect(clients.isStreaming(1, "laptop")).toBe(true);

		clients.markStreaming(1, "desktop");
		expect(clients.isStreaming(1, "desktop")).toBe(false);
	});

	test("a detached client stops streaming and reattaching does not resume it", () => {
		const clients = new TerminalClientState();
		clients.attach(1, "phone", true, true);
		clients.attach(1, "laptop", false);

		clients.detach(1, "phone");
		clients.attach(1, "phone", false);

		expect(clients.isAttached(1, "phone")).toBe(true);
		expect(clients.isStreaming(1, "phone")).toBe(false);
	});

	// One socket closing releases every terminal that client held, and reports
	// which of them it was the last reader of - those are the ptys the channel
	// then detaches from.
	test("a disconnecting client reports every terminal it held", () => {
		const clients = new TerminalClientState();
		clients.attach(1, "phone", true);
		clients.attach(2, "phone", true);
		clients.attach(2, "laptop", false);
		clients.attach(3, "laptop", true);

		expect(clients.detachClient("phone")).toEqual([
			{ id: 1, final: true },
			{ id: 2, final: false }
		]);
		expect(clients.isAttached(2, "laptop")).toBe(true);
		expect(clients.detachClient("phone")).toEqual([]);
	});

	test("an exited terminal is forgotten entirely", () => {
		const clients = new TerminalClientState();
		clients.attach(1, "phone", true, true);

		clients.clear(1);

		expect(clients.isAttached(1, "phone")).toBe(false);
		expect(clients.isUiTarget(1, "phone")).toBe(false);
		expect(clients.isStreaming(1, "phone")).toBe(false);
	});
});
