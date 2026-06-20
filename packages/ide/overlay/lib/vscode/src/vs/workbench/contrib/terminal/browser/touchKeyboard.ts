/*---------------------------------------------------------------------------------------------
 * Composery: the terminal raises the soft keyboard on a tap and on nothing else.
 *
 * Every other surface answers this by deciding when to focus its input. The terminal cannot:
 * xterm keeps its hidden textarea focused for as long as the terminal is the active surface,
 * so the caret stays visible with the keyboard dismissed, and focus() on an already-focused
 * element raises nothing.
 *
 * What raises it in that state is the browser, and nothing the page does can stop it.
 * Device-verified on Android, swiping the focused terminal buffer: our Gesture layer cancels
 * the whole sequence (touchstart, every touchmove and touchend all report
 * defaultPrevented=true), classifies the press as a pan so no Tap is emitted, and calls no
 * focus lever at all - and Chromium raises the keyboard on release anyway. Whether the buffer
 * had anything to scroll made no difference. preventDefault does not reach this decision, so
 * no gesture-level guard can either.
 *
 * inputmode="none" does: while it is set, nothing raises the keyboard for that element. It
 * goes on when a finger lands with the keyboard down, and comes off only for a tap - which
 * then has to cycle focus, because that is the only thing that raises a keyboard over an input
 * which never lost focus (device-verified: focus() alone on the already-focused textarea left
 * the keyboard down, so today a tap cannot bring it back at all). A press that pans, holds or
 * is cancelled leaves the hold on and the keyboard down.
 *
 * Two rules keep the hold from outliving its job:
 *
 *   - Never armed while the keyboard is up: setting inputmode="none" on the focused element
 *     dismisses a visible keyboard, and touching the buffer must not do that.
 *   - Dropped as soon as the terminal loses focus. The hold only ever guards a press on the
 *     focused terminal; carried past a blur it would swallow the keyboard for the next
 *     command-driven focus (device-verified). Nothing is lost by dropping it - an input that
 *     never lost focus cannot be raised by a focus call either.
 *--------------------------------------------------------------------------------------------*/

/** The hidden input a terminal parks its caret in, as much of it as this needs. */
export interface ISoftKeyboardInput {
	setAttribute(name: string, value: string): void;
	removeAttribute(name: string): void;
	blur(): void;
	focus(options?: { preventScroll?: boolean }): void;
}

export class TouchKeyboard {
	/** Whether the browser is currently held off this input. */
	private _held = false;

	private readonly _input: ISoftKeyboardInput;

	constructor(input: ISoftKeyboardInput) {
		this._input = input;
	}

	/**
	 * A finger went down. Nothing this press may still turn into raises the keyboard, so hold
	 * the browser off before it can decide otherwise - the verdict lands at release, and by
	 * then the attribute has to already be set.
	 */
	press(keyboardOpen: boolean): void {
		if (keyboardOpen || this._held) {
			return;
		}
		this._held = true;
		this._input.setAttribute('inputmode', 'none');
	}

	/**
	 * The press was a tap, which is the one gesture that means "type here". Release the hold,
	 * then raise the keyboard the only way an input that never lost focus can.
	 */
	tap(keyboardOpen: boolean): void {
		if (!this._held) {
			return;
		}
		this._held = false;
		this._input.removeAttribute('inputmode');
		if (keyboardOpen) {
			return;
		}
		this._input.blur();
		this._input.focus({ preventScroll: true });
	}

	/** The terminal lost focus. The hold guards a press on it, so it ends with it. */
	release(): void {
		if (!this._held) {
			return;
		}
		this._held = false;
		this._input.removeAttribute('inputmode');
	}
}
