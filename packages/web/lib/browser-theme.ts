import { BRAND_THEME } from "shared";

export type BrowserTheme = keyof typeof BROWSER_THEME_COLORS;

export const BROWSER_THEME_COLORS = {
	light: BRAND_THEME.light.header,
	dark: BRAND_THEME.dark.header
} as const;

// Next emits one media-qualified theme-color meta per scheme for first paint.
// Once next-themes resolves a user override, both must carry that resolved
// colour: leaving their media queries in charge would keep browser chrome on
// the OS scheme while the page itself uses the user's choice.
export function syncBrowserThemeColor(document: Document, theme: BrowserTheme) {
	const metas = [
		...document.head.querySelectorAll<HTMLMetaElement>(
			'meta[name="theme-color"]'
		)
	];
	if (metas.length === 0) {
		const meta = document.createElement("meta");
		meta.name = "theme-color";
		document.head.append(meta);
		metas.push(meta);
	}
	for (const meta of metas) meta.content = BROWSER_THEME_COLORS[theme];
}
