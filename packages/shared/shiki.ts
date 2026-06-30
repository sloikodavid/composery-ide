import { ideTheme, theme } from "./theme.ts";

// Two Shiki themes for code highlighting. Syntax roles come from the same
// table the IDE themes are generated from (packages/shared/theme.json), so
// code on the website and code in the editor can never drift apart. The
// background stays transparent - the code sits on the card surface around it,
// like everything else on the page.
function codeTheme(mode: "light" | "dark") {
	const syntax = ideTheme[mode];
	const c = theme[mode];
	return {
		name: `composery-${mode}`,
		type: mode,
		bg: "transparent",
		fg: c.foreground,
		settings: [
			{ scope: ["comment"], settings: { foreground: syntax.comment } },
			{
				scope: ["keyword", "storage"],
				settings: { foreground: syntax.keyword }
			},
			{ scope: ["string"], settings: { foreground: syntax.string } },
			{
				scope: ["constant.numeric", "constant.language", "constant.other"],
				settings: { foreground: syntax.number }
			},
			{
				scope: ["entity.name.function", "support.function"],
				settings: { foreground: syntax.function }
			},
			{
				scope: ["entity.name.type", "entity.name.class", "support.type"],
				settings: { foreground: syntax.type }
			},
			{
				scope: ["punctuation", "operator", "keyword.operator", "delimiter"],
				settings: { foreground: syntax.punctuation }
			}
		]
	};
}

export const SHIKI_THEMES = {
	light: codeTheme("light"),
	dark: codeTheme("dark")
};
