/*---------------------------------------------------------------------------------------------
 * Composery: the canonical touch gate - the touch half of the two small-screen gates (the
 * narrow-viewport half is narrowGate.ts, which stays in workbench/browser with its consumers).
 * Lives in base/browser so base widgets and workbench features alike can import it. Fires on
 * any touch device, any screen size - an iPad or a touch laptop counts. Mirrored - but not
 * importable - in the overlay touch.css/.js; keep the touch query in sync.
 *--------------------------------------------------------------------------------------------*/

export const TOUCH_QUERY = '(hover: none), (any-pointer: coarse)';

export function isTouch(targetWindow: Window): boolean {
	return targetWindow.matchMedia(TOUCH_QUERY).matches;
}
