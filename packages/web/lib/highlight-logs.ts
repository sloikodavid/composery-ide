import { createHighlighter, type Highlighter } from "shiki";

const LIGHT_THEME = "one-light";
const DARK_THEME = "one-dark-pro";

let highlighter: Promise<Highlighter> | null = null;

function getHighlighter() {
	if (!highlighter) {
		highlighter = createHighlighter({
			themes: [LIGHT_THEME, DARK_THEME],
			langs: ["ansi"]
		});
	}
	return highlighter;
}

export async function highlightLogs(logs: string) {
	const shiki = await getHighlighter();
	return shiki.codeToHtml(logs, {
		lang: "ansi",
		themes: { light: LIGHT_THEME, dark: DARK_THEME },
		defaultColor: false
	});
}
