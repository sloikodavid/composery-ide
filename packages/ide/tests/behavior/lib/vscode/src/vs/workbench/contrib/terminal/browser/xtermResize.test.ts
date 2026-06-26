import { describe, expect, test } from "vitest";

import { resize } from "../../../../../../../../../../overlay/lib/vscode/src/vs/workbench/contrib/terminal/browser/xtermResize.ts";

function runResize(viewportY: number, baseY: number, drift: number) {
	const scrolled: number[] = [];
	const buffer = { viewportY, baseY };
	const target = {
		buffer: { active: buffer },
		resize() {
			buffer.viewportY += drift;
			buffer.baseY += drift;
		},
		scrollLines(lines: number) {
			scrolled.push(lines);
			buffer.viewportY += lines;
		}
	};

	resize(target, 80, 18);
	return { viewportY: buffer.viewportY, scrolled };
}

describe("xterm resize", () => {
	test("a scrolled-up viewport stays on the same content", () => {
		expect(runResize(40, 100, 16)).toEqual({
			viewportY: 40,
			scrolled: [-16]
		});
		expect(runResize(40, 100, -16)).toEqual({
			viewportY: 40,
			scrolled: [16]
		});
	});

	test("a viewport following the bottom keeps following it", () => {
		expect(runResize(100, 100, 16)).toEqual({
			viewportY: 116,
			scrolled: []
		});
	});

	test("the alternate screen is never scrolled", () => {
		expect(runResize(0, 0, 0)).toEqual({ viewportY: 0, scrolled: [] });
	});
});
