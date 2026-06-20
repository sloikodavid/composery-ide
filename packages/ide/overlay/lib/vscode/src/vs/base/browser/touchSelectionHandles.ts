/*---------------------------------------------------------------------------------------------
 * Composery: the grips a finger adjusts a selection with. The browser draws none of its own
 * here - its selection UI aims at the focused element, and both hosts render their text
 * somewhere other than the element holding the focus: the editor focuses a hidden one-pixel
 * input, the terminal a hidden textarea. So the handles are ours, and there is one mechanism
 * for both (editor pointerHandler, terminal touch selection): everything about the grips -
 * DOM, flipping, grab offset, pointer capture, edge auto-scroll - lives here, and a host only
 * answers where its selection edges are and moves them. Styled by the overlay touch.css.
 *--------------------------------------------------------------------------------------------*/

import * as dom from './dom.js';
import { Disposable } from '../common/lifecycle.js';

/** The grip of a collapsed selection, or either end of a range. */
export type TouchSelectionHandleKind = 'caret' | 'start' | 'end';

/** A selection edge in client coordinates: the tip sits at (x, y) on a line `height` tall. */
export interface ITouchSelectionEdge {
	x: number;
	y: number;
	height: number;
}

export type TouchSelectionEdges = { [kind in TouchSelectionHandleKind]?: ITouchSelectionEdge };

export interface ITouchSelectionHost {
	/** Bounds the handles: a tip outside this rect is scrolled away, and its edges auto-scroll. */
	readonly viewport: HTMLElement;
	/** Where the edges are now, or null while no touch selection should carry handles. */
	getEdges(): TouchSelectionEdges | null;
	/** Pin the edge opposite `kind`; every dragTo until stopDrag moves `kind`. */
	startDrag(kind: TouchSelectionHandleKind): void;
	/** Move the dragged edge to a client point; answer the edge it plays now, if it moved. */
	dragTo(x: number, y: number): TouchSelectionHandleKind | undefined;
	stopDrag(): void;
	/** Scroll the content by `deltaY` client pixels; positive reveals content below. */
	scrollBy(deltaY: number): void;
}

// Keep in step with the handle box in touch.css - a range handle offsets its body by exactly
// one width to put its tip on the selection edge.
const HANDLE_WIDTH = 22;
const FLIPPED_CLASS = 'composery-touch-range-handle-flipped';
const EDGE_SCROLL_ZONE = 44;
const MAX_SCROLL_SPEED = 720; // client px per second

interface IHandle {
	readonly element: HTMLElement;
	kind: TouchSelectionHandleKind;
	edge: ITouchSelectionEdge | undefined;
}

interface IDrag {
	readonly pointerId: number;
	readonly handle: IHandle;
	/** Where the finger grabbed the handle, relative to the tip it drags. */
	readonly grabX: number;
	readonly grabY: number;
	x: number;
	y: number;
}

export class TouchSelectionHandles extends Disposable {

	private readonly _handles: IHandle[];
	private _parent: HTMLElement | undefined;
	private _drag: IDrag | null = null;
	private _suppressed = false;
	private _updateFrame: number | undefined;
	private _scrollFrame: number | undefined;
	private _scrollTime = 0;

	constructor(private readonly _host: ITouchSelectionHost) {
		super();

		this._handles = (['caret', 'start', 'end'] as const).map(kind => this._createHandle(kind));

		// A window that is not the one being touched shows no grips - but hiding them has to
		// be paired with coming back, or they are gone for the rest of the selection's life:
		// on Android, opening the context menu over a selection reads as a window blur
		// (device-verified), and the only other way back is a touch, which ends the
		// selection the menu was opened for.
		const targetWindow = dom.getWindow(_host.viewport);
		const targetDocument = _host.viewport.ownerDocument;
		this._register(dom.addDisposableListener(targetWindow, 'blur', () => this.suppress()));
		this._register(dom.addDisposableListener(targetWindow, 'focus', () => this.reveal()));
		this._register(dom.addDisposableListener(targetDocument, 'visibilitychange', () => {
			if (targetDocument.visibilityState === 'visible') {
				this.reveal();
			} else {
				this.suppress();
			}
		}));
	}

	override dispose(): void {
		this._stopDrag();
		this._cancelUpdate();
		for (const handle of this._handles) {
			handle.element.remove();
		}
		super.dispose();
	}

	get dragging(): boolean {
		return !!this._drag;
	}

	/** Reposition the handles from the host's edges, coalesced to one pass per frame. */
	scheduleUpdate(): void {
		if (this._updateFrame !== undefined) {
			return;
		}
		this._updateFrame = dom.getWindow(this._host.viewport).requestAnimationFrame(() => {
			this._updateFrame = undefined;
			this._update();
		});
	}

	/** Hide the handles until the next reveal - a menu is taking over the selection. */
	suppress(): void {
		this._suppressed = true;
		this._stopDrag();
		this._update();
	}

	/** A fresh touch owns the selection again. */
	reveal(): void {
		this._suppressed = false;
		this.scheduleUpdate();
	}

	private _createHandle(kind: TouchSelectionHandleKind): IHandle {
		const element = this._host.viewport.ownerDocument.createElement('div');
		element.setAttribute('aria-hidden', 'true');
		element.style.display = 'none';
		const handle: IHandle = { element, kind, edge: undefined };
		this._register(dom.addDisposableListener(element, 'pointerdown', (event: PointerEvent) => this._onPointerDown(handle, event), { passive: false }));
		this._register(dom.addDisposableListener(element, 'pointermove', (event: PointerEvent) => this._onPointerMove(event), { passive: false }));
		this._register(dom.addDisposableListener(element, 'pointerup', (event: PointerEvent) => this._onPointerUp(event), { passive: false }));
		this._register(dom.addDisposableListener(element, 'pointercancel', (event: PointerEvent) => this._onPointerUp(event), { passive: false }));
		this._register(dom.addDisposableListener(element, 'lostpointercapture', (event: PointerEvent) => {
			if (this._drag?.pointerId === event.pointerId) {
				this._stopDrag();
			}
		}));
		// A hold on a grip is how a slow adjustment feels; it is not a request for a menu.
		this._register(dom.addDisposableListener(element, dom.EventType.CONTEXT_MENU, (event: MouseEvent) => {
			event.preventDefault();
			event.stopPropagation();
		}));
		return handle;
	}

	// The handles hang off the workbench rather than off the host's own DOM, and so are
	// positioned in client coordinates. Two reasons, either one sufficient: the panes that
	// own selections clip their overflow (a grip on the terminal's prompt line hangs below
	// the last row, a grip on the editor's last line below the lines), and the theme's CSS
	// variables are scoped to .monaco-workbench.
	private _resolveParent(): HTMLElement {
		if (!this._parent) {
			this._parent = this._host.viewport.closest<HTMLElement>('.monaco-workbench') ?? this._host.viewport.ownerDocument.body;
			for (const handle of this._handles) {
				this._parent.appendChild(handle.element);
			}
		}
		return this._parent;
	}

	private _cancelUpdate(): void {
		if (this._updateFrame !== undefined) {
			dom.getWindow(this._host.viewport).cancelAnimationFrame(this._updateFrame);
			this._updateFrame = undefined;
		}
	}

	private _update(): void {
		const edges = this._suppressed ? null : this._host.getEdges();
		if (!edges) {
			for (const handle of this._handles) {
				handle.edge = undefined;
				handle.element.style.display = 'none';
			}
			return;
		}

		const parentRect = this._resolveParent().getBoundingClientRect();
		const viewportRect = this._host.viewport.getBoundingClientRect();
		for (const handle of this._handles) {
			this._position(handle, edges[handle.kind], parentRect, viewportRect);
		}
	}

	private _position(handle: IHandle, edge: ITouchSelectionEdge | undefined, parentRect: DOMRect, viewportRect: DOMRect): void {
		// An edge scrolled out of its own pane has no grip: it would float over whatever
		// pane occupies that spot instead.
		const visible = !!edge
			&& edge.x >= viewportRect.left && edge.x <= viewportRect.right
			&& edge.y > viewportRect.top && edge.y <= viewportRect.bottom;
		handle.edge = visible ? edge : undefined;
		if (!edge || !visible) {
			handle.element.style.display = 'none';
			return;
		}

		// Only the start handle hangs its body a full width to the LEFT of its tip, so at the
		// pane's left edge the body lands over the neighbouring pane. Mirror it instead of
		// clamping: the tip must stay exactly on the selection edge or dragging jumps, so flip
		// the body the way Android and iOS do. The end handle already opens rightwards.
		handle.element.className = handle.kind === 'caret'
			? 'composery-touch-caret-handle'
			: `composery-touch-caret-handle composery-touch-range-handle-${handle.kind}`;
		handle.element.classList.toggle(FLIPPED_CLASS, handle.kind === 'start' && edge.x - viewportRect.left < HANDLE_WIDTH);
		handle.element.style.display = 'block';
		handle.element.style.transform = `translate(${Math.round(edge.x - parentRect.left)}px, ${Math.round(edge.y - parentRect.top)}px)`;
	}

	/** The point on the selection a grip drags: the middle of the line at its tip. */
	private _tip(edge: ITouchSelectionEdge): { x: number; y: number } {
		return { x: edge.x, y: edge.y - edge.height / 2 };
	}

	// Dragging one end keeps the other anchored, so the dragged grip becomes the other kind
	// the moment it crosses that anchor. The grip under the finger keeps its pointer capture;
	// only the roles - and so the shapes - of the two swap.
	private _setKind(handle: IHandle, kind: TouchSelectionHandleKind): void {
		if (handle.kind === kind) {
			return;
		}
		const other = this._handles.find(candidate => candidate !== handle && candidate.kind === kind);
		if (other) {
			other.kind = handle.kind;
		}
		handle.kind = kind;
	}

	private _onPointerDown(handle: IHandle, event: PointerEvent): void {
		if (event.pointerType === 'mouse' || !handle.edge) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();

		const tip = this._tip(handle.edge);
		this._drag = {
			pointerId: event.pointerId,
			handle,
			// A grip is deliberately far larger than the one-pixel edge it carries. Keep where
			// the finger grabbed it, so the first move cannot jump a line or a column.
			grabX: event.clientX - tip.x,
			grabY: event.clientY - tip.y,
			x: event.clientX,
			y: event.clientY
		};
		handle.element.setPointerCapture(event.pointerId);
		this._host.startDrag(handle.kind);
		this.scheduleUpdate();
	}

	private _onPointerMove(event: PointerEvent): void {
		if (!this._drag || event.pointerId !== this._drag.pointerId) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		this._drag.x = event.clientX;
		this._drag.y = event.clientY;
		this._dragToPointer();
		this._updateAutoScroll();
	}

	private _onPointerUp(event: PointerEvent): void {
		if (!this._drag || event.pointerId !== this._drag.pointerId) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		this._stopDrag();
	}

	private _dragToPointer(): void {
		const drag = this._drag;
		if (!drag) {
			return;
		}
		// The finger may leave the pane; the edge it drags may not.
		const rect = this._host.viewport.getBoundingClientRect();
		const x = drag.x - drag.grabX;
		const y = Math.max(rect.top + 1, Math.min(rect.bottom - 1, drag.y - drag.grabY));
		const kind = this._host.dragTo(x, y);
		if (kind) {
			this._setKind(drag.handle, kind);
		}
		this.scheduleUpdate();
	}

	private _stopDrag(): void {
		const drag = this._drag;
		this._drag = null;
		this._stopAutoScroll();
		if (drag) {
			if (drag.handle.element.hasPointerCapture(drag.pointerId)) {
				drag.handle.element.releasePointerCapture(drag.pointerId);
			}
			this._host.stopDrag();
			this.scheduleUpdate();
		}
	}

	// Held against an edge, the drag keeps scrolling and keeps extending: the finger stays
	// put and the selection grows under it, as it does in a native text field.
	private _updateAutoScroll(): void {
		if (this._scrollDirection() === 0) {
			this._stopAutoScroll();
			return;
		}
		if (this._scrollFrame !== undefined) {
			return;
		}
		this._scrollTime = Date.now();
		this._scrollFrame = dom.getWindow(this._host.viewport).requestAnimationFrame(() => this._runAutoScroll());
	}

	private _scrollDirection(): number {
		if (!this._drag) {
			return 0;
		}
		const rect = this._host.viewport.getBoundingClientRect();
		if (this._drag.y < rect.top + EDGE_SCROLL_ZONE) {
			return -1;
		}
		return this._drag.y > rect.bottom - EDGE_SCROLL_ZONE ? 1 : 0;
	}

	private _runAutoScroll(): void {
		this._scrollFrame = undefined;
		const drag = this._drag;
		const direction = this._scrollDirection();
		if (!drag || direction === 0) {
			return;
		}

		const rect = this._host.viewport.getBoundingClientRect();
		const depth = direction < 0 ? rect.top + EDGE_SCROLL_ZONE - drag.y : drag.y - (rect.bottom - EDGE_SCROLL_ZONE);
		const now = Date.now();
		const elapsed = now - this._scrollTime;
		this._scrollTime = now;
		const speed = MAX_SCROLL_SPEED * Math.max(0.25, Math.min(1, depth / EDGE_SCROLL_ZONE));
		this._host.scrollBy(direction * speed * (elapsed / 1000));
		this._dragToPointer();
		this._scrollFrame = dom.getWindow(this._host.viewport).requestAnimationFrame(() => this._runAutoScroll());
	}

	private _stopAutoScroll(): void {
		if (this._scrollFrame !== undefined) {
			dom.getWindow(this._host.viewport).cancelAnimationFrame(this._scrollFrame);
			this._scrollFrame = undefined;
		}
	}
}
