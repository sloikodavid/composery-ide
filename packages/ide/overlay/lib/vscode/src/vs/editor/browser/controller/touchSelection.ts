/*---------------------------------------------------------------------------------------------
 * Composery: where the editor's selection edges are, and which one a finger is holding.
 *
 * The handles are drawn by touchSelectionHandles.ts, which knows nothing about text - it asks
 * a host where the edges sit in client coordinates and tells it where a drag has moved one to.
 * This is the editor's half of that conversation, and it is arithmetic and ordering rather
 * than anything the editor has to be running to answer: the call site in pointerHandler reads
 * the view's layout and hands the numbers here.
 *--------------------------------------------------------------------------------------------*/

/** A model or view position; only its ordering and identity matter here. */
export interface ITouchPosition {
	readonly lineNumber: number;
	readonly column: number;
}

/** The part of a selection this needs, satisfied by the editor's own Selection. */
export interface ITouchSelection {
	isEmpty(): boolean;
	getPosition(): ITouchPosition;
	getStartPosition(): ITouchPosition;
	getEndPosition(): ITouchPosition;
}

/** Where one line sits, as the view layout reports it. */
export interface ITouchLineGeometry {
	/** Horizontal offset of the position within the rendered lines. */
	readonly left: number;
	readonly height: number;
	readonly verticalOffset: number;
	/** The view layout's scroll-rebasing term, which the vertical offset is stated against. */
	readonly bigNumbersDelta: number;
}

export interface ITouchSelectionEdge {
	x: number;
	y: number;
	height: number;
}

export type TouchSelectionHandleKind = 'caret' | 'start' | 'end';

/**
 * A selection edge in client coordinates.
 *
 * The tip belongs at the *bottom* of the line, because that is where a grip hangs from - hence
 * the height added to the top. The lines are absolutely positioned and translated by the
 * scroll, so their own rect already carries it: content coordinates plus that rect are client
 * ones, and nothing here needs to know the scroll position.
 */
export function touchSelectionEdge(
	line: ITouchLineGeometry,
	linesRect: { readonly left: number; readonly top: number }
): ITouchSelectionEdge {
	return {
		x: linesRect.left + line.left,
		y: linesRect.top + line.verticalOffset - line.bigNumbersDelta + line.height,
		height: line.height
	};
}

/**
 * The edges a selection carries handles at: one grip for a collapsed cursor, two for a range.
 *
 * An edge scrolled out of the rendered lines has no position to sit at, and `edgeAt` says so by
 * answering nothing - the handle for it is simply absent, which is how a selection that runs
 * off the top of the viewport keeps the handle that is still on screen.
 */
export function touchSelectionEdges(
	selection: ITouchSelection | null,
	edgeAt: (position: ITouchPosition) => ITouchSelectionEdge | undefined
): { [kind in TouchSelectionHandleKind]?: ITouchSelectionEdge | undefined } | null {
	if (!selection) {
		return null;
	}
	return selection.isEmpty()
		? { caret: edgeAt(selection.getPosition()) }
		: {
			start: edgeAt(selection.getStartPosition()),
			end: edgeAt(selection.getEndPosition())
		};
}

/**
 * The end a drag holds still, in model coordinates - they survive scrolling, so a drag can
 * auto-scroll far beyond the rendered lines without losing it. A caret has no anchor: both
 * ends of it move together.
 */
export function touchDragAnchor(
	kind: TouchSelectionHandleKind,
	selection: ITouchSelection | null
): ITouchPosition | null {
	if (!selection || kind === 'caret') {
		return null;
	}
	return kind === 'start' ? selection.getEndPosition() : selection.getStartPosition();
}

/**
 * Which edge the finger is playing now.
 *
 * Dragging one end past the other swaps them, and the grips have to follow or they end up
 * pointing away from the selection they bound. Document order decides it: the dragged end is
 * the start exactly while it is at or before the anchor. (Restated rather than taken from
 * Position.isBeforeOrEqual, which this module cannot import - but line-then-column is the
 * definition of document order, not a value that could drift.)
 */
export function touchDragHandle(
	anchor: ITouchPosition | null,
	position: ITouchPosition
): TouchSelectionHandleKind {
	if (!anchor) {
		return 'caret';
	}
	const beforeOrEqual =
		position.lineNumber < anchor.lineNumber ||
		(position.lineNumber === anchor.lineNumber && position.column <= anchor.column);
	return beforeOrEqual ? 'start' : 'end';
}
