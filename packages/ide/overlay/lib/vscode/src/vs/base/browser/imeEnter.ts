/*---------------------------------------------------------------------------------------------
 * Composery: soft-keyboard Enter fallback. Mobile IMEs commit their newline key as a
 * beforeinput line break instead of a usable keydown - while composing, the matching
 * keydown reports keyCode 229 - so every Enter-driven flow desktop reaches through a real
 * keydown (quick input accept, inline rename, suggest accept, chat and REPL submit) is
 * unreachable on touch. Replay such commits as a cancelable synthetic Enter keydown on the
 * editable element: the keybinding service and widget listeners see the usual event, and
 * when one of them handles it the line-break insertion is cancelled, exactly as a handled
 * physical Enter never reaches the text. Exempt: commits already preceded by a trusted
 * Enter keydown (physical and iOS keyboards - every listener had its chance), composition
 * updates, and xterm's helper textarea (the terminal feeds the pty from input itself).
 *
 * The replay also carries whatever the keybar has armed (stickyModifiers.ts). Shift+Enter is
 * the case that forces this: a phone keyboard cannot send it, and the keybar cannot either,
 * because Enter never reaches the keybar - it arrives here as an `insertLineBreak` carrying no
 * data. An armed modifier therefore also lifts the xterm exemption, since sticky Shift is
 * exactly what xterm's own input path will not apply; there we cancel the commit outright
 * rather than reading the dispatch result, because the synthetic keydown replaces it entirely
 * and letting both through would send the terminal two newlines.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, onDidRegisterWindow } from './dom.js';
import { isTouch } from './touchGate.js';
import { stickyModifiers } from './stickyModifiers.js';
import { mainWindow } from './window.js';
import { Event } from '../common/event.js';
import { Disposable } from '../common/lifecycle.js';

// IMEs emit the trusted keydown and its line break back to back; anything older belongs
// to a previous keystroke and the commit needs replaying.
const TRUSTED_ENTER_WINDOW_MS = 250;

export class ImeEnterFallback extends Disposable {

	constructor() {
		super();
		this._register(Event.runAndSubscribe(onDidRegisterWindow, ({ window, disposables }) => {
			let lastTrustedEnter = Number.NEGATIVE_INFINITY;
			disposables.add(addDisposableListener(window, 'keydown', e => {
				if (e.isTrusted && e.keyCode === 13 /* Enter */) {
					lastTrustedEnter = e.timeStamp;
				}
			}, true));
			disposables.add(addDisposableListener(window, 'beforeinput', e => {
				if (!isTouch(window) || !e.isTrusted || e.isComposing) {
					return;
				}
				if (e.inputType !== 'insertLineBreak' && e.inputType !== 'insertParagraph') {
					return;
				}
				if (e.timeStamp - lastTrustedEnter < TRUSTED_ENTER_WINDOW_MS) {
					return;
				}
				const target = e.target;
				if (!(target instanceof HTMLElement)) {
					return;
				}
				const armed = stickyModifiers.any;
				// Without a modifier to apply, the terminal is left to its own input path.
				if (!armed && target.closest('.xterm')) {
					return;
				}
				const keydown = new KeyboardEvent('keydown', {
					key: 'Enter',
					code: 'Enter',
					bubbles: true,
					cancelable: true,
					ctrlKey: stickyModifiers.held('ctrl'),
					altKey: stickyModifiers.held('alt'),
					shiftKey: stickyModifiers.held('shift')
				});
				// The constructor drops legacy fields, but StandardKeyboardEvent maps from them.
				Object.defineProperties(keydown, {
					keyCode: { value: 13 },
					which: { value: 13 }
				});
				const handled = !target.dispatchEvent(keydown);
				if (handled || armed) {
					e.preventDefault();
				}
				if (armed) {
					stickyModifiers.consume();
				}
			}, true));
		}, { window: mainWindow, disposables: this._store }));
	}
}
