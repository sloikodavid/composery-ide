// @vitest-environment jsdom

import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ThemeProvider } from "@/components/theme-provider";
import { BROWSER_THEME_COLORS } from "@/lib/browser-theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

// jsdom has no matchMedia. This is the OS scheme, controllable from a test.
//
// Both subscription APIs feed the same set on purpose: next-themes uses the
// legacy `addListener`, and a stub that only honoured that one would have made
// every assertion below pass against the very code they exist to rule out - a
// second `addEventListener("change")` writing an explicit theme would simply
// never have fired.
type SchemeListener = (event: { matches: boolean }) => void;
const listeners = new Set<SchemeListener>();
let osPrefersDark = false;

function setOsScheme(dark: boolean) {
	osPrefersDark = dark;
	for (const listener of listeners) listener({ matches: dark });
}

beforeEach(() => {
	listeners.clear();
	osPrefersDark = false;
	localStorage.clear();
	document.head.innerHTML = "";
	document.documentElement.className = "";
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		writable: true,
		value: (query: string) => ({
			media: query,
			get matches() {
				return query === DARK_QUERY ? osPrefersDark : false;
			},
			addListener: (listener: SchemeListener) => listeners.add(listener),
			removeListener: (listener: SchemeListener) => listeners.delete(listener),
			addEventListener: (_type: string, listener: SchemeListener) =>
				listeners.add(listener),
			removeEventListener: (_type: string, listener: SchemeListener) =>
				listeners.delete(listener),
			dispatchEvent: () => false
		})
	});
});

afterEach(cleanup);

function mount() {
	return render(
		// eslint-disable-next-line react/no-children-prop
		createElement(ThemeProvider, {
			attribute: "class",
			defaultTheme: "system",
			enableSystem: true,
			children: null
		})
	);
}

function faviconHref() {
	return document.head
		.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]')
		?.getAttribute("href");
}

function themeColors() {
	return [
		...document.head.querySelectorAll<HTMLMetaElement>(
			'meta[name="theme-color"]'
		)
	].map((meta) => meta.content);
}

describe("ThemeProvider", () => {
	test("follows the operating system without ever recording a choice of its own", () => {
		// The defect this pins: a second `prefers-color-scheme` listener that
		// called setTheme wrote an explicit "light"/"dark" into storage the first
		// time the OS flipped. From then on the site was pinned - it no longer
		// followed the system, and the next flip overwrote whatever the visitor
		// had since picked with the toggle.
		mount();
		expect(faviconHref()).toBe("/icon-light.svg");

		act(() => setOsScheme(true));

		expect(faviconHref()).toBe("/icon-dark.svg");
		expect(localStorage.getItem("theme")).not.toBe("dark");
	});

	test("keeps an explicit choice when the operating system changes under it", () => {
		localStorage.setItem("theme", "dark");
		mount();
		expect(faviconHref()).toBe("/icon-dark.svg");

		act(() => setOsScheme(false));

		expect(faviconHref()).toBe("/icon-dark.svg");
		expect(localStorage.getItem("theme")).toBe("dark");
	});

	test("paints the browser chrome the colour the page resolved to", () => {
		// The meta tags Next renders are media-qualified for first paint; once a
		// theme resolves, every one of them has to carry that colour or the chrome
		// stays on the OS scheme while the page does not.
		for (const scheme of ["light", "dark"] as const) {
			const meta = document.createElement("meta");
			meta.name = "theme-color";
			meta.media = `(prefers-color-scheme: ${scheme})`;
			document.head.append(meta);
		}

		localStorage.setItem("theme", "dark");
		mount();

		expect(themeColors()).toEqual([
			BROWSER_THEME_COLORS.dark,
			BROWSER_THEME_COLORS.dark
		]);
	});
});
