import { JSDOM } from "jsdom";
import { describe, expect, test } from "vitest";

import {
	BROWSER_THEME_COLORS,
	syncBrowserThemeColor
} from "@/lib/browser-theme.ts";

describe("browser theme color", () => {
	test("updates every first-paint meta to the resolved user scheme", () => {
		const document = new JSDOM(`<!doctype html><head>
			<meta name="theme-color" content="#111111" media="(prefers-color-scheme: light)">
			<meta name="theme-color" content="#222222" media="(prefers-color-scheme: dark)">
		</head>`).window.document;

		syncBrowserThemeColor(document, "dark");

		expect(
			[
				...document.querySelectorAll<HTMLMetaElement>(
					'meta[name="theme-color"]'
				)
			].map((meta) => meta.content)
		).toEqual([BROWSER_THEME_COLORS.dark, BROWSER_THEME_COLORS.dark]);
	});

	test("creates the browser meta when a host omitted first-paint metadata", () => {
		const document = new JSDOM("<!doctype html><head></head>").window.document;

		syncBrowserThemeColor(document, "light");

		expect(
			document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
				?.content
		).toBe(BROWSER_THEME_COLORS.light);
	});
});
