/*---------------------------------------------------------------------------------------------
 * Composery: xterm cell geometry - the bridge from a client point to a buffer cell. A finger
 * lands on a pixel and carries no modifier, so every touch feature over the terminal (link
 * activation, text selection) has to ask this same question, and a second copy of the answer
 * is a link that opens the cell next to the one that was tapped.
 *--------------------------------------------------------------------------------------------*/

import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import type { IXtermCore } from './xterm-private.js';

/** A cell in the terminal buffer: 0-based column, absolute (scrollback-relative) row. */
export interface IBufferCellPoint {
	x: number;
	y: number;
}

interface IXtermWithCore extends RawXtermTerminal {
	_core: IXtermCore;
}

/** The rendered size of one cell in CSS pixels, or undefined before the first render. */
export function getCellSize(xterm: RawXtermTerminal): { width: number; height: number } | undefined {
	const cell = (xterm as IXtermWithCore)._core._renderService?.dimensions.css.cell;
	return cell && cell.width > 0 && cell.height > 0 ? cell : undefined;
}

/** The screen element, which is exactly the rendered grid - the viewport is wider by its scrollbar. */
export function getScreenElement(xterm: RawXtermTerminal): HTMLElement | undefined {
	const screen = xterm.element?.querySelector('.xterm-screen');
	return screen instanceof HTMLElement ? screen : undefined;
}

/** The cell under a client point, or undefined when the point is off the rendered grid. */
export function getBufferCellAt(xterm: RawXtermTerminal, clientX: number, clientY: number): IBufferCellPoint | undefined {
	const cell = getCellSize(xterm);
	const screen = getScreenElement(xterm);
	if (!cell || !screen) {
		return undefined;
	}
	const rect = screen.getBoundingClientRect();
	const column = Math.floor((clientX - rect.left) / cell.width);
	const row = Math.floor((clientY - rect.top) / cell.height);
	if (column < 0 || column >= xterm.cols || row < 0 || row >= xterm.rows) {
		return undefined;
	}
	return { x: column, y: xterm.buffer.active.viewportY + row };
}
