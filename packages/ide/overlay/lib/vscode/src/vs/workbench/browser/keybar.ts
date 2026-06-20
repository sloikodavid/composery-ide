/*---------------------------------------------------------------------------------------------
 * Composery Keybar: the keys a phone's soft keyboard cannot produce - Esc, Tab, arrows,
 * Home/End, PgUp/PgDn, Del, F1-F12 and the Ctrl/Alt/Shift modifiers - docked above the
 * keyboard for the whole workbench, not just the terminal.
 *
 * Visible while the soft keyboard is up, and additionally while a terminal holds focus. The
 * keyboard case needs no per-surface judgement: layout.ts computes the keyboard overlap to fit
 * the workbench above it (touch.diff) and pushes the verdict here, which reserves `height` out
 * of the grid - opening the command palette focuses its input, which raises the keyboard, which
 * brings the arrows that let you move the active item without accepting it (quick pick previews
 * on onDidChangeActive, commits on accept - a tap can only ever do the latter, so on touch that
 * preview is otherwise unreachable).
 *
 * The terminal is the one surface where these keys earn their space with no keyboard up: a
 * pager, htop, a menu-driven TUI, ^C and shell-history arrows are all driven by keys the soft
 * keyboard cannot make, and xterm keeps its hidden textarea focused so a synthetic key still
 * lands there. So the bar also docks whenever the focused element sits inside an .xterm,
 * keyboard or not, and layout() reclaims the rows again when focus leaves. Nothing is reserved
 * otherwise.
 *
 * Every key is delivered the same way: a synthetic KeyboardEvent dispatched at whatever is
 * focused, exactly as ImeEnterFallback replays soft-keyboard Enter (imeEnter.ts). That is
 * one backend for the entire IDE. xterm binds keydown on its textarea, reads ctrlKey/altKey/
 * shiftKey, owns applicationCursorKeysMode, and never checks isTrusted, so the terminal gets
 * correct escape sequences - including DECCKM and modifier encoding - without this file
 * knowing a single escape sequence, and without importing ITerminalService into
 * vs/workbench/browser (which the layering rules forbid).
 *
 * Keys never take focus: the synthetic event is aimed at the already-focused element, so
 * tapping the bar neither moves focus nor dismisses the keyboard that summoned it.
 *
 * The sticky Ctrl/Alt/Shift live in stickyModifiers.ts rather than here, because one armed
 * modifier has to reach a keystroke this file never sees: the soft keyboard's Enter arrives
 * as a data-less `insertLineBreak` that ImeEnterFallback replays, which is what makes
 * Shift+Enter work at all.
 *--------------------------------------------------------------------------------------------*/

import './media/keybar.css';
import * as dom from '../../base/browser/dom.js';
import { EventType as TouchEventType, Gesture } from '../../base/browser/touch.js';
import { Disposable, DisposableStore } from '../../base/common/lifecycle.js';
import { Emitter } from '../../base/common/event.js';
import { isTouch } from '../../base/browser/touchGate.js';
import { MODIFIERS, Modifier, stickyModifiers } from '../../base/browser/stickyModifiers.js';

const ROW_HEIGHT = 40;
// 3px padding top and bottom, plus the 1px top border.
const CHROME = 7;
const ROW_GAP = 2;
const KEYBAR_HEIGHT = 2 * ROW_HEIGHT + ROW_GAP + CHROME;
const COMPACT_HEIGHT = ROW_HEIGHT + CHROME;
// Landscape with the keyboard up can leave the workbench with very little - it is why
// touch.diff steals the footer's row back - and two rows of keys over a
// couple of visible terminal lines is worse than one row. Collapse so the bar never eats
// more than about a third of what the user can actually see. A phone in portrait with
// the keyboard up clears this comfortably; the same phone in landscape does not.
const COMPACT_BELOW = KEYBAR_HEIGHT * 3;

interface KeyDef {
	// Text label or codicon id - exactly one is set.
	readonly label?: string;
	readonly icon?: string;
	readonly title: string;
	readonly key: string;
	// DOM `code`; defaults to `key`, which is correct for every non-character key.
	readonly code?: string;
	readonly keyCode: number;
	// Modifiers this key carries in addition to whatever is sticky.
	readonly mods?: readonly Modifier[];
	// 'fn' toggles the function-key layer instead of sending anything.
	readonly action?: 'fn' | Modifier;
}

const ESC: KeyDef = { label: 'Esc', title: 'Escape', key: 'Escape', keyCode: 27 };
const TAB: KeyDef = { label: 'Tab', title: 'Tab', key: 'Tab', keyCode: 9 };
const DEL: KeyDef = { label: 'Del', title: 'Delete', key: 'Delete', keyCode: 46 };
const FN: KeyDef = { label: 'Fn', title: 'Function keys', key: '', keyCode: 0, action: 'fn' };
const CTRL: KeyDef = { label: 'Ctrl', title: 'Sticky Ctrl (double-tap to lock)', key: '', keyCode: 0, action: 'ctrl' };
const ALT: KeyDef = { label: 'Alt', title: 'Sticky Alt (double-tap to lock)', key: '', keyCode: 0, action: 'alt' };
const SHIFT: KeyDef = { label: 'Shift', title: 'Sticky Shift (double-tap to lock)', key: '', keyCode: 0, action: 'shift' };

// Icons only where a glyph beats the word - the four arrows. There is no widely understood
// icon for Home/End/PgUp/PgDn (codicon's house means "home page", its folds mean code
// folding), so those stay text, exactly as they are in Termux.
const LEFT: KeyDef = { icon: 'arrow-left', title: 'Left', key: 'ArrowLeft', keyCode: 37 };
const DOWN: KeyDef = { icon: 'arrow-down', title: 'Down', key: 'ArrowDown', keyCode: 40 };
const UP: KeyDef = { icon: 'arrow-up', title: 'Up', key: 'ArrowUp', keyCode: 38 };
const RIGHT: KeyDef = { icon: 'arrow-right', title: 'Right', key: 'ArrowRight', keyCode: 39 };
const HOME: KeyDef = { label: 'Home', title: 'Home', key: 'Home', keyCode: 36 };
const END: KeyDef = { label: 'End', title: 'End', key: 'End', keyCode: 35 };
const PAGE_UP: KeyDef = { label: 'PgUp', title: 'Page up', key: 'PageUp', keyCode: 33 };
const PAGE_DOWN: KeyDef = { label: 'PgDn', title: 'Page down', key: 'PageDown', keyCode: 34 };

// Ctrl+C is reachable as sticky Ctrl then C, so by the "only what is otherwise impossible"
// rule it does not earn a slot. It gets one anyway because dropping it buys nothing: the
// navigation block is 4 columns (Home/Up/End/PgUp over Left/Down/Right/PgDn), which leaves
// 8 slots beside it for Esc, Tab, Del, Fn, Ctrl, Alt and Shift - seven keys and one spare.
// Going to 7 columns instead would leave 6 slots for those seven, costing Fn and with it
// F1-F12, which htop and midnight commander need and nothing else reaches. So this fills a
// cell that would otherwise be blank rather than displacing anything.
const INTERRUPT: KeyDef = { label: '^C', title: 'Ctrl+C (interrupt)', key: 'c', code: 'KeyC', keyCode: 67, mods: ['ctrl'] };

const BASE_ROWS: readonly (readonly KeyDef[])[] = [
	[ESC, TAB, INTERRUPT, DEL, HOME, UP, END, PAGE_UP],
	[FN, CTRL, ALT, SHIFT, LEFT, DOWN, RIGHT, PAGE_DOWN]
];

// One row for a viewport too short to spend two on: the keys with no other route in at all,
// with the arrows flattened to the conventional single-row order the inverted-T collapses to.
// Shift, Del, Home/End, PgUp/PgDn and the Fn layer come back when there is room - Up is kept
// over Shift here because shell history is the thing a cramped terminal needs most.
const COMPACT_ROWS: readonly (readonly KeyDef[])[] = [
	[ESC, TAB, CTRL, ALT, LEFT, DOWN, UP, RIGHT]
];

function fnKey(n: number): KeyDef {
	return { label: `F${n}`, title: `F${n}`, key: `F${n}`, keyCode: 111 + n };
}

// Fn is a layer on the bar itself, not an Fn+digit chord: Gboard hides digits behind its
// symbol layer, so a chord would cost a trip through a keyboard we do not control.
const FN_ROWS: readonly (readonly KeyDef[])[] = [
	[1, 2, 3, 4, 5, 6, 7, 8].map(fnKey),
	[FN, ...[9, 10, 11, 12].map(fnKey), ESC, TAB, INTERRUPT]
];

export class Keybar extends Disposable {

	private readonly modifierElements = new Map<Modifier, HTMLElement[]>();
	// render() runs on every keyboard show/hide, compact switch and Fn toggle, so the keys'
	// listeners cannot go on the object's own store - that would pin a fresh set of detached
	// nodes on each pass and never release one.
	private readonly keyDisposables = this._register(new DisposableStore());
	private readonly bar: HTMLElement | undefined;

	private fnLayer = false;
	private keyboardVisible = false;
	private compact = false;
	private terminalFocused = false;

	// Terminal focus flips visibility between layout passes; layout() subscribes to reclaim
	// or give back the reserved rows when it does.
	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	readonly onDidChangeHeight = this._onDidChangeHeight.event;

	constructor(container: HTMLElement) {
		super();

		// Touch is a device property, not a runtime state - a non-touch window builds nothing.
		if (!isTouch(dom.getWindow(container))) {
			return;
		}

		this.bar = dom.append(container, dom.$('.composery-keybar'));
		this.bar.style.height = `${KEYBAR_HEIGHT}px`;
		this.bar.style.display = 'none';
		this.render();

		// A mouse press on the bar must not pull focus off the target (touch cannot: Gesture
		// preventDefaults touchstart inside its targets).
		this._register(dom.addDisposableListener(this.bar, 'mousedown', e => e.preventDefault()));
		// Sticky modifiers have to survive the soft keyboard, which reports keyCode 229 on
		// Android and only commits through beforeinput. Cancel the commit and replay it as a
		// modified keydown so it takes the same path every other key here takes.
		this._register(dom.addDisposableListener(container.ownerDocument, 'beforeinput', e => this.onBeforeInput(e as InputEvent), true));
		// ImeEnterFallback clears one-shots too, for the Enter the keybar never sees.
		this._register(stickyModifiers.onDidChange(() => this.updateModifiers()));
		// The bar also docks while a terminal holds focus (see the header): track focus moving
		// in and out of any .xterm. focusout leaves activeElement on <body> only until the next
		// focusin lands, and updateTerminalFocus is a no-op when the verdict is unchanged, so
		// reading it synchronously on both events settles on the right answer without a flicker.
		this._register(dom.addDisposableListener(container.ownerDocument, 'focusin', () => this.updateTerminalFocus()));
		this._register(dom.addDisposableListener(container.ownerDocument, 'focusout', () => this.updateTerminalFocus()));
	}

	// The height the workbench grid must give up: zero unless the bar is showing - a soft
	// keyboard is up, or a terminal holds focus.
	//
	// The gate is the touch capability, so an iPad and a Windows touch laptop are covered
	// alike. On a machine that also has a hardware keyboard the terminal rule spends a row
	// on keys that machine can already type - accepted rather than guessed around, because
	// nothing distinguishes "has a hardware keyboard" from "does not", and a device list
	// that is right about laptops is wrong about the next form factor.
	get height(): number {
		if (!this.visible) {
			return 0;
		}
		return this.compact ? COMPACT_HEIGHT : KEYBAR_HEIGHT;
	}

	// The bar earns grid space while the keyboard is up or a terminal holds focus.
	private get visible(): boolean {
		return !!this.bar && (this.keyboardVisible || this.terminalFocused);
	}

	// Driven from layout(), the one place that knows the keyboard is up and how much of the
	// window survives it.
	setViewport(keyboardVisible: boolean, visibleHeight: number): void {
		if (!this.bar) {
			return;
		}
		const compact = visibleHeight < COMPACT_BELOW;
		if (this.keyboardVisible === keyboardVisible && this.compact === compact) {
			return;
		}
		const compactChanged = this.compact !== compact;
		this.keyboardVisible = keyboardVisible;
		this.compact = compact;
		// setViewport is only ever called from within layout(), which reads height() straight
		// after - it never needs to ask for a relayout, so this path leaves onDidChangeHeight
		// alone (firing it back into layout() would re-enter the pass).
		this.apply(compactChanged);
	}

	// Focus moving in or out of a terminal can flip the bar's visibility with no layout event
	// of its own - a dismissed keyboard does relayout, but tapping from the terminal across to
	// the editor does not - so this re-applies and, when the reserved height actually changed,
	// asks layout() to reclaim or give back the grid rows.
	private updateTerminalFocus(): void {
		if (!this.bar) {
			return;
		}
		const active = this.bar.ownerDocument.activeElement;
		// A menu or a quick input taking focus is not the terminal losing it - the surface
		// whose keys the bar carries is still underneath, waiting. Undocking here would
		// resize the grid, and xterm drops its selection on any row-count change: a
		// long-press selection died the moment the menu it was made for opened over it,
		// so Copy found nothing to copy (device-verified).
		if (active instanceof Element && active.closest('.context-view, .quick-input-widget')) {
			return;
		}
		const focused = active instanceof Element && !!active.closest('.xterm');
		if (focused === this.terminalFocused) {
			return;
		}
		const before = this.height;
		this.terminalFocused = focused;
		this.apply(false);
		if (this.height !== before) {
			this._onDidChangeHeight.fire();
		}
	}

	private apply(compactChanged: boolean): void {
		if (!this.bar) {
			return;
		}
		const visible = this.visible;
		this.bar.style.display = visible ? '' : 'none';
		this.bar.style.height = `${this.compact ? COMPACT_HEIGHT : KEYBAR_HEIGHT}px`;
		if (!visible) {
			// A bar nobody can see ends the chord that armed the modifiers.
			stickyModifiers.reset();
		}
		// Compact carries no Fn key, so it must never inherit a layer with no way back out.
		// An armed modifier does survive the switch - the row it lives on is in both layouts.
		if (!visible || this.compact) {
			this.fnLayer = false;
		}
		if (!visible || compactChanged) {
			this.render();
		}
	}

	private render(): void {
		if (!this.bar) {
			return;
		}
		this.keyDisposables.clear();
		dom.clearNode(this.bar);
		this.modifierElements.clear();
		// Compact has no Fn key, so it must not inherit a layer there is no way back out of.
		const rows = this.compact ? COMPACT_ROWS : this.fnLayer ? FN_ROWS : BASE_ROWS;
		for (const row of rows) {
			const rowElement = dom.append(this.bar, dom.$('.composery-keybar-row'));
			for (const key of row) {
				this.addKey(rowElement, key);
			}
		}
		this.updateModifiers();
	}

	private addKey(row: HTMLElement, key: KeyDef): void {
		const button = dom.append(row, dom.$('.composery-keybar-key'));
		if (key.icon) {
			dom.append(button, dom.$(`span.codicon.codicon-${key.icon}`));
		} else {
			button.textContent = key.label ?? '';
		}
		button.title = key.title;
		button.setAttribute('role', 'button');
		button.setAttribute('aria-label', key.title);
		if (key.action && key.action !== 'fn') {
			const existing = this.modifierElements.get(key.action) ?? [];
			existing.push(button);
			this.modifierElements.set(key.action, existing);
		}
		const run = () => this.press(key);
		// The workbench is littered with Gesture targets whose touchstart preventDefault
		// suppresses the synthesized click, so take the Tap event too - as the upstream
		// action bar does (actionViewItems.ts). Plain click is kept for mouse.
		this.keyDisposables.add(Gesture.addTarget(button));
		this.keyDisposables.add(dom.addDisposableListener(button, TouchEventType.Tap, run));
		this.keyDisposables.add(dom.addDisposableListener(button, 'click', run));
	}

	private press(key: KeyDef): void {
		if (key.action === 'fn') {
			this.fnLayer = !this.fnLayer;
			this.render();
			return;
		}
		if (key.action) {
			stickyModifiers.tap(key.action);
			return;
		}
		this.dispatch(key.key, key.code ?? key.key, key.keyCode, key.mods);
		stickyModifiers.consume();
	}

	private dispatch(key: string, code: string, keyCode: number, extra?: readonly Modifier[]): void {
		const target = dom.getActiveElement();
		if (!target) {
			return;
		}
		const held = (id: Modifier) => stickyModifiers.held(id) || !!extra?.includes(id);
		const event = new KeyboardEvent('keydown', {
			key,
			code,
			bubbles: true,
			cancelable: true,
			ctrlKey: held('ctrl'),
			altKey: held('alt'),
			shiftKey: held('shift')
		});
		// The constructor drops the legacy fields, but StandardKeyboardEvent and xterm both
		// map from them.
		Object.defineProperties(event, {
			keyCode: { value: keyCode },
			which: { value: keyCode }
		});
		target.dispatchEvent(event);
	}

	private updateModifiers(): void {
		for (const id of MODIFIERS) {
			const state = stickyModifiers.state(id);
			for (const element of this.modifierElements.get(id) ?? []) {
				element.classList.toggle('checked', state !== 'off');
				element.classList.toggle('locked', state === 'locked');
			}
		}
	}

	private onBeforeInput(event: InputEvent): void {
		// Enter arrives with no data and is ImeEnterFallback's to replay, modifiers and all.
		if (!stickyModifiers.any) {
			return;
		}
		const data = event.data;
		if (!data || data.length !== 1) {
			return;
		}
		event.preventDefault();
		const upper = data.toUpperCase();
		this.dispatch(data, `Key${upper}`, upper.charCodeAt(0));
		stickyModifiers.consume();
	}
}
