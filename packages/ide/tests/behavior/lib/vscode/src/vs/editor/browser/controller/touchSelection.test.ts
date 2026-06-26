import { describe, expect, test } from "vitest";

import {
	type ITouchPosition,
	type ITouchSelection,
	type ITouchSelectionEdge,
	touchDragAnchor,
	touchDragHandle,
	touchSelectionEdge,
	touchSelectionEdges
} from "../../../../../../../../../overlay/lib/vscode/src/vs/editor/browser/controller/touchSelection.ts";

const at = (lineNumber: number, column: number): ITouchPosition => ({
	lineNumber,
	column
});

// The editor's own Selection, as far as this is concerned.
const selection = (
	start: ITouchPosition,
	end: ITouchPosition = start
): ITouchSelection => ({
	isEmpty: () =>
		start.lineNumber === end.lineNumber && start.column === end.column,
	getPosition: () => end,
	getStartPosition: () => start,
	getEndPosition: () => end
});

describe("touch selection edge", () => {
	// The grip hangs below its line, so the tip belongs at the line's bottom - hence the
	// height added to the top rather than subtracted, or the handle would cover the text
	// it is meant to point at.
	test("the tip sits at the bottom of the line, in client coordinates", () => {
		expect(
			touchSelectionEdge(
				{ left: 40, height: 18, verticalOffset: 90, bigNumbersDelta: 0 },
				{ left: 100, top: 200 }
			)
		).toEqual({ x: 140, y: 308, height: 18 });
	});

	// The lines node is translated by the scroll, so its own rect already carries it.
	// Adding the scroll again here would send the handles off with double the movement.
	test("the lines rect is what carries the scroll", () => {
		const line = {
			left: 0,
			height: 20,
			verticalOffset: 500,
			bigNumbersDelta: 0
		};

		const atTop = touchSelectionEdge(line, { left: 0, top: 0 });
		const scrolledUp = touchSelectionEdge(line, { left: 0, top: -300 });

		expect(scrolledUp.y).toBe(atTop.y - 300);
	});

	// The view layout rebases vertical offsets once a document is tall enough for the
	// numbers to lose precision. Ignoring the delta puts every handle a whole viewport
	// away, but only in files long enough that nobody hits it while developing.
	test("the layout's rebasing term is taken back off", () => {
		expect(
			touchSelectionEdge(
				{
					left: 0,
					height: 20,
					verticalOffset: 1_000_020,
					bigNumbersDelta: 1_000_000
				},
				{ left: 0, top: 0 }
			)
		).toEqual({ x: 0, y: 40, height: 20 });
	});
});

describe("touch selection edges", () => {
	const edgeAt = (position: ITouchPosition): ITouchSelectionEdge => ({
		x: position.column,
		y: position.lineNumber,
		height: 10
	});

	test("a collapsed selection carries one grip", () => {
		expect(touchSelectionEdges(selection(at(3, 7)), edgeAt)).toEqual({
			caret: { x: 7, y: 3, height: 10 }
		});
	});

	test("a range carries a grip at each end", () => {
		expect(touchSelectionEdges(selection(at(2, 1), at(4, 9)), edgeAt)).toEqual({
			start: { x: 1, y: 2, height: 10 },
			end: { x: 9, y: 4, height: 10 }
		});
	});

	// Half a selection scrolled off screen still has the half that is on it, and that
	// handle has to keep working - answering null for the pair would drop both.
	test("an edge with nowhere to sit is simply absent", () => {
		const edges = touchSelectionEdges(
			selection(at(2, 1), at(4, 9)),
			(position) => (position.lineNumber === 2 ? undefined : edgeAt(position))
		);

		expect(edges).toEqual({
			start: undefined,
			end: { x: 9, y: 4, height: 10 }
		});
	});

	// No selection to carry handles: the caller passes null when the cursor is not a
	// touch cursor or the editor does not have focus.
	test("nothing to hold means no handles at all", () => {
		expect(touchSelectionEdges(null, edgeAt)).toBeNull();
	});
});

describe("touch drag", () => {
	// Model coordinates, so the anchor survives the auto-scroll a drag to the edge causes.
	test("dragging one end holds the other still", () => {
		const range = selection(at(2, 4), at(6, 8));

		expect(touchDragAnchor("start", range)).toEqual(at(6, 8));
		expect(touchDragAnchor("end", range)).toEqual(at(2, 4));
	});

	test("a caret has no anchor, because both of its ends move together", () => {
		expect(touchDragAnchor("caret", selection(at(2, 4)))).toBeNull();
		expect(touchDragAnchor("start", null)).toBeNull();
	});

	// Drag one grip past the other and they swap. Without this the grips end up pointing
	// away from the selection and the next drag moves the wrong end.
	test("passing the anchor swaps which end the finger holds", () => {
		const anchor = at(5, 10);

		expect(touchDragHandle(anchor, at(2, 1))).toBe("start");
		expect(touchDragHandle(anchor, at(9, 1))).toBe("end");
		expect(touchDragHandle(anchor, at(5, 3))).toBe("start");
		expect(touchDragHandle(anchor, at(5, 30))).toBe("end");
	});

	// Document order is line then column: column 80 of line 2 comes before column 1 of
	// line 3, which comparing columns first would get backwards.
	test("the line decides before the column does", () => {
		expect(touchDragHandle(at(3, 1), at(2, 80))).toBe("start");
		expect(touchDragHandle(at(2, 80), at(3, 1))).toBe("end");
	});

	// Collapsing onto the anchor is not yet past it, so the handle keeps its side rather
	// than flickering to the other one at the moment the selection empties.
	test("landing exactly on the anchor stays the start", () => {
		expect(touchDragHandle(at(4, 4), at(4, 4))).toBe("start");
	});

	test("a caret drag stays a caret wherever it goes", () => {
		expect(touchDragHandle(null, at(9, 9))).toBe("caret");
	});
});
