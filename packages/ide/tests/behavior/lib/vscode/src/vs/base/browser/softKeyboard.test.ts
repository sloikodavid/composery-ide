import { describe, expect, test } from "vitest";

import { softKeyboard } from "../../../../../../../../overlay/lib/vscode/src/vs/base/browser/softKeyboard.ts";

function fakeWindow(
	innerHeight: number,
	viewport: { height: number; offsetTop: number; scale: number } | undefined,
	vars: Record<string, string> = {}
): Window {
	return {
		innerHeight,
		visualViewport: viewport,
		document: { documentElement: {} },
		getComputedStyle: () => ({
			getPropertyValue: (name: string) => vars[name] ?? ""
		})
	} as unknown as Window;
}

describe("soft keyboard geometry", () => {
	test("detects a keyboard excluded from the visual viewport", () => {
		expect(
			softKeyboard(fakeWindow(800, { height: 520, offsetTop: 0, scale: 1 }))
		).toEqual({ open: true });
	});

	test("uses the published verdict when both viewports shrink together", () => {
		const geometry = { height: 520, offsetTop: 0, scale: 1 };

		expect(softKeyboard(fakeWindow(520, geometry))).toEqual({
			open: false
		});
		expect(
			softKeyboard(
				fakeWindow(520, geometry, {
					"--composery-touch-keyboard-open": "1"
				})
			)
		).toEqual({ open: true });
	});

	test("rejects viewport movement and pinch zoom as keyboard geometry", () => {
		expect(
			softKeyboard(fakeWindow(800, { height: 800, offsetTop: 120, scale: 1 }))
		).toEqual({ open: false });
		expect(
			softKeyboard(fakeWindow(800, { height: 400, offsetTop: 0, scale: 2 }))
		).toEqual({ open: false });
		expect(softKeyboard(fakeWindow(800, undefined))).toEqual({
			open: false
		});
	});
});
