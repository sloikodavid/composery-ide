import { describe, expect, test } from "vitest";

import {
	TouchPress,
	touchContextMenu
} from "../../../../../../../../../overlay/lib/vscode/src/vs/editor/browser/controller/touchPress.ts";

// The number Gesture classifies its own pans by; the editor is handed the same one.
const PAN_THRESHOLD = 16;

const press = (
	start: { startedOnText?: boolean; startedInSelection?: boolean } = {}
) =>
	new TouchPress(
		{
			startedOnText: start.startedOnText ?? true,
			startedInSelection: start.startedInSelection ?? false
		},
		PAN_THRESHOLD
	);

const mouseEvent = { isTrusted: true, pointerType: "mouse" };
const touchEvent = { isTrusted: true, pointerType: "touch" };
// Gesture synthesises one where the host fires none of its own.
const syntheticEvent = { isTrusted: false, pointerType: undefined };

describe("touch press", () => {
	// Finger jitter is not a scroll. The view must hold still under a hold, or the text
	// the user is trying to point at slides out from under them.
	test("a finger that has barely moved scrolls nothing", () => {
		const subject = press();

		expect(subject.translate(3, 4)).toBeUndefined();
		expect(subject.translate(-3, -4)).toBeUndefined();
		expect(subject.settled).toBe(false);
	});

	// Travel below the threshold is held, not discarded: a slow scroll would otherwise
	// lose its first pixels and start with a visible jump.
	test("crossing the threshold applies everything the finger travelled", () => {
		const subject = press();

		expect(subject.translate(6, 0)).toBeUndefined();
		expect(subject.translate(6, 0)).toBeUndefined();
		expect(subject.translate(6, 0)).toEqual({
			deltaX: -18,
			deltaY: -0,
			startedPanning: true
		});
	});

	// Neither axis reaches 16 on its own here, but the finger has travelled 17 - a
	// per-axis threshold would still be waiting while the view had visibly moved.
	test("the threshold is a distance, not a distance along one axis", () => {
		expect(press().translate(12, 12)).toEqual({
			deltaX: -12,
			deltaY: -12,
			startedPanning: true
		});

		// ...and 11 on each axis is only 15.6 of travel, so that one is still a hold.
		expect(press().translate(11, 11)).toBeUndefined();
		expect(press().translate(15, 0)).toBeUndefined();
		expect(press().translate(0, -15)).toBeUndefined();
	});

	test("exactly the threshold is a scroll", () => {
		expect(press().translate(0, PAN_THRESHOLD)?.startedPanning).toBe(true);
	});

	// Only the change that decided it, so the caller disarms the hold timer once.
	test("only one change reports that panning started", () => {
		const subject = press();
		subject.translate(20, 0);

		const next = subject.translate(5, 3);

		expect(next).toEqual({ deltaX: -5, deltaY: -3, startedPanning: false });
	});

	test("a press that scrolled is no longer a tap, a hold, or a menu", () => {
		const subject = press({ startedOnText: true });
		subject.translate(20, 0);

		expect(subject.settled).toBe(true);
		expect(subject.opensHoldMenu).toBe(false);
		expect(touchContextMenu(subject, touchEvent)).toBe("suppress");
	});

	// The hold timer is armed at touchstart and fires 650ms later regardless; whether it
	// still means anything is decided when it fires.
	test("a hold that turned into a scroll opens no menu", () => {
		const subject = press({ startedInSelection: true });
		expect(subject.armsHoldMenu).toBe(true);
		expect(subject.opensHoldMenu).toBe(true);

		subject.translate(0, 40);

		expect(subject.opensHoldMenu).toBe(false);
	});

	test("only a press inside an existing selection arms the hold menu", () => {
		expect(press({ startedInSelection: false }).armsHoldMenu).toBe(false);
		expect(press({ startedInSelection: true }).armsHoldMenu).toBe(true);
	});

	// The native contextmenu arrives ~700ms in, after our own 650ms hold menu already
	// opened. Without this the same press drops a second menu on top of the first.
	test("a press that opened the hold menu refuses everything after it", () => {
		const subject = press({ startedOnText: true, startedInSelection: true });

		subject.openedMenu();

		expect(subject.settled).toBe(true);
		expect(touchContextMenu(subject, touchEvent)).toBe("suppress");
	});

	test("a press still deciding is not settled", () => {
		const subject = press();
		subject.translate(2, 2);

		expect(subject.settled).toBe(false);
	});
});

describe("touch context menu", () => {
	test("a long-press on text selects the word under it", () => {
		expect(touchContextMenu(press({ startedOnText: true }), touchEvent)).toBe(
			"selectWord"
		);
	});

	// A hold on the gutter or past the last line has no word to select, so it keeps the
	// menu a desktop right-click would give.
	test("a long-press off the text opens the menu", () => {
		expect(touchContextMenu(press({ startedOnText: false }), touchEvent)).toBe(
			"menu"
		);
	});

	// A real mouse right-click reaches MouseHandler's own bubbling listener; taking it
	// here would handle it twice.
	test("a mouse right-click is left to the handler that already has it", () => {
		expect(touchContextMenu(null, mouseEvent)).toBe("defer");
		expect(
			touchContextMenu(null, { isTrusted: true, pointerType: "pen" })
		).toBe("defer");
	});

	// Both belong to a finger: a native long-press whose press this handler never saw
	// start, and Gesture's stand-in for hosts that fire no contextmenu at all.
	test.each([
		["a native touch contextmenu", touchEvent],
		["Gesture's synthetic one", syntheticEvent]
	])("%s opens the menu even with no press on record", (_name, event) => {
		expect(touchContextMenu(null, event)).toBe("menu");
	});

	// An untrusted event naming a mouse is still not a mouse event - only the browser
	// can produce one of those, and it would have been trusted.
	test("an untrusted mouse contextmenu is not deferred", () => {
		expect(
			touchContextMenu(null, { isTrusted: false, pointerType: "mouse" })
		).toBe("menu");
	});
});
