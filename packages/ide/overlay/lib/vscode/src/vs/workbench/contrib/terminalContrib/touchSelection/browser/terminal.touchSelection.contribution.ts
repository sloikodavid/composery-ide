/*---------------------------------------------------------------------------------------------
 * Composery: terminal text selection by touch. A mouse selects by dragging across the grid,
 * which a finger cannot do - that same drag scrolls the buffer. So the finger gets the gesture
 * every touch platform uses instead: a hold selects the word underneath, two grips adjust the
 * range, and a hold on the selection opens the terminal's own menu over it (Copy, Paste, Select
 * All). The grips are the shared touch selection handles, the same ones the editor uses.
 *--------------------------------------------------------------------------------------------*/

import type { IBufferRange, Terminal as RawXtermTerminal } from '@xterm/xterm';
import * as dom from '../../../../../base/browser/dom.js';
import { EventType as TouchEventType } from '../../../../../base/browser/touch.js';
import { isTouch } from '../../../../../base/browser/touchGate.js';
import { ITouchSelectionEdge, TouchSelectionEdges, TouchSelectionHandleKind, TouchSelectionHandles } from '../../../../../base/browser/touchSelectionHandles.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ITerminalContribution, IXtermTerminal } from '../../../terminal/browser/terminal.js';
import { ITerminalContributionContext, registerTerminalContribution } from '../../../terminal/browser/terminalExtensions.js';
import { getBufferCellAt, getCellSize, getScreenElement, IBufferCellPoint } from '../../../terminal/browser/xtermCell.js';
import type { IXtermCore } from '../../../terminal/browser/xterm-private.js';

interface IXtermWithCore extends RawXtermTerminal {
	_core: IXtermCore;
}

const MENU_SETTLE_TIME = 1500;

function sameRange(a: IBufferRange | undefined, b: IBufferRange | undefined): boolean {
	return a?.start.x === b?.start.x && a?.start.y === b?.start.y && a?.end.x === b?.end.x && a?.end.y === b?.end.y;
}

class TerminalTouchSelection extends Disposable implements ITerminalContribution {
	static readonly ID = 'terminal.touchSelection';

	private _xterm: RawXtermTerminal | undefined;
	private _handles: TouchSelectionHandles | undefined;
	/** The end of the selection a drag holds still, as an inclusive cell. */
	private _anchor: IBufferCellPoint | undefined;
	private _scrollRest = 0;
	/** The live selection, as last seen. */
	private _lastRange: IBufferRange | undefined;
	/** A selection that vanished on its own, and when - see _onSelectionChange. */
	private _lost: { range: IBufferRange; at: number; cols: number } | undefined;
	/** Set while the clear is ours, so a deliberate one is never undone. */
	private _clearing = false;
	/** Until when a selection with a menu coming up over it is held in place. */
	private _pinnedUntil = 0;

	constructor(_ctx: ITerminalContributionContext) {
		super();
	}

	xtermOpen(xterm: IXtermTerminal & { raw: RawXtermTerminal }): void {
		const element = xterm.raw.element;
		const screen = getScreenElement(xterm.raw);
		if (!element || !screen || !isTouch(dom.getWindow(element))) {
			return;
		}

		this._xterm = xterm.raw;
		const handles = this._handles = this._register(new TouchSelectionHandles({
			viewport: screen,
			getEdges: () => this._getEdges(),
			startDrag: kind => this._startDrag(kind),
			dragTo: (x, y) => this._dragTo(x, y),
			stopDrag: () => {
				this._anchor = undefined;
				this._scrollRest = 0;
			},
			scrollBy: deltaY => this._scrollBy(deltaY)
		}));

		// The hold arrives as a contextmenu event (Gesture re-fires every long-press as one).
		// It is listened for on the screen rather than the pane, so a hold that turns into a
		// word selection can stop the pane from opening its menu over it.
		this._register(dom.addDisposableListener(screen, dom.EventType.CONTEXT_MENU, (event: MouseEvent) => this._onContextMenu(event)));
		// terminalInstance makes the terminal element a Gesture target, so its gesture events
		// are dispatched there and nowhere else.
		this._register(dom.addDisposableListener(element, TouchEventType.Start, () => handles.reveal()));
		this._register(dom.addDisposableListener(element, TouchEventType.Tap, () => this._clearSelection()));
		this._register(xterm.raw.onSelectionChange(() => this._onSelectionChange()));
		this._register(xterm.raw.onResize(({ cols }) => this._restoreLostSelection(cols)));
		// Output, a resize and a buffer scroll all move the cells the grips sit on.
		this._register(xterm.raw.onRender(() => {
			if (xterm.raw.hasSelection()) {
				handles.scheduleUpdate();
			}
		}));
	}

	private _clearSelection(): void {
		this._pinnedUntil = 0;
		this._clearing = true;
		try {
			this._xterm?.clearSelection();
		} finally {
			this._clearing = false;
		}
	}

	// xterm drops the selection on every row-count change (its own fix for a rendering bug),
	// and on a phone the row count changes for reasons that have nothing to do with the
	// buffer: the soft keyboard closing, the keybar undocking, the panel resizing - all of
	// which happen the moment a hold opens the menu over a selection, so Copy found nothing
	// to copy (device-verified). Remember what vanished; the resize that caused it arrives
	// right behind, and buffer rows do not move when the viewport only changes height.
	private _onSelectionChange(): void {
		const range = this._xterm?.getSelectionPosition();
		if (range) {
			this._lastRange = range;
			this._lost = undefined;
		} else {
			// Cleared: ours to forget, or someone else's to undo.
			const lost = this._clearing || !this._lastRange || !this._xterm
				? undefined
				: { range: this._lastRange, at: Date.now(), cols: this._xterm.cols };
			this._lastRange = undefined;
			// While the menu this selection asked for is coming up, put it back at once -
			// whatever took it. Everything a menu does to the page it does within a beat of
			// opening: the keyboard closes, the keybar undocks, the panel relayouts.
			if (lost && Date.now() < this._pinnedUntil) {
				this._restore(lost.range, lost.cols);
				return;
			}
			this._lost = lost;
		}
		this._handles?.scheduleUpdate();
	}

	private _restoreLostSelection(cols: number): void {
		const lost = this._lost;
		this._lost = undefined;
		// Only the resize that immediately follows the clear it caused.
		if (lost && Date.now() - lost.at <= 100) {
			this._restore(lost.range, cols);
		}
	}

	private _restore(range: IBufferRange, cols: number): void {
		const xterm = this._xterm;
		// Same width only: a reflow moves the text itself, so the old range means nothing.
		if (!xterm || xterm.cols !== cols) {
			return;
		}
		const length = (range.end.y - range.start.y) * cols + range.end.x - range.start.x;
		if (length > 0) {
			xterm.select(range.start.x, range.start.y, length);
		}
	}

	private _onContextMenu(event: MouseEvent): void {
		const xterm = this._xterm;
		const handles = this._handles;
		if (!xterm || !handles) {
			return;
		}
		const cell = getBufferCellAt(xterm, event.clientX, event.clientY);
		if (!cell) {
			return;
		}

		const selectionService = (xterm as IXtermWithCore)._core._selectionService;
		if (selectionService.isCellInSelection(cell.x, cell.y)) {
			// A hold on the selection asks what to do with it - that is the pane's menu, and
			// the selection has to still be there when the menu acts on it.
			this._pinnedUntil = Date.now() + MENU_SETTLE_TIME;
			return;
		}

		// xterm's own word selection, so the wordSeparator setting, wide characters and
		// wrapped lines all behave exactly as they do for a desktop right-click. It leaves
		// the model untouched where there is no word, which is how blank space is told
		// apart: nothing to select there, so the menu is what the hold meant.
		const before = xterm.getSelectionPosition();
		selectionService.rightClickSelect(event);
		if (sameRange(before, xterm.getSelectionPosition())) {
			this._clearSelection();
			return;
		}

		this._pinnedUntil = 0;
		handles.reveal();
		event.preventDefault();
		event.stopPropagation();
	}

	private _getEdges(): TouchSelectionEdges | null {
		const position = this._xterm?.getSelectionPosition();
		if (!position) {
			return null;
		}
		return {
			start: this._edgeAt(position.start.x, position.start.y),
			end: this._edgeAt(position.end.x, position.end.y)
		};
	}

	private _edgeAt(column: number, row: number): ITouchSelectionEdge | undefined {
		const xterm = this._xterm;
		const cell = xterm && getCellSize(xterm);
		const screen = xterm && getScreenElement(xterm);
		if (!xterm || !cell || !screen) {
			return undefined;
		}
		const rect = screen.getBoundingClientRect();
		return {
			// A range starts on the left edge of its first cell and ends on the right edge of
			// its last, which is exactly what xterm's inclusive start and exclusive end are.
			x: rect.left + column * cell.width,
			y: rect.top + (row - xterm.buffer.active.viewportY + 1) * cell.height,
			height: cell.height
		};
	}

	private _startDrag(kind: TouchSelectionHandleKind): void {
		const xterm = this._xterm;
		const position = xterm?.getSelectionPosition();
		if (!xterm || !position) {
			return;
		}
		this._anchor = kind === 'end'
			? { x: position.start.x, y: position.start.y }
			: position.end.x > 0
				? { x: position.end.x - 1, y: position.end.y }
				: { x: xterm.cols - 1, y: position.end.y - 1 };
	}

	private _dragTo(clientX: number, clientY: number): TouchSelectionHandleKind | undefined {
		const xterm = this._xterm;
		const anchor = this._anchor;
		const screen = xterm && getScreenElement(xterm);
		if (!xterm || !anchor || !screen) {
			return undefined;
		}
		// The finger may leave the grid sideways; the edge it drags may not.
		const rect = screen.getBoundingClientRect();
		const cell = getBufferCellAt(xterm, Math.min(Math.max(clientX, rect.left), rect.right - 1), clientY);
		if (!cell) {
			return undefined;
		}

		const dragsStart = cell.y < anchor.y || (cell.y === anchor.y && cell.x < anchor.x);
		const from = dragsStart ? cell : anchor;
		const to = dragsStart ? anchor : cell;
		// Both ends are inclusive cells here, so the cell under the finger is always in.
		xterm.select(from.x, from.y, (to.y - from.y) * xterm.cols + to.x - from.x + 1);
		return dragsStart ? 'start' : 'end';
	}

	private _scrollBy(deltaY: number): void {
		const xterm = this._xterm;
		const cell = xterm && getCellSize(xterm);
		if (!xterm || !cell) {
			return;
		}
		// A terminal scrolls by whole lines; carry the remainder so a drag held just inside
		// the edge still creeps rather than standing still.
		this._scrollRest += deltaY / cell.height;
		const lines = Math.trunc(this._scrollRest);
		if (lines === 0) {
			return;
		}
		this._scrollRest -= lines;
		xterm.scrollLines(lines);
	}
}

// Not in detached terminals: the gestures here arrive through the Gesture target that
// terminalInstance registers, which a detached terminal has no owner to give it.
registerTerminalContribution(TerminalTouchSelection.ID, TerminalTouchSelection);
