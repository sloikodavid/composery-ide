/*---------------------------------------------------------------------------------------------
 * Composery: what one finger on the editor turns out to have meant.
 *
 * A press is ambiguous while it lasts. The same finger going down can end as a tap that moves
 * the cursor, a scroll, a long-press that selects the word under it, or - when it lands inside
 * an existing selection - a hold that opens the menu for that selection. Nothing decides which
 * until the finger has moved far enough, waited long enough, or lifted, and each of those
 * outcomes has to lock the others out: a press that scrolled must not also tap, and a press
 * that opened the menu must not also drop a second menu when the browser's own contextmenu
 * arrives 700ms in.
 *
 * The classification is here so it can be run by a test. Everything that touches the editor -
 * hit-testing the target, scrolling, arming the DOM timer, opening menus - stays at the call
 * site in pointerHandler, which asks this what the press means and does it.
 *--------------------------------------------------------------------------------------------*/

/**
 * How long a finger must rest inside an existing selection before the menu for it opens. Ahead
 * of Gesture's own 700ms long-press, which is what selects a word when the press landed
 * somewhere else - the two are alternatives, so this one has to win its case first.
 */
export const TOUCH_SELECTION_MENU_HOLD_TIME = 650;

/** What the press landed on, decided once at touchstart. */
export interface ITouchPressStart {
	/** The finger went down on rendered text, rather than a gutter or past the last line. */
	readonly startedOnText: boolean;
	/** ...and inside a selection that already existed, which is what arms the hold menu. */
	readonly startedInSelection: boolean;
}

/** How far the view should scroll, in the direction the content moves. */
export interface ITouchPan {
	readonly deltaX: number;
	readonly deltaY: number;
	/** True on the change that decided this press is a scroll, and only that one. */
	readonly startedPanning: boolean;
}

/**
 * What to do with a contextmenu event.
 *
 * `defer` is the mouse's: it belongs to MouseHandler's ordinary bubbling path and this one
 * never sees it. The rest are a finger's - `selectWord` is the long-press on text that a
 * native textarea would also answer with a word, `menu` is everywhere else, and `suppress`
 * is a press that has already been something.
 */
export type TouchContextMenu = 'defer' | 'menu' | 'selectWord' | 'suppress';

export class TouchPress {
	private _panned = false;
	private _menuOpened = false;
	private _totalX = 0;
	private _totalY = 0;

	/**
	 * `panThreshold` is passed in rather than imported so this module stays free of the editor
	 * bundle - and it must be the one Gesture classifies its own pans by, or the same finger is
	 * a scroll to one of them and a hold to the other.
	 */
	private readonly _start: ITouchPressStart;
	private readonly _panThreshold: number;

	constructor(start: ITouchPressStart, panThreshold: number) {
		this._start = start;
		this._panThreshold = panThreshold;
	}

	/** Whether this press should arm the hold-menu timer at all. */
	get armsHoldMenu(): boolean {
		return this._start.startedInSelection;
	}

	get startedOnText(): boolean {
		return this._start.startedOnText;
	}

	/**
	 * Whether this press has already been something. A tap, a hold menu and a word select are
	 * each other's alternatives, so the first one to happen is the only one that may.
	 */
	get settled(): boolean {
		return this._panned || this._menuOpened;
	}

	/**
	 * The scroll this change asks for, or nothing while the press is still deciding.
	 *
	 * Below the threshold a finger is holding still, not scrolling, and jitter must not move
	 * the view out from under a hold. The travel is not discarded though - the change that
	 * crosses the threshold applies everything accumulated at once, so a scroll that starts
	 * slowly does not lose its first few pixels.
	 */
	translate(translationX: number, translationY: number): ITouchPan | undefined {
		if (this._panned) {
			return { deltaX: -translationX, deltaY: -translationY, startedPanning: false };
		}

		this._totalX += translationX;
		this._totalY += translationY;
		if (Math.hypot(this._totalX, this._totalY) < this._panThreshold) {
			return undefined;
		}

		this._panned = true;
		return { deltaX: -this._totalX, deltaY: -this._totalY, startedPanning: true };
	}

	/** Whether the hold timer, having fired, should still open its menu. */
	get opensHoldMenu(): boolean {
		return !this._panned;
	}

	/** Record that this press opened a menu, so nothing else may. */
	openedMenu(): void {
		this._menuOpened = true;
	}
}

/**
 * A contextmenu arrives from three places and only the last two are ours: a real mouse, the
 * browser's native long-press, and Gesture's untrusted fallback for hosts that fire none. A
 * press this handler never saw start is one of the first two, told apart by the event itself.
 */
export function touchContextMenu(
	press: TouchPress | null,
	event: { readonly isTrusted: boolean; readonly pointerType?: string | undefined }
): TouchContextMenu {
	if (!press) {
		return event.isTrusted && event.pointerType !== 'touch' ? 'defer' : 'menu';
	}
	if (press.settled) {
		return 'suppress';
	}
	return press.startedOnText ? 'selectWord' : 'menu';
}
