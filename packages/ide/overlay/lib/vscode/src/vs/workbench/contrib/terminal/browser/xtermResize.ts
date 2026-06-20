interface IXtermResizeTarget {
	buffer: {
		active: {
			baseY: number;
			viewportY: number;
		};
	};
	resize(columns: number, rows: number): void;
	scrollLines(lines: number): void;
}

export function resize(
	target: IXtermResizeTarget,
	columns: number,
	rows: number
): void {
	const before = target.buffer.active;
	const restoreTo =
		before.viewportY === before.baseY ? undefined : before.viewportY;
	target.resize(columns, rows);
	if (restoreTo !== undefined) {
		target.scrollLines(restoreTo - target.buffer.active.viewportY);
	}
}
