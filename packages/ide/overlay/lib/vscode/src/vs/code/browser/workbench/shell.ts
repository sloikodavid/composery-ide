/*---------------------------------------------------------------------------------------------
 * Composery: the shared imperative shell for small and touch surfaces - the runtime half of
 * both narrow.css and touch.css. One MutationObserver + rAF loop drives every DOM-reactive
 * behaviour here; each one gates on its OWN capability, not on a device bucket:
 *   - viewport height + soft-keyboard open verdict: geometry / keyboard axis (computed always)
 *   - back-guard overlays: narrow viewport OR coarse pointer (a rotated phone past the breakpoint still uses Back)
 *   - narrow-fullscreen part detection + modal editor: narrow viewport
 *   - keybindings / split-view finger-pan and kept-visible scrollbars: touch pointer
 *
 * A bundled entry point of its own (buildfile.ts, build/next/index.ts), loaded by workbench.html
 * before the workbench entry - so it imports the two canonical gates rather than restating their
 * queries. The stylesheets still mirror them, because CSS cannot import a constant; the gate
 * mirror test pins those.
 *--------------------------------------------------------------------------------------------*/

import { TOUCH_QUERY } from '../../../base/browser/touchGate.js';
import { NARROW_QUERY } from '../../../workbench/browser/narrowGate.js';

const narrow = window.matchMedia(NARROW_QUERY);
const coarsePointer = window.matchMedia('(pointer: coarse)');
const touchLike = window.matchMedia(TOUCH_QUERY);
let pending = false;

//#region Viewport geometry, back-guard and modal editor (narrow viewport + keyboard axis)

// Stands in for the open full-screen part the way an element stands in for an
// overlay, so both kinds of layer move through the same dismissal bookkeeping.
const PART = 'part';
type BackTarget = Element | typeof PART;

// Our sentinel history entry is the current one.
let backGuardArmed = false;
// history.back() calls WE issued to retire a sentinel. Counted, not a flag: a
// layer can reopen while one is still in flight, and the resulting popstate
// must be recognised as ours and then re-armed, or the guard is left believing
// in a sentinel that is no longer there and the next back leaves the page.
let pendingBackGuardDisarms = 0;
// The layer we last asked to close, and one that refused to (see dismissTopLayer).
let dismissing: { target: BackTarget; at: number } | undefined;
let undismissable: BackTarget | undefined;
const modalEditorNarrowAttribute = 'data-composery-narrow-maximized';
const modalEditorMaximizePendingAttribute = 'data-composery-narrow-maximize-pending';
// Mirrors (cannot import) the listener in narrow.diff; keep in sync.
const narrowClosePartEvent = 'composery-narrow-close-part';
// Mirror of layout.ts part-hidden workbench classes; their absence means the part is open.
const partHiddenClasses = ['nosidebar', 'nopanel', 'noauxiliarybar'];

// The layers a back gesture peels, top first. Every entry must be something the
// user opened and that an Escape actually closes - back is a dismissal, not a
// wildcard "close whatever is on screen".
//
// Deliberately absent:
// - .notification-toast-container: a toast arrives unasked and expires on its
//   own. Listing it spent the user's back press on a banner they were not
//   interacting with, leaving the part they meant to close open.
// - .editor-widget: the class every editor widget shares, so it matched
//   whatever upstream adds next, dismissable or not - and a back press absorbed
//   by a widget that does NOT close on Escape reads as a dead press. The
//   dismissable editor widgets we mean are named individually below instead.
const overlaySelectors = [
	'.monaco-menu-container',
	'.action-list-submenu-panel',
	'.quick-input-widget',
	'.monaco-dialog-modal-block',
	'.monaco-dialog-box',
	'.monaco-modal-editor-block',
	'.notifications-center',
	'.context-view',
	'.monaco-hover:not(.hidden)',
	'.suggest-widget',
	'.suggest-details-container',
	'.parameter-hints-widget',
	'.rename-box',
	'.find-widget',
	// The standalone color picker is a content widget over the editor with its
	// own close button and Escape handler, and it renders outside .context-view -
	// so replacing the blanket .editor-widget match with named widgets left it
	// the one dismissable editor popup back could not reach.
	'.standalone-colorpicker',
	// Widgets that open inside the editor and take it over - peek references,
	// test peek, the merge conflict and inline chat widgets. Lower than the
	// popups above, which sit on top of them, and higher than a full-screen part,
	// which sits under the editor holding them.
	'.zone-widget',
];
const modalEditorMaximizeSelector =
	'.monaco-modal-editor-block .modal-editor-action-container .action-label.codicon-screen-full';

// The VirtualKeyboard API is no substitute: both
// navigator.virtualKeyboard.boundingRect and env(keyboard-inset-height) are
// populated only for a page that has set overlaysContent = true and taken over
// keyboard layout itself. We do the opposite - our viewport meta asks the
// browser to resize content - so those two report a structural zero, and
// reading them cost a per-frame forced layout (an env() probe element's
// offsetHeight) for a number that could not change.

// With interactive-widget=resizes-content the keyboard shrinks the LAYOUT viewport too, so
// innerHeight - visualViewport.height reads 0 and the inset above cannot see it. The
// tallest viewport seen at this width is therefore the keyboard-down baseline; anything
// enough shorter than it is the keyboard. The floor keeps browser chrome (the collapsing
// URL bar) from reading as one.
const KEYBOARD_MIN_INSET = 120;
let keyboardBaselineWidth = 0;
let keyboardBaselineHeight = 0;

function keyboardOpen(width: number, height: number): boolean {
	if (width !== keyboardBaselineWidth) {
		keyboardBaselineWidth = width;
		keyboardBaselineHeight = height;
	} else if (height > keyboardBaselineHeight) {
		keyboardBaselineHeight = height;
	}

	return keyboardBaselineHeight - height >= KEYBOARD_MIN_INSET;
}

function updateViewportVars(): void {
	const viewport = window.visualViewport;
	const height = viewport?.height ?? window.innerHeight;
	const width = viewport?.width ?? window.innerWidth;
	const rootStyle = document.documentElement.style;

	rootStyle.setProperty('--composery-viewport-height', `${Math.round(height)}px`);
	// The keyboard verdict for the one shape no geometry in the page can see: both
	// viewports shrinking together. Read by softKeyboard.ts, which the workbench
	// layout fit, the keybar and the editor's tap-to-refocus all go through.
	rootStyle.setProperty(
		'--composery-touch-keyboard-open',
		keyboardOpen(Math.round(width), Math.round(height)) ? '1' : '0',
	);
}

function onScreen(element: BackTarget | undefined): boolean {
	if (!(element instanceof HTMLElement) || !element.isConnected) {
		return false;
	}

	const style = getComputedStyle(element);
	if (style.display === 'none' || style.visibility === 'hidden') {
		return false;
	}

	const rect = element.getBoundingClientRect();
	return rect.width > 0 && rect.height > 0;
}

function activeOverlay(): Element | undefined {
	// A rotated phone can exceed the narrow layout breakpoint while still using
	// Keep transient IDE layers in browser history on coarse-pointer devices at
	// every orientation; full-screen workbench
	// parts below remain narrow-specific.
	if (!narrow.matches && !coarsePointer.matches) {
		return undefined;
	}

	for (const selector of overlaySelectors) {
		for (const element of document.querySelectorAll(selector)) {
			if (element !== undismissable && onScreen(element)) {
				return element;
			}
		}
	}

	return undefined;
}

// A narrow-fullscreen part (side bar / panel / secondary side bar, kept exclusive by
// narrow.diff) counts as a back-dismissible layer too - below every transient
// overlay, so back peels the stack: menu first, then the open part, then the page.
function narrowPartOpen(): boolean {
	if (!narrow.matches) {
		return false;
	}

	const workbench = document.querySelector('.monaco-workbench');
	if (!(workbench instanceof HTMLElement)) {
		return false;
	}

	return partHiddenClasses.some(hiddenClass => !workbench.classList.contains(hiddenClass));
}

// The topmost thing back would close, or undefined when back belongs to the host.
function activeBackTarget(): BackTarget | undefined {
	const overlay = activeOverlay();
	if (overlay) {
		return overlay;
	}

	if (undismissable !== PART && narrowPartOpen()) {
		return PART;
	}

	return undefined;
}

function stillPresent(target: BackTarget): boolean {
	return target === PART ? narrowPartOpen() : onScreen(target);
}

// VS Code reads e.keyCode and nothing else (base/browser/keyboardEvent.ts
// extractKeyCode), and keyCode is a legacy KeyboardEventInit member no engine
// is obliged to honour - where it is dropped the event arrives as keyCode 0,
// resolves to KeyCode.Unknown and matches no keybinding, so every dismissal
// below would silently do nothing. Define it back on when the constructor
// swallowed it, rather than trusting the engine.
function escapeEvent(type: string): KeyboardEvent {
	const event = new KeyboardEvent(type, {
		key: 'Escape',
		code: 'Escape',
		keyCode: 27,
		which: 27,
		bubbles: true,
		cancelable: true,
	});

	if (event.keyCode !== 27) {
		Object.defineProperty(event, 'keyCode', { get: () => 27 });
		Object.defineProperty(event, 'which', { get: () => 27 });
	}

	return event;
}

// Aim the Escape at the focused element when the layer owns focus (the widget's
// own handler expects it there), and at the layer itself otherwise - a menu
// opened by touch often leaves focus behind in the editor, and an Escape
// delivered to the body would be resolved against the body's context keys and
// close nothing.
function dispatchEscape(overlay: Element | undefined): void {
	const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
	const target = active && (!overlay || overlay.contains(active)) ? active : overlay;
	const element = target ?? document.body;

	element.dispatchEvent(escapeEvent('keydown'));
	element.dispatchEvent(escapeEvent('keyup'));
}

// A layer that ignores its Escape must not swallow every later back press: once
// it has had the grace period below, stop counting it as a layer for as long as
// it stays on screen, so the guard disarms and the next back does the thing
// underneath instead of nothing at all.
const DISMISS_GRACE = 500;

// Close the topmost layer. Returns whether there was one - false means back
// belongs to whoever is hosting the page (leave for the instance list in the
// app, leave the page in a browser).
function dismissTopLayer(): boolean {
	const target = activeBackTarget();
	if (!target) {
		dismissing = undefined;
		return false;
	}

	dismissing = { target, at: Date.now() };
	if (target === PART) {
		window.dispatchEvent(new Event(narrowClosePartEvent));
	} else {
		dispatchEscape(target);
	}

	// A layer that refuses to close mutates nothing, so nothing would wake the
	// observer to notice: come back for the verdict ourselves.
	window.setTimeout(schedule, DISMISS_GRACE + 50);
	return true;
}

function reviewDismissal(): void {
	if (undismissable && !stillPresent(undismissable)) {
		undismissable = undefined;
	}

	if (!dismissing) {
		return;
	}

	if (!stillPresent(dismissing.target) || dismissing.target !== activeBackTarget()) {
		dismissing = undefined;
		return;
	}

	if (Date.now() - dismissing.at > DISMISS_GRACE) {
		undismissable = dismissing.target;
		dismissing = undefined;
	}
}

function syncBackGuard(): void {
	reviewDismissal();
	const target = activeBackTarget();

	if (target) {
		if (!backGuardArmed) {
			backGuardArmed = true;
			// A reload (or a restored WebView) keeps session history, so a previous
			// sentinel can already be the current entry - adopt it instead of stacking
			// a second one, or back presses accumulate across reloads.
			if (!history.state?.composeryBackGuard) {
				history.pushState({ composeryBackGuard: true }, '', location.href);
			}
		}
		return;
	}

	if (backGuardArmed) {
		backGuardArmed = false;
		if (history.state?.composeryBackGuard) {
			pendingBackGuardDisarms++;
			history.back();
		}
	}
}

function handleBackGuardPop(): void {
	if (pendingBackGuardDisarms > 0) {
		pendingBackGuardDisarms--;
		backGuardArmed = false;
		// A layer can have opened while our history.back() was in flight, and it
		// would have adopted the sentinel this pop just retired. Re-arm against the
		// history we actually have now.
		syncBackGuard();
		return;
	}

	if (!backGuardArmed) {
		return;
	}

	backGuardArmed = false;
	dismissTopLayer();
	// Re-arm synchronously: this pop retired the sentinel, so until one is back a
	// second browser back reaches real navigation and leaves the page (device-seen
	// 2026-07-21: a back with a menu over an open panel closed the menu, then the
	// next back hit Chrome's "Leave site?" instead of closing the panel). A layer
	// closed by Escape is gone from the DOM by now, so activeBackTarget already
	// reflects the layer beneath it, and syncBackGuard re-plants the sentinel while
	// that layer is still open.
	syncBackGuard();
	// And again once a layer that closes on an animation rather than synchronously
	// has finished, in case the pass above re-armed against one that is now gone.
	window.setTimeout(syncBackGuard, 100);
}

function updateModalEditorNarrowState(): void {
	for (const action of document.querySelectorAll(modalEditorMaximizeSelector)) {
		if (!(action instanceof HTMLElement)) {
			continue;
		}

		const modal = action.closest('.monaco-modal-editor-block');
		if (!(modal instanceof HTMLElement)) {
			continue;
		}

		if (!narrow.matches) {
			modal.removeAttribute(modalEditorNarrowAttribute);
			modal.removeAttribute(modalEditorMaximizePendingAttribute);
			continue;
		}

		const maximized = action.getAttribute('aria-pressed') === 'true';
		if (maximized) {
			modal.setAttribute(modalEditorNarrowAttribute, 'true');
			modal.removeAttribute(modalEditorMaximizePendingAttribute);
			continue;
		}

		if (modal.getAttribute(modalEditorMaximizePendingAttribute) !== 'true') {
			modal.setAttribute(modalEditorMaximizePendingAttribute, 'true');
			modal.setAttribute(modalEditorNarrowAttribute, 'true');
			action.click();
		}
	}
}

function blockNarrowModalEditorRestore(event: Event): void {
	if (!narrow.matches || !(event.target instanceof Element)) {
		return;
	}

	if (event.target.closest('.monaco-modal-editor-block .modal-editor-header')) {
		event.preventDefault();
		event.stopPropagation();
	}
}

//#endregion

//#region Touch scroll affordances (touch pointer, any screen size)

interface IHorizontalPan {
	container: HTMLElement;
	dragging: boolean;
	pointerId: number;
	scrollLeft: number;
	x: number;
	y: number;
}

interface IHorizontalScrollbarDrag {
	container: HTMLElement;
	pointerId: number;
	scrollLeft: number;
	slider: HTMLElement;
	trackWidth: number;
	sliderWidth: number;
	x: number;
}

let horizontalPan: IHorizontalPan | undefined;
let horizontalScrollbarDrag: IHorizontalScrollbarDrag | undefined;

const keybindingsTableContainerSelector = '.keybindings-table-container';
const keybindingsScrollSelector = `.keybindings-editor > .keybindings-body > ${keybindingsTableContainerSelector}`;
const horizontalPanSelectors = [
	'.settings-editor .monaco-split-view2.horizontal > .monaco-scrollable-element > .split-view-container',
	'.profiles-editor > .monaco-split-view2.horizontal > .monaco-scrollable-element > .split-view-container',
	keybindingsScrollSelector,
];

function browserPinchWheel(event: WheelEvent): boolean {
	return event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
}

function releaseBrowserZoomGesture(event: WheelEvent): void {
	if (browserPinchWheel(event)) {
		event.stopPropagation();
	}
}

function maxScrollLeft(container: HTMLElement): number {
	return Math.max(0, container.scrollWidth - container.clientWidth);
}

function setScrollLeft(container: HTMLElement, scrollLeft: number): boolean {
	const nextScrollLeft = Math.max(0, Math.min(maxScrollLeft(container), scrollLeft));

	if (container.scrollLeft !== nextScrollLeft) {
		container.scrollLeft = nextScrollLeft;
		updateKeybindingsScrollbar(container);
		return true;
	}

	return false;
}

function keybindingsScrollContainer(target: EventTarget | null): HTMLElement | undefined {
	if (!(target instanceof Element)) {
		return undefined;
	}

	const container = target.closest(keybindingsScrollSelector);
	return container instanceof HTMLElement ? container : undefined;
}

function ensureKeybindingsScrollbar(container: HTMLElement): HTMLElement | undefined {
	const body = container.parentElement;
	if (!(body instanceof HTMLElement)) {
		return undefined;
	}

	const existing = body.querySelector(':scope > .composery-keybindings-scrollbar');
	if (existing instanceof HTMLElement) {
		return existing;
	}

	const scrollbar = document.createElement('div');
	scrollbar.className = 'composery-keybindings-scrollbar scrollbar horizontal';
	scrollbar.setAttribute('role', 'presentation');
	scrollbar.setAttribute('aria-hidden', 'true');

	const slider = document.createElement('div');
	slider.className = 'slider';
	scrollbar.append(slider);
	body.append(scrollbar);

	return scrollbar;
}

function updateKeybindingsScrollbar(container: HTMLElement): void {
	if (!container.matches(keybindingsScrollSelector)) {
		return;
	}

	const scrollbar = ensureKeybindingsScrollbar(container);
	if (!scrollbar) {
		return;
	}

	const slider = scrollbar.querySelector(':scope > .slider');
	if (!(slider instanceof HTMLElement)) {
		return;
	}

	const maxLeft = maxScrollLeft(container);
	if (maxLeft <= 1 || container.clientWidth <= 0) {
		scrollbar.classList.add('hidden');
		return;
	}

	scrollbar.classList.remove('hidden');
	const trackWidth = container.clientWidth;
	const sliderWidth = Math.max(20, Math.round((trackWidth / container.scrollWidth) * trackWidth));
	const sliderLeft = Math.round((container.scrollLeft / maxLeft) * (trackWidth - sliderWidth));

	slider.style.width = `${sliderWidth}px`;
	slider.style.transform = `translate3d(${sliderLeft}px, 0, 0)`;
}

function updateKeybindingsScrollbars(): void {
	for (const container of document.querySelectorAll(keybindingsScrollSelector)) {
		if (container instanceof HTMLElement) {
			updateKeybindingsScrollbar(container);
		}
	}
}

function handleHorizontalWheel(event: WheelEvent): void {
	if (browserPinchWheel(event)) {
		return;
	}

	const absX = Math.abs(event.deltaX);
	const absY = Math.abs(event.deltaY);
	if (absX <= absY || absX < 1) {
		return;
	}

	const container = keybindingsScrollContainer(event.target);
	if (!container || maxScrollLeft(container) <= 1) {
		return;
	}

	if (setScrollLeft(container, container.scrollLeft + event.deltaX)) {
		event.preventDefault();
		event.stopPropagation();
	}
}

function interactiveTarget(element: Element): boolean {
	return Boolean(
		element.closest(
			[
				'.scrollbar',
				'a',
				'button',
				'input',
				'select',
				'textarea',
				'[contenteditable=\'true\']',
				'[role=\'button\']',
				'[role=\'checkbox\']',
				'[role=\'radio\']',
				'.monaco-button',
				'.action-label',
			].join(','),
		),
	);
}

// Finger-pan of horizontally-overflowing SplitViews is a touch affordance,
// independent of screen size (on a wide screen the container simply does not
// overflow, so this is inert).
function horizontalPanContainer(target: EventTarget | null): HTMLElement | undefined {
	if (!touchLike.matches || !(target instanceof Element)) {
		return undefined;
	}

	if (interactiveTarget(target)) {
		return undefined;
	}

	const selector = horizontalPanSelectors.join(',');
	const container = target.closest(selector);
	if (!(container instanceof HTMLElement)) {
		return undefined;
	}

	if (container.scrollWidth <= container.clientWidth + 1) {
		return undefined;
	}

	return container;
}

function startHorizontalPan(event: PointerEvent): void {
	if (event.pointerType === 'mouse' || event.button !== 0) {
		return;
	}

	const container = horizontalPanContainer(event.target);
	if (!container) {
		return;
	}

	horizontalPan = {
		container,
		dragging: false,
		pointerId: event.pointerId,
		scrollLeft: container.scrollLeft,
		x: event.clientX,
		y: event.clientY,
	};
}

function startHorizontalScrollbarDrag(event: PointerEvent): void {
	if (event.button !== 0 || !(event.target instanceof Element)) {
		return;
	}

	const slider = event.target.closest('.composery-keybindings-scrollbar > .slider');
	if (!(slider instanceof HTMLElement)) {
		return;
	}

	const scrollbar = slider.closest('.composery-keybindings-scrollbar');
	const container = scrollbar?.parentElement?.querySelector(
		`:scope > ${keybindingsTableContainerSelector}`,
	);
	if (!(container instanceof HTMLElement) || !(scrollbar instanceof HTMLElement)) {
		return;
	}

	horizontalScrollbarDrag = {
		container,
		pointerId: event.pointerId,
		scrollLeft: container.scrollLeft,
		slider,
		trackWidth: scrollbar.clientWidth,
		sliderWidth: slider.offsetWidth,
		x: event.clientX,
	};
	slider.classList.add('active');
	event.preventDefault();
	event.stopPropagation();
}

function updateHorizontalPan(event: PointerEvent): void {
	if (!horizontalPan || event.pointerId !== horizontalPan.pointerId) {
		return;
	}

	const deltaX = event.clientX - horizontalPan.x;
	const deltaY = event.clientY - horizontalPan.y;
	const absX = Math.abs(deltaX);
	const absY = Math.abs(deltaY);

	if (!horizontalPan.dragging) {
		if (absY > absX && absY > 8) {
			horizontalPan = undefined;
			return;
		}

		if (absX < 8 || absX <= absY) {
			return;
		}

		horizontalPan.dragging = true;
	}

	const { container } = horizontalPan;
	if (setScrollLeft(container, horizontalPan.scrollLeft - deltaX)) {
		container.dispatchEvent(new Event('scroll'));
	}

	event.preventDefault();
	event.stopPropagation();
}

function updateHorizontalScrollbarDrag(event: PointerEvent): void {
	if (!horizontalScrollbarDrag || event.pointerId !== horizontalScrollbarDrag.pointerId) {
		return;
	}

	const { container, scrollLeft, sliderWidth, trackWidth, x } = horizontalScrollbarDrag;
	const maxLeft = maxScrollLeft(container);
	const maxSliderLeft = Math.max(1, trackWidth - sliderWidth);
	const nextScrollLeft = scrollLeft + ((event.clientX - x) / maxSliderLeft) * maxLeft;

	setScrollLeft(container, nextScrollLeft);
	event.preventDefault();
	event.stopPropagation();
}

function stopHorizontalPan(event: PointerEvent): void {
	if (horizontalPan?.pointerId === event.pointerId) {
		horizontalPan = undefined;
	}
}

function stopHorizontalScrollbarDrag(event: PointerEvent): void {
	if (horizontalScrollbarDrag?.pointerId === event.pointerId) {
		horizontalScrollbarDrag.slider.classList.remove('active');
		horizontalScrollbarDrag = undefined;
	}
}

function handleKeybindingsScroll(event: Event): void {
	if (event.target instanceof HTMLElement) {
		updateKeybindingsScrollbar(event.target);
	}
}

//#endregion

//#region Shared reactive loop

// One rAF-coalesced pass runs every DOM-reactive behaviour above. The fullscreen single-part
// coordination lives natively in the workbench Layout (narrow.diff), not here.
function enforce(): void {
	pending = false;
	updateViewportVars();
	syncBackGuard();
	updateModalEditorNarrowState();
	updateKeybindingsScrollbars();
}

function schedule(): void {
	if (!pending) {
		pending = true;
		window.requestAnimationFrame(enforce);
	}
}

function handleNarrowChange(): void {
	updateViewportVars();
	updateModalEditorNarrowState();
	schedule();
}

// Geometry listeners refresh the viewport vars SYNCHRONOUSLY: this entry point is
// listed before the workbench one in workbench.html, so its listeners run first
// within the same resize event, and the workbench layout fit (touch.diff) reads
// --composery-touch-keyboard-open in its own listener - an async (rAF) update
// would leave it a stale keyboard verdict and wedge the workbench at the
// keyboard-open height after the keyboard closes.
function handleViewportGeometry(): void {
	updateViewportVars();
	schedule();
}

new MutationObserver(schedule).observe(document.documentElement, {
	attributes: true,
	childList: true,
	subtree: true,
});

// Viewport geometry, back-guard and modal editor (narrow viewport + keyboard axis).
document.addEventListener('dblclick', blockNarrowModalEditorRestore, true);
// Re-evaluate viewport vars and the back guard when the app/tab returns to the
// foreground - the OS may have closed the keyboard or resized while backgrounded.
document.addEventListener('visibilitychange', handleViewportGeometry);
window.addEventListener('popstate', handleBackGuardPop);
window.addEventListener('resize', handleViewportGeometry);
window.visualViewport?.addEventListener('resize', handleViewportGeometry);
window.visualViewport?.addEventListener('scroll', handleViewportGeometry);
narrow.addEventListener('change', handleNarrowChange);

// Touch scroll affordances (finger-pan of overflowing views, kept-visible scrollbars).
document.addEventListener('scroll', handleKeybindingsScroll, true);
document.addEventListener('pointerdown', startHorizontalScrollbarDrag, true);
document.addEventListener('pointerdown', startHorizontalPan, true);
document.addEventListener('pointermove', updateHorizontalScrollbarDrag, {
	capture: true,
	passive: false,
});
document.addEventListener('pointermove', updateHorizontalPan, {
	capture: true,
	passive: false,
});
document.addEventListener('pointerup', stopHorizontalScrollbarDrag, true);
document.addEventListener('pointerup', stopHorizontalPan, true);
document.addEventListener('pointercancel', stopHorizontalScrollbarDrag, true);
document.addEventListener('pointercancel', stopHorizontalPan, true);
window.addEventListener('wheel', event => {
	releaseBrowserZoomGesture(event);
	handleHorizontalWheel(event);
}, {
	capture: true,
	passive: false,
});
touchLike.addEventListener('change', schedule);

updateViewportVars();
window.setTimeout(schedule, 500);
window.setTimeout(schedule, 1500);

//#endregion
