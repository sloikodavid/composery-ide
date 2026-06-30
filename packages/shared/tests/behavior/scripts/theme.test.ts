import { beforeEach, describe, expect, test, vi } from "vitest";

import { ideFeatures, ideTheme, theme } from "../../../index.ts";

const firstPaintKeys = `
checkbox.border editor.background editor.foreground editor.inactiveSelectionBackground
editorIndentGuide.background1 editorIndentGuide.activeBackground1 editor.selectionHighlightBackground
editorSuggestWidget.background activityBarBadge.background sideBarTitle.foreground
list.hoverBackground menu.border input.placeholderForeground searchEditor.textInputBorder
settings.textInputBorder settings.numberInputBorder statusBarItem.remoteForeground
statusBarItem.remoteBackground ports.iconRunningProcessForeground sideBarSectionHeader.background
sideBarSectionHeader.border tab.selectedForeground tab.selectedBackground tab.lastPinnedBorder
notebook.cellBorderColor notebook.selectedCellBackground statusBarItem.errorBackground
list.activeSelectionIconForeground list.focusAndSelectionOutline terminal.inactiveSelectionBackground
widget.border actionBar.toggledBackground diffEditor.unchangedRegionBackground
agentsNewSessionButton.border agentsChatInput.border activityBar.activeBorder activityBar.background
activityBar.border activityBar.foreground activityBar.inactiveForeground activityBarBadge.foreground
badge.background badge.foreground button.background button.border button.foreground
button.hoverBackground button.secondaryBackground button.secondaryForeground
button.secondaryHoverBackground chat.slashCommandBackground chat.slashCommandForeground
chat.editedFileForeground checkbox.background descriptionForeground dropdown.background
dropdown.border dropdown.foreground dropdown.listBackground editorGroup.border
editorGroupHeader.tabsBackground editorGroupHeader.tabsBorder editorGutter.addedBackground
editorGutter.deletedBackground editorGutter.modifiedBackground editorLineNumber.activeForeground
editorLineNumber.foreground editorOverviewRuler.border editorWidget.background errorForeground
focusBorder foreground icon.foreground input.background input.border input.foreground
inputOption.activeBackground inputOption.activeBorder inputOption.activeForeground
keybindingLabel.foreground list.activeSelectionBackground list.activeSelectionForeground
menu.selectionBackground menu.selectionForeground notificationCenterHeader.background
notificationCenterHeader.foreground notifications.background notifications.border
notifications.foreground panel.background panel.border panelInput.border panelTitle.activeBorder
panelTitle.activeForeground panelTitle.inactiveForeground peekViewEditor.matchHighlightBackground
peekViewResult.background peekViewResult.matchHighlightBackground pickerGroup.border
pickerGroup.foreground progressBar.background quickInput.background quickInput.foreground
settings.dropdownBackground settings.dropdownBorder settings.headerForeground
settings.modifiedItemIndicator sideBar.background sideBar.border sideBar.foreground
sideBarSectionHeader.foreground statusBar.background statusBar.foreground statusBar.border
statusBarItem.hoverBackground statusBarItem.hoverForeground statusBarItem.compactHoverBackground
statusBar.debuggingBackground statusBar.debuggingForeground statusBar.focusBorder
`
	.trim()
	.split(/\s+/);

const tokenRules = [
	["comment.line", "#010101"],
	["constant.character.escape.js", "#010101"],
	["string.regexp", "#010101"],
	["string.quoted", "#010101"],
	["meta.decorator", "#010101"],
	["support.function", "#010101"],
	["entity.name.namespace", "#010101"],
	["entity.name.tag", "#010101"],
	["support.class", "#010101"],
	["constant.numeric", "#010101"],
	["keyword.operator", "#010101"],
	["storage.modifier", "#010101"],
	["variable.parameter", "#010101"],
	["variable.other.property", "#010101"],
	["entity.other.attribute-name", "#010101"],
	["entity.name.label", "#010101"],
	["support.constant", "#010101"],
	["variable.other", "#010101"],
	["punctuation.definition", "#010101"],
	["markup.inserted.diff", "#010101"],
	["markup.deleted.diff", "#010101"],
	["markup.changed.diff", "#010101"],
	["invalid.illegal", "#010101"],
	["source.unclassified", "#010101"]
].map(([scope, foreground]) => ({ scope, settings: { foreground } }));

const semanticTokenColors = Object.fromEntries(
	[
		"comment",
		"regexpToken",
		"stringToken",
		"numberToken",
		"decoratorToken",
		"namespaceToken",
		"labelToken",
		"functionToken",
		"methodToken",
		"customLiteralToken",
		"classToken",
		"enumToken",
		"interfaceToken",
		"structToken",
		"typeToken",
		"operatorToken",
		"keywordToken",
		"parameterToken",
		"propertyToken",
		"variableToken",
		"unknownToken"
	].map((key, index) => [
		key,
		index % 2 === 0 ? "#010101" : { foreground: "#010101", bold: true }
	])
);

function upstreamTheme() {
	return {
		include: "./base.json",
		colors: { "child.color": "#020202" },
		semanticTokenColors,
		tokenColors: [
			...tokenRules,
			{
				scope: ["comment.block", "string.quoted"],
				settings: { fontStyle: "bold" }
			}
		]
	};
}

function firstPaintPatch() {
	const block = (scheme: string) => [
		`+const COLOR_THEME_${scheme.toUpperCase()}_INITIAL_COLORS = {`,
		...firstPaintKeys.map((key) => `+\t'${key}': '#010101',`),
		"+};"
	];
	return [...block("light"), ...block("dark")].join("\n");
}

const workbenchPatch = `+<meta name="theme-color" content="#111111" media="(prefers-color-scheme: light)">
+<meta name="theme-color" content="#222222" media="(prefers-color-scheme: dark)">
+ html, body { background-color: #333333; }
+ @media (prefers-color-scheme: dark) { html, body { background-color: #444444; } }
+theme_color: "#777777"
+background_color: "#888888"`;

const host = vi.hoisted<{
	config: unknown;
	writes: Array<{ path: string; contents: string }>;
}>(() => ({
	config: null,
	writes: []
}));

vi.mock("node:fs/promises", () => ({
	readFile: (path: string) => {
		const normalized = path.replaceAll("\\", "/");
		if (normalized.endsWith("/packages/shared/theme.json"))
			return Promise.resolve(JSON.stringify(host.config));
		if (normalized.endsWith("/themes/light_modern.json"))
			return Promise.resolve(JSON.stringify(upstreamTheme()));
		if (normalized.endsWith("/themes/dark_modern.json"))
			return Promise.resolve(JSON.stringify(upstreamTheme()));
		if (normalized.endsWith("/themes/base.json"))
			return Promise.resolve(
				JSON.stringify({
					colors: Object.fromEntries(
						firstPaintKeys.map((key) => [key, "#010101"])
					),
					semanticTokenColors: { inheritedComment: "#010101" },
					tokenColors: []
				})
			);
		if (normalized.endsWith("/patches/first-paint.diff"))
			return Promise.resolve(firstPaintPatch());
		if (normalized.endsWith("/patches/workbench-page.diff"))
			return Promise.resolve(workbenchPatch);
		return Promise.resolve(null);
	},
	readdir: () =>
		Promise.resolve(["README.md", "first-paint.diff", "workbench-page.diff"]),
	writeFile: (path: string, contents: string) => {
		host.writes.push({ path, contents });
		return Promise.resolve();
	}
}));

vi.mock("../../../../../scripts/write-formatted.mjs", () => ({
	formatContent: (_path: string, contents: string) => Promise.resolve(contents)
}));

const slash = (path: string) => path.replaceAll("\\", "/");

async function generate(check = false) {
	host.writes.length = 0;
	const argv = process.argv;
	process.argv = check
		? [...argv, "--check"]
		: argv.filter((v) => v !== "--check");
	vi.resetModules();
	try {
		// @ts-expect-error The behavior-tested JavaScript entry point has no declaration file.
		await import("../../../scripts/theme.mjs");
	} finally {
		process.argv = argv;
	}
}

function generated(scheme: "light" | "dark") {
	const entry = host.writes.find(({ path }) =>
		slash(path).endsWith(`/themes/composery-${scheme}.json`)
	);
	expect(entry).not.toBeUndefined();
	return JSON.parse(entry?.contents ?? "null") as {
		semanticHighlighting: boolean;
		colors: Record<string, string>;
		tokenColors: Array<{
			name?: string;
			scope?: string | string[];
			settings: { foreground?: string; fontStyle?: string };
		}>;
		semanticTokenColors: Record<
			string,
			string | Record<string, string | boolean>
		>;
	};
}

beforeEach(() => {
	host.config = {
		web: structuredClone(theme),
		ide: {
			features: structuredClone(ideFeatures),
			...structuredClone(ideTheme)
		}
	};
});

describe("theme generator", () => {
	test("retints inherited VS Code chrome, syntax, semantics, and status colors", async () => {
		await generate();

		const light = generated("light");
		const dark = generated("dark");
		expect(light).toMatchObject({
			$schema: "vscode://schemas/color-theme",
			name: "Composery Light",
			type: "light",
			semanticHighlighting: true,
			colors: {
				"child.color": "#020202",
				"editor.background": ideTheme.light.editor,
				"editor.foreground": ideTheme.light.foreground,
				"activityBar.background": ideTheme.light.activityBar,
				"editorWidget.background": ideTheme.light.widget,
				"sideBar.background": ideTheme.light.sideBar,
				"panel.background": ideTheme.light.panel,
				"statusBar.background": ideTheme.light.statusBar,
				"editor.selectionBackground": ideTheme.light.selection,
				"editorLink.activeForeground": ideTheme.light.link,
				"gitDecoration.addedResourceForeground": theme.light.success,
				"editorWarning.foreground": theme.light.warning,
				"editorError.foreground": theme.light.destructive,
				"editorInfo.foreground": theme.light.info,
				"terminal.ansiRed": theme.light.destructive,
				"terminal.ansiGreen": theme.light.success
			}
		});
		expect(dark).toMatchObject({
			name: "Composery Dark",
			type: "dark",
			colors: {
				"editor.background": ideTheme.dark.editor,
				"editor.foreground": ideTheme.dark.foreground,
				"activityBar.background": ideTheme.dark.activityBar,
				"button.background": ideTheme.dark.button,
				"button.foreground": ideTheme.dark.buttonForeground,
				"gitDecoration.addedResourceForeground": theme.dark.success,
				"editorWarning.foreground": theme.dark.warning,
				"editorError.foreground": theme.dark.destructive,
				"editorInfo.foreground": theme.dark.info
			}
		});
		expect(light.tokenColors[0]!.settings).toMatchObject({
			foreground: ideTheme.light.comment
		});
		expect(light.tokenColors[10]!.settings).toMatchObject({
			foreground: ideTheme.light.operator
		});
		expect(light.tokenColors[19]!.settings.foreground).toBe(
			theme.light.success
		);
		expect(light.semanticTokenColors.comment).toBe(ideTheme.light.comment);
		expect(light.semanticTokenColors.keywordToken).toBe(ideTheme.light.keyword);
	});

	test("controls surface, control, and tab borders independently", async () => {
		const config = host.config as {
			ide: {
				features: Record<string, boolean>;
			};
		};
		config.ide.features.surfaceBorders = false;
		config.ide.features.controlBorders = true;
		config.ide.features.tabBorders = false;
		await generate();

		const light = generated("light");
		for (const key of [
			"activityBar.border",
			"editorGroup.border",
			"widget.border"
		])
			expect(light.colors[key], key).toBe("#00000000");
		expect(light.colors["input.border"]).toBe(ideTheme.light.inputBorder);
		expect(light.colors["tab.border"]).toBe("#00000000");
		expect(light.colors.focusBorder).toBe(ideTheme.light.focus);
		expect(light.colors["editorBracketMatch.border"]).toBe(
			ideTheme.light.bracketMatch
		);
	});

	test("controls optional workbench effects independently", async () => {
		const config = host.config as {
			ide: {
				features: Record<string, boolean>;
			};
		};
		config.ide.features.shadows = false;
		config.ide.features.activeTabIndicator = false;
		config.ide.features.activityBarIndicator = false;
		config.ide.features.panelTitleIndicator = false;
		config.ide.features.contrastBorders = true;
		config.ide.features.semanticHighlighting = false;
		await generate();

		const light = generated("light");
		expect(light.colors["widget.shadow"]).toBe("#00000000");
		expect(light.colors["scrollbar.shadow"]).toBe("#00000000");
		expect(light.colors["tab.activeBorderTop"]).toBe("#00000000");
		expect(light.colors["terminal.tab.activeBorder"]).toBe("#00000000");
		expect(light.colors["activityBar.activeBorder"]).toBe("#00000000");
		expect(light.colors["panelTitle.activeBorder"]).toBe("#00000000");
		expect(light.colors.contrastBorder).toBe(ideTheme.light.border);
		expect(light.colors.contrastActiveBorder).toBe(ideTheme.light.focus);
		expect(light.semanticHighlighting).toBe(false);
	});

	test("updates committed TypeScript and patch literals from the generated themes", async () => {
		await generate();

		const themeSource = host.writes.find(({ path }) =>
			slash(path).endsWith("/packages/shared/theme.ts")
		);
		expect(themeSource?.contents).toContain(
			`export const theme = ${JSON.stringify(theme, null, "\t")} as const;`
		);
		expect(themeSource?.contents).toContain(
			`export const ideTheme = ${JSON.stringify(ideTheme, null, "\t")} as const;`
		);
		expect(themeSource?.contents).toContain(
			`export const ideFeatures = ${JSON.stringify(ideFeatures, null, "\t")} as const;`
		);

		const firstPaint = host.writes.find(({ path }) =>
			slash(path).endsWith("/patches/first-paint.diff")
		)?.contents;
		expect(firstPaint).toContain(
			`+\t'editor.background': '${ideTheme.light.editor}',`
		);
		expect(firstPaint).toContain(
			`+\t'editor.background': '${ideTheme.dark.editor}',`
		);
		expect(firstPaint).toContain(
			`+\t'activityBarBadge.background': '${ideTheme.light.badge}',`
		);
		expect(firstPaint).toContain(
			`+\t'activityBarBadge.background': '${ideTheme.dark.badge}',`
		);
		expect(firstPaint).toContain(
			`+\t'button.border': '${ideTheme.light.inputBorder}',`
		);

		const workbench = host.writes.find(({ path }) =>
			slash(path).endsWith("/patches/workbench-page.diff")
		)?.contents;
		expect(workbench)
			.toBe(`+<meta name="theme-color" content="${ideTheme.light.titleBar}" media="(prefers-color-scheme: light)">
+<meta name="theme-color" content="${ideTheme.dark.titleBar}" media="(prefers-color-scheme: dark)">
+ html, body { background-color: ${ideTheme.light.editor}; }
+ @media (prefers-color-scheme: dark) { html, body { background-color: ${ideTheme.dark.editor}; } }
+theme_color: "${ideTheme.dark.titleBar}"
+background_color: "${ideTheme.dark.editor}"`);
	});

	test("derives workbench browser chrome and first paint from IDE surfaces", async () => {
		const config = host.config as {
			ide: {
				light: { titleBar: string; editor: string };
				dark: { titleBar: string; editor: string };
			};
		};
		config.ide.light.titleBar = "#112233";
		config.ide.light.editor = "#223344";
		config.ide.dark.titleBar = "#334455";
		config.ide.dark.editor = "#445566";

		await generate();

		const workbench = host.writes.find(({ path }) =>
			slash(path).endsWith("/patches/workbench-page.diff")
		)?.contents;
		expect(workbench).toContain(
			'<meta name="theme-color" content="#112233" media="(prefers-color-scheme: light)">'
		);
		expect(workbench).toContain(
			'<meta name="theme-color" content="#334455" media="(prefers-color-scheme: dark)">'
		);
		expect(workbench).toContain("html, body { background-color: #223344; }");
		expect(workbench).toContain(
			"@media (prefers-color-scheme: dark) { html, body { background-color: #445566; } }"
		);
		expect(workbench).toContain('theme_color: "#334455"');
		expect(workbench).toContain('background_color: "#445566"');
	});

	test("rejects an invalid palette before emitting partial outputs", async () => {
		const config = structuredClone(host.config) as {
			web: { light: { background: string; foreground: string } };
		};
		config.web.light.foreground = config.web.light.background;
		host.config = config;

		await expect(generate()).rejects.toThrow(
			"light page text must have 4.5:1 contrast"
		);
		expect(host.writes).toEqual([]);
	});

	test("check mode reports stale generated files without replacing them", async () => {
		await expect(generate(true)).rejects.toThrow(
			"Theme outputs are stale; run `pnpm fix:assets`"
		);
		expect(host.writes).toEqual([]);
	});
});
