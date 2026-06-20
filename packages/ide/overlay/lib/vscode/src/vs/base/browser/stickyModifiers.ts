/*---------------------------------------------------------------------------------------------
 * Composery: the sticky Ctrl/Alt/Shift the touch keybar arms, held in one place because two
 * things have to agree about them.
 *
 * The keybar owns the keys, but a modifier armed there has to survive a keystroke that the
 * keybar never sees: a soft keyboard commits through beforeinput, and its Enter arrives as an
 * `insertLineBreak` with no data at all, which ImeEnterFallback - not the keybar - is the code
 * that replays. Without shared state that replay is an unmodified Enter, so Shift+Enter (the
 * one chord a phone keyboard can neither send nor be made to send) silently does nothing while
 * the armed Shift leaks onto whatever is typed next.
 *
 * Module state rather than a service: this is one bar in one window, and a service would drag
 * DI and layering into vs/base/browser for three booleans. The keybar is the only writer.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../common/event.js';

export type Modifier = 'ctrl' | 'alt' | 'shift';
export type ModifierState = 'off' | 'oneShot' | 'locked';

export const MODIFIERS: readonly Modifier[] = ['ctrl', 'alt', 'shift'];

// A second tap inside this window locks the modifier instead of clearing it.
const DOUBLE_TAP_MS = 350;

class StickyModifiers {

	private readonly states = new Map<Modifier, ModifierState>(MODIFIERS.map(id => [id, 'off'] as const));
	private readonly lastTap = new Map<Modifier, number>();

	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange: Event<void> = this._onDidChange.event;

	state(id: Modifier): ModifierState {
		return this.states.get(id) ?? 'off';
	}

	held(id: Modifier): boolean {
		return this.state(id) !== 'off';
	}

	get any(): boolean {
		return MODIFIERS.some(id => this.held(id));
	}

	// off -> armed for one key -> locked until tapped off. A double tap skips the middle.
	tap(id: Modifier): void {
		const now = Date.now();
		const previous = this.state(id);
		const doubleTap = now - (this.lastTap.get(id) ?? 0) < DOUBLE_TAP_MS;
		this.lastTap.set(id, now);

		if (previous === 'locked') {
			this.set(id, 'off');
		} else if (previous === 'oneShot') {
			this.set(id, doubleTap ? 'locked' : 'off');
		} else {
			this.set(id, 'oneShot');
		}
	}

	set(id: Modifier, state: ModifierState): void {
		if (this.state(id) === state) {
			return;
		}
		this.states.set(id, state);
		this._onDidChange.fire();
	}

	// Called by whoever actually delivered a key with these modifiers on it.
	consume(): void {
		for (const id of MODIFIERS) {
			if (this.state(id) === 'oneShot') {
				this.set(id, 'off');
			}
		}
	}

	reset(): void {
		for (const id of MODIFIERS) {
			this.set(id, 'off');
		}
	}
}

export const stickyModifiers = new StickyModifiers();
