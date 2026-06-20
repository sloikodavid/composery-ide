/*---------------------------------------------------------------------------------------------
 * Composery: the canonical narrow gate - the screen-size half of the two small-screen gates (the
 * other is the touch gate in touchGate.ts). Fires on any small viewport, mouse or touch, so a
 * narrow desktop browser window counts. Mirrored - but not importable - in the overlay
 * narrow.css/.js; keep the breakpoint in sync.
 *--------------------------------------------------------------------------------------------*/

export const NARROW_MAX_WIDTH = 768;

export const NARROW_QUERY = `(max-width: ${NARROW_MAX_WIDTH}px)`;

export function isNarrow(targetWindow: Window): boolean {
	return targetWindow.matchMedia(NARROW_QUERY).matches;
}
