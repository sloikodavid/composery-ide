import { describe, expect, test } from "vitest";

import { TouchKeyboard } from "../../../../../../../../../../overlay/lib/vscode/src/vs/workbench/contrib/terminal/browser/touchKeyboard.ts";

// The order of the calls is the behaviour, not a detail: the hold has to be off
// before the focus cycle runs, or the cycle re-focuses an input the browser is
// still forbidden to raise a keyboard for and the tap does nothing.
function record() {
	const calls: string[] = [];
	const input = {
		setAttribute: (name: string, value: string) =>
			void calls.push(`set ${name}=${value}`),
		removeAttribute: (name: string) => void calls.push(`remove ${name}`),
		blur: () => void calls.push("blur"),
		focus: (options?: { preventScroll?: boolean }) =>
			void calls.push(`focus preventScroll=${options?.preventScroll}`)
	};
	return { calls, keyboard: new TouchKeyboard(input) };
}

describe("terminal touch keyboard", () => {
	// The reported defect: a swipe of the terminal buffer raised the keyboard on
	// release. A press that never becomes a tap is exactly that swipe, and it must
	// leave the hold on and the focus alone.
	test("a press that never becomes a tap holds the browser off and raises nothing", () => {
		const { calls, keyboard } = record();

		keyboard.press(false);

		expect(calls).toEqual(["set inputmode=none"]);
	});

	test("a tap lifts the hold, then raises the keyboard", () => {
		const { calls, keyboard } = record();

		keyboard.press(false);
		keyboard.tap(false);

		expect(calls).toEqual([
			"set inputmode=none",
			"remove inputmode",
			"blur",
			"focus preventScroll=true"
		]);
	});

	test("a touch never dismisses a keyboard that is already up", () => {
		const { calls, keyboard } = record();

		keyboard.press(true);
		keyboard.tap(true);

		expect(calls).toEqual([]);
	});

	test("a tap with the keyboard up lifts the hold without a focus cycle", () => {
		const { calls, keyboard } = record();

		keyboard.press(false);
		keyboard.tap(true);

		expect(calls).toEqual(["set inputmode=none", "remove inputmode"]);
	});

	test("a second press inside one hold sets nothing again", () => {
		const { calls, keyboard } = record();

		keyboard.press(false);
		keyboard.press(false);

		expect(calls).toEqual(["set inputmode=none"]);
	});

	test("a tap the press never armed does nothing at all", () => {
		const { calls, keyboard } = record();

		keyboard.tap(false);

		expect(calls).toEqual([]);
	});

	// The hold guards a press on the focused terminal. Carried past a blur it would
	// swallow the keyboard for the next command-driven focus (device-verified).
	test("losing focus drops the hold without raising anything", () => {
		const { calls, keyboard } = record();

		keyboard.press(false);
		calls.length = 0;
		keyboard.release();

		expect(calls).toEqual(["remove inputmode"]);
	});

	// Focus leaves the terminal and comes back: the next swipe has to be guarded
	// again, which only happens if the release actually gave the hold up.
	test("a press after a release takes the hold again", () => {
		const { calls, keyboard } = record();

		keyboard.press(false);
		keyboard.release();
		calls.length = 0;
		keyboard.press(false);

		expect(calls).toEqual(["set inputmode=none"]);
	});

	test("a blur with no hold taken changes nothing", () => {
		const { calls, keyboard } = record();

		keyboard.release();

		expect(calls).toEqual([]);
	});

	test("the tap cycle does not re-enter through its own blur", () => {
		const { calls, keyboard } = record();

		keyboard.press(false);
		keyboard.tap(false);
		calls.length = 0;
		keyboard.release();

		expect(calls).toEqual([]);
	});

	test("the hold is taken again for the next press", () => {
		const { calls, keyboard } = record();

		keyboard.press(false);
		keyboard.tap(false);
		calls.length = 0;
		keyboard.press(false);

		expect(calls).toEqual(["set inputmode=none"]);
	});
});
