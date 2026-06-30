import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { formatContent } from "../../../scripts/write-formatted.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const configPath = join(root, "packages", "shared", "theme.json");
const themeSourcePath = join(root, "packages", "shared", "theme.ts");
const upstreamThemes = join(
	root,
	"packages",
	"ide",
	"upstream",
	"lib",
	"vscode",
	"extensions",
	"theme-defaults",
	"themes"
);
const outputThemes = join(
	root,
	"packages",
	"ide",
	"overlay",
	"lib",
	"vscode",
	"extensions",
	"composery-themes",
	"themes"
);
const check = process.argv.includes("--check");
const stale = [];

async function emit(path, contents) {
	const formatted = await formatContent(path, contents);
	await emitRaw(path, formatted);
}

async function emitRaw(path, contents) {
	if (check) {
		if ((await readFile(path, "utf8").catch(() => null)) !== contents)
			stale.push(relative(root, path));
		return;
	}
	await writeFile(path, contents, "utf8");
}

function parseJsonc(path, source) {
	const result = ts.parseConfigFileTextToJson(path, source);
	if (result.error)
		throw new Error(
			ts.flattenDiagnosticMessageText(result.error.messageText, "\n")
		);
	return result.config;
}

async function flatten(file) {
	const path = join(upstreamThemes, file);
	const current = parseJsonc(path, await readFile(path, "utf8"));
	const parent = current.include
		? await flatten(current.include.replace("./", ""))
		: {};
	return {
		...parent,
		...current,
		colors: { ...parent.colors, ...current.colors },
		semanticTokenColors: {
			...parent.semanticTokenColors,
			...current.semanticTokenColors
		},
		tokenColors: [...(parent.tokenColors ?? []), ...(current.tokenColors ?? [])]
	};
}

const appendAlpha = (color, alpha) => color.slice(0, 7) + alpha;
const transparent = "#00000000";

function set(colors, keys, value) {
	for (const key of keys) colors[key] = value;
}

function luminance(color) {
	const channels = color
		.slice(1, 7)
		.match(/../g)
		.map((part) => {
			const channel = Number.parseInt(part, 16) / 255;
			return channel <= 0.03928
				? channel / 12.92
				: ((channel + 0.055) / 1.055) ** 2.4;
		});
	return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(first, second) {
	const a = luminance(first);
	const b = luminance(second);
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function syntaxRole(scopes) {
	const matches = (pattern) => scopes.some((scope) => pattern.test(scope));
	if (matches(/^comment/)) return "comment";
	if (matches(/^constant\.character\.escape/)) return "escape";
	if (matches(/^.*regexp|^.*regex/)) return "regex";
	if (matches(/^(string|markup\.inline\.raw)/)) return "string";
	if (matches(/^(entity\.name\.function\.decorator|meta\.decorator)/))
		return "decorator";
	if (
		matches(
			/^(entity\.name\.function|support\.function|meta\.function-call|entity\.name\.method)/
		)
	)
		return "function";
	if (matches(/^entity\.name\.namespace/)) return "namespace";
	if (matches(/^(entity\.name\.tag|entity\.name\.selector)/)) return "tag";
	if (
		matches(
			/^(support\.class|entity\.name\.type|support\.type|meta\.type|storage\.type)/
		)
	)
		return "type";
	if (matches(/^(constant\.numeric|keyword\.other\.unit)/)) return "number";
	if (matches(/^keyword\.operator/)) return "operator";
	if (
		matches(
			/^(keyword|storage\.modifier|constant\.language|modifier|meta\.preprocessor)/
		)
	)
		return "keyword";
	if (matches(/^variable\.parameter/)) return "parameter";
	if (
		matches(
			/^(meta\.object-literal|.*dictionary\.key|variable\.other\.property|support\.variable\.property)/
		)
	)
		return "property";
	if (matches(/^entity\.other\.attribute-name/)) return "attribute";
	if (matches(/^entity\.name\.label/)) return "label";
	if (matches(/^(support\.constant|constant\.other)/)) return "constant";
	if (matches(/^variable/)) return "variable";
	if (
		matches(
			/^(punctuation|meta\.embedded|meta\.template|source\.groovy\.embedded)/
		)
	)
		return "punctuation";
	return null;
}

function semanticRole(key) {
	const name = key.toLowerCase();
	if (name.includes("comment")) return "comment";
	if (name.includes("regexp")) return "regex";
	if (name.includes("string")) return "string";
	if (name.includes("number")) return "number";
	if (name.includes("decorator")) return "decorator";
	if (name.includes("namespace")) return "namespace";
	if (name.includes("label")) return "label";
	if (
		name.includes("function") ||
		name.includes("method") ||
		name.includes("customliteral")
	)
		return "function";
	if (
		name.includes("class") ||
		name.includes("enum") ||
		name.includes("interface") ||
		name.includes("struct") ||
		name.includes("type")
	)
		return "type";
	if (name.includes("operator")) return "operator";
	if (name.includes("keyword")) return "keyword";
	if (name.includes("parameter")) return "parameter";
	if (name.includes("property")) return "property";
	if (name.includes("variable")) return "variable";
	return null;
}

function retint(base, web, ide, features, scheme) {
	const colors = { ...base.colors };

	set(
		colors,
		["titleBar.activeBackground", "titleBar.inactiveBackground"],
		ide.titleBar
	);
	set(
		colors,
		["activityBar.background", "activityBarTop.background"],
		ide.activityBar
	);
	set(
		colors,
		["sideBar.background", "sideBarSectionHeader.background"],
		ide.sideBar
	);
	set(colors, ["panel.background"], ide.panel);
	set(
		colors,
		["statusBar.background", "statusBar.noFolderBackground"],
		ide.statusBar
	);
	set(colors, ["breadcrumb.background"], ide.breadcrumb);
	set(colors, ["editor.background", "terminal.background"], ide.editor);
	set(
		colors,
		[
			"editorWidget.background",
			"menu.background",
			"notificationCenterHeader.background",
			"notifications.background",
			"peekViewEditor.background",
			"peekViewResult.background",
			"peekViewTitle.background",
			"quickInput.background",
			"textBlockQuote.background",
			"textCodeBlock.background",
			"welcomePage.tileBackground"
		],
		ide.widget
	);
	set(colors, ["editorGroupHeader.tabsBackground"], ide.tabBar);
	set(
		colors,
		["tab.activeBackground", "tab.unfocusedActiveBackground"],
		ide.tabActive
	);
	set(
		colors,
		["tab.inactiveBackground", "tab.unfocusedInactiveBackground"],
		ide.tabInactive
	);
	set(colors, ["checkbox.background", "input.background"], ide.inputBackground);
	set(colors, ["dropdown.background"], ide.dropdown);
	set(colors, ["badge.background"], ide.badge);
	set(colors, ["badge.foreground"], ide.badgeForeground);
	set(
		colors,
		["actionBar.toggledBackground", "button.secondaryBackground"],
		ide.secondaryButton
	);
	set(colors, ["button.secondaryForeground"], ide.secondaryButtonForeground);
	set(
		colors,
		["button.secondaryHoverBackground", "statusBarItem.compactHoverBackground"],
		ide.secondaryButtonHover
	);
	set(colors, ["button.background"], ide.button);
	set(colors, ["button.foreground"], ide.buttonForeground);
	set(colors, ["button.hoverBackground"], ide.buttonHover);
	set(
		colors,
		[
			"list.activeSelectionIconForeground",
			"panelTitle.activeBorder",
			"progressBar.background",
			"tab.activeBorderTop",
			"tab.selectedBorderTop",
			"terminal.tab.activeBorder"
		],
		ide.focus
	);
	set(
		colors,
		["activityBarBadge.background", "statusBarItem.remoteBackground"],
		ide.badge
	);
	set(
		colors,
		[
			"activityBar.foreground",
			"editor.foreground",
			"foreground",
			"icon.foreground",
			"sideBar.foreground",
			"sideBarSectionHeader.foreground",
			"terminal.foreground"
		],
		ide.foreground
	);
	set(
		colors,
		[
			"dropdown.foreground",
			"input.foreground",
			"keybindingLabel.foreground",
			"menu.foreground",
			"notificationCenterHeader.foreground",
			"notifications.foreground",
			"panelTitle.activeForeground",
			"quickInput.foreground"
		],
		ide.inputForeground
	);
	set(colors, ["dropdown.foreground"], ide.dropdownForeground);
	set(colors, ["titleBar.activeForeground"], ide.titleBarForeground);
	set(colors, ["statusBarItem.remoteForeground"], ide.badgeForeground);
	set(colors, ["activityBarBadge.foreground"], ide.badgeForeground);
	set(
		colors,
		[
			"descriptionForeground",
			"panelTitle.inactiveForeground",
			"sideBarTitle.foreground",
			"welcomePage.progress.foreground"
		],
		ide.mutedForeground
	);
	set(colors, ["activityBar.inactiveForeground"], ide.activityBarInactive);
	set(colors, ["statusBar.foreground"], ide.statusBarForeground);
	set(colors, ["breadcrumb.foreground"], ide.breadcrumbForeground);
	set(colors, ["tab.activeForeground"], ide.tabActiveForeground);
	set(
		colors,
		[
			"tab.inactiveForeground",
			"tab.unfocusedInactiveForeground",
			"titleBar.inactiveForeground"
		],
		ide.tabInactiveForeground
	);
	set(colors, ["input.placeholderForeground"], ide.placeholder);
	set(colors, ["list.hoverBackground"], ide.listHover);
	set(
		colors,
		[
			"editor.inactiveSelectionBackground",
			"editorSuggestWidget.selectedBackground",
			"list.activeSelectionBackground",
			"list.inactiveSelectionBackground",
			"quickInputList.focusBackground",
			"tab.selectedBackground"
		],
		ide.listSelection
	);
	set(
		colors,
		[
			"inputOption.activeForeground",
			"list.activeSelectionForeground",
			"menu.selectionForeground"
		],
		ide.listSelectionForeground
	);
	set(
		colors,
		["tab.hoverBackground", "tab.unfocusedHoverBackground"],
		ide.tabHover
	);
	set(colors, ["tab.selectedForeground"], ide.tabActiveForeground);
	set(colors, ["menu.selectionBackground"], ide.listSelection);
	set(colors, ["list.dropBackground"], ide.dropBackground);
	set(
		colors,
		[
			"activityBar.border",
			"agentsPanel.border",
			"diffEditor.border",
			"editorGroup.border",
			"editorOverviewRuler.border",
			"editorStickyScroll.border",
			"editorHoverWidget.border",
			"editorSuggestWidget.border",
			"editorWidget.border",
			"gauge.border",
			"inlineChat.border",
			"menu.border",
			"notificationCenter.border",
			"notificationToast.border",
			"notifications.border",
			"panel.border",
			"peekView.border",
			"pickerGroup.border",
			"quickInput.border",
			"sideBar.border",
			"sideBarSectionHeader.border",
			"statusBar.border",
			"terminal.border",
			"textBlockQuote.border",
			"titleBar.border",
			"widget.border"
		],
		features.surfaceBorders ? ide.border : transparent
	);
	set(
		colors,
		[
			"agentsChatInput.border",
			"agentsNewSessionButton.border",
			"button.border",
			"button.secondaryBorder",
			"checkbox.border",
			"commandCenter.border",
			"dropdown.border",
			"input.border",
			"panelInput.border",
			"searchEditor.textInputBorder",
			"settings.dropdownBorder",
			"settings.numberInputBorder",
			"settings.textInputBorder"
		],
		features.controlBorders ? ide.inputBorder : transparent
	);
	set(
		colors,
		["editorGroupHeader.tabsBorder", "tab.border", "tab.lastPinnedBorder"],
		features.tabBorders ? ide.tabBorder : transparent
	);
	set(colors, ["tab.activeBorder", "tab.unfocusedActiveBorder"], transparent);
	set(
		colors,
		[
			"tab.activeBorderTop",
			"tab.unfocusedActiveBorderTop",
			"terminal.tab.activeBorder"
		],
		features.activeTabIndicator ? ide.focus : transparent
	);
	set(
		colors,
		[
			"activityBar.activeBorder",
			"activityBar.activeFocusBorder",
			"activityBarTop.activeBorder"
		],
		features.activityBarIndicator ? ide.focus : transparent
	);
	colors["panelTitle.activeBorder"] = features.panelTitleIndicator
		? ide.focus
		: transparent;
	colors.contrastBorder = features.contrastBorders ? ide.border : transparent;
	colors.contrastActiveBorder = features.contrastBorders
		? ide.focus
		: transparent;
	set(
		colors,
		[
			"focusBorder",
			"agentsChatInput.focusBorder",
			"inputOption.activeBorder",
			"list.focusOutline",
			"statusBar.focusBorder",
			"statusBarItem.focusBorder"
		],
		ide.focus
	);
	set(
		colors,
		[
			"editorStickyScroll.shadow",
			"listFilterWidget.shadow",
			"panelStickyScroll.shadow",
			"scrollbar.shadow",
			"sideBarStickyScroll.shadow",
			"widget.shadow"
		],
		features.shadows ? ide.shadow : transparent
	);
	colors["editorLineNumber.foreground"] = ide.lineNumber;
	colors["editorLineNumber.activeForeground"] = ide.activeLineNumber;
	colors["gitDecoration.ignoredResourceForeground"] = ide.ignored;
	set(
		colors,
		[
			"editorSuggestWidget.background",
			"diffEditor.unchangedRegionBackground",
			"dropdown.listBackground",
			"settings.dropdownBackground"
		],
		ide.widget
	);
	set(
		colors,
		["notebook.cellBorderColor", "menu.separatorBackground"],
		ide.separator
	);
	set(colors, ["notebook.selectedCellBackground"], ide.listSelection);
	set(
		colors,
		["list.focusAndSelectionOutline", "inputOption.activeBorder"],
		ide.focus
	);
	set(colors, ["inputOption.activeBackground"], ide.listSelection);
	set(colors, ["pickerGroup.foreground"], ide.mutedForeground);
	set(colors, ["settings.headerForeground"], ide.settingsHeader);
	set(colors, ["settings.modifiedItemIndicator"], ide.settingsModified);
	set(
		colors,
		[
			"peekViewEditor.matchHighlightBackground",
			"peekViewResult.matchHighlightBackground"
		],
		ide.findMatchHighlight
	);
	set(
		colors,
		["statusBarItem.hoverBackground", "statusBarItem.prominentBackground"],
		ide.listHover
	);
	set(colors, ["statusBarItem.hoverForeground"], ide.foreground);
	set(colors, ["statusBarItem.errorBackground"], web.destructive);
	set(colors, ["debugToolBar.background"], ide.debugToolbar);
	set(colors, ["statusBar.debuggingBackground"], ide.debugStatus);
	set(colors, ["statusBar.debuggingForeground"], ide.debugStatusForeground);
	set(colors, ["chat.slashCommandBackground"], ide.chatAccent);
	set(colors, ["chat.slashCommandForeground"], ide.chatAccentForeground);
	set(colors, ["chat.editedFileForeground"], ide.chatEdited);
	set(colors, ["textPreformat.background"], ide.preformatted);
	set(colors, ["textPreformat.foreground"], ide.preformattedForeground);
	set(colors, ["textSeparator.foreground"], ide.separator);

	set(
		colors,
		[
			"editor.selectionBackground",
			"selection.background",
			"terminal.selectionBackground"
		],
		ide.selection
	);
	set(
		colors,
		[
			"editor.selectionHighlightBackground",
			"terminal.inactiveSelectionBackground"
		],
		ide.selectionHighlight
	);
	set(
		colors,
		["editor.wordHighlightBackground", "editor.wordHighlightStrongBackground"],
		ide.wordHighlight
	);
	set(
		colors,
		["editorCursor.foreground", "terminalCursor.foreground"],
		ide.cursor
	);
	set(
		colors,
		["editor.findMatchBackground", "terminal.findMatchBackground"],
		appendAlpha(ide.findMatch, "66")
	);
	set(
		colors,
		[
			"editor.findMatchHighlightBackground",
			"editor.findRangeHighlightBackground",
			"terminal.findMatchHighlightBackground"
		],
		ide.findMatchHighlight
	);
	set(
		colors,
		["editorIndentGuide.background1", "tree.indentGuidesStroke"],
		ide.indentGuide
	);
	set(colors, ["editorIndentGuide.activeBackground1"], ide.activeIndentGuide);
	set(colors, ["editorWhitespace.foreground"], ide.whitespace);
	set(colors, ["editorRuler.foreground"], ide.ruler);
	set(colors, ["editorBracketMatch.border"], ide.bracketMatch);
	colors["editorBracketMatch.background"] = appendAlpha(ide.editor, "00");
	set(colors, ["scrollbarSlider.background"], ide.scrollbar);
	set(colors, ["scrollbarSlider.hoverBackground"], ide.scrollbarHover);
	set(colors, ["scrollbarSlider.activeBackground"], ide.scrollbarActive);
	set(
		colors,
		[
			"editorLink.activeForeground",
			"textLink.activeForeground",
			"textLink.foreground",
			"welcomePage.progress.background"
		],
		ide.link
	);

	const statuses = {
		success: [
			"gitDecoration.addedResourceForeground",
			"gitDecoration.untrackedResourceForeground",
			"ports.iconRunningProcessForeground"
		],
		warning: [
			"editorWarning.foreground",
			"gitDecoration.conflictingResourceForeground",
			"gitDecoration.modifiedResourceForeground",
			"gitDecoration.stageModifiedResourceForeground",
			"problemsWarningIcon.foreground"
		],
		destructive: [
			"editorError.foreground",
			"errorForeground",
			"gitDecoration.deletedResourceForeground",
			"gitDecoration.stageDeletedResourceForeground",
			"problemsErrorIcon.foreground"
		],
		info: [
			"editorInfo.foreground",
			"notificationsInfoIcon.foreground",
			"problemsInfoIcon.foreground"
		]
	};
	for (const [role, keys] of Object.entries(statuses))
		set(colors, keys, web[role]);

	set(colors, ["editorGutter.addedBackground"], ide.gutterAdded);
	set(colors, ["editorGutter.modifiedBackground"], ide.gutterModified);
	set(colors, ["editorGutter.deletedBackground"], ide.gutterDeleted);
	set(
		colors,
		[
			"diffEditor.insertedLineBackground",
			"diffEditor.insertedTextBackground",
			"diffEditorGutter.insertedLineBackground"
		],
		ide.diffInserted
	);
	set(
		colors,
		[
			"diffEditor.removedLineBackground",
			"diffEditor.removedTextBackground",
			"diffEditorGutter.removedLineBackground"
		],
		ide.diffRemoved
	);
	colors["diffEditorOverview.insertedForeground"] = appendAlpha(
		ide.gutterAdded,
		"80"
	);
	colors["diffEditorOverview.removedForeground"] = appendAlpha(
		ide.gutterDeleted,
		"80"
	);

	for (const [ansi, role] of [
		["Red", "destructive"],
		["Green", "success"],
		["Yellow", "warning"],
		["Blue", "info"]
	])
		colors[`terminal.ansi${ansi}`] = web[role];
	set(colors, ["terminal.ansiBlack"], ide.ansiBlack);
	set(colors, ["terminal.ansiMagenta"], ide.ansiMagenta);
	set(colors, ["terminal.ansiCyan"], ide.ansiCyan);
	set(colors, ["terminal.ansiWhite"], ide.ansiWhite);
	set(colors, ["terminal.ansiBrightBlack"], ide.ansiBrightBlack);
	set(colors, ["terminal.ansiBrightRed"], ide.ansiBrightRed);
	set(colors, ["terminal.ansiBrightGreen"], ide.ansiBrightGreen);
	set(colors, ["terminal.ansiBrightYellow"], ide.ansiBrightYellow);
	set(colors, ["terminal.ansiBrightBlue"], ide.ansiBrightBlue);
	set(colors, ["terminal.ansiBrightMagenta"], ide.ansiBrightMagenta);
	set(colors, ["terminal.ansiBrightCyan"], ide.ansiBrightCyan);
	set(colors, ["terminal.ansiBrightWhite"], ide.ansiBrightWhite);

	// Spelled out so every role is greppable; a dead role fails the wiring test.
	const syntax = {
		keyword: ide.keyword,
		operator: ide.operator,
		string: ide.string,
		escape: ide.escape,
		regex: ide.regex,
		number: ide.number,
		function: ide.function,
		decorator: ide.decorator,
		type: ide.type,
		namespace: ide.namespace,
		tag: ide.tag,
		attribute: ide.attribute,
		variable: ide.variable,
		property: ide.property,
		parameter: ide.parameter,
		constant: ide.constant,
		label: ide.label,
		punctuation: ide.punctuation,
		comment: ide.comment
	};

	const tokenColors = base.tokenColors.map((rule) => {
		const scopes = Array.isArray(rule.scope)
			? rule.scope
			: String(rule.scope ?? "")
					.split(",")
					.map((scope) => scope.trim());
		const status = scopes.some((scope) => scope.startsWith("markup.inserted"))
			? "success"
			: scopes.some((scope) => scope.startsWith("markup.deleted"))
				? "destructive"
				: scopes.some(
							(scope) =>
								scope.startsWith("markup.changed") ||
								scope.startsWith("meta.diff")
					  )
					? "warning"
					: scopes.some((scope) => scope.startsWith("invalid"))
						? "destructive"
						: null;
		const role = syntaxRole(scopes);
		const foreground = status ? web[status] : role ? syntax[role] : null;
		if (!role && !foreground) return rule;
		const settings = { ...rule.settings };
		if (foreground && settings.foreground) settings.foreground = foreground;
		return { ...rule, settings };
	});
	const semanticTokenColors = Object.fromEntries(
		Object.entries(base.semanticTokenColors).map(([key, value]) => {
			const role = semanticRole(key);
			if (!role) return [key, value];
			return [
				key,
				typeof value === "string"
					? syntax[role]
					: { ...value, foreground: syntax[role] }
			];
		})
	);

	// Full registry coverage. VS Code registers hundreds of workbench colours
	// beyond the default themes' own sets; anything this generator leaves out
	// falls back to the registry default, which is usually the blue focus
	// colour or a colour no theme ever tuned - so the workbench would show
	// stray blue against a neutral palette. Every ID below maps onto an
	// editable role instead, keeping theme.json the single source. Bracket
	// pairs reuse the syntax roles so nesting never invents a colour the
	// palette does not own.

	// Editor lines, marks and decorations.
	set(
		colors,
		[
			"editor.lineHighlightBackground",
			"editor.inactiveLineHighlightBackground"
		],
		appendAlpha(ide.foreground, "0d")
	);
	set(colors, ["editor.foldBackground"], appendAlpha(ide.foreground, "0a"));
	set(colors, ["editor.foldPlaceholderForeground"], ide.mutedForeground);
	set(
		colors,
		["editor.hoverHighlightBackground"],
		appendAlpha(ide.foreground, "0a")
	);
	set(colors, ["editor.symbolHighlightBackground"], ide.findMatchHighlight);
	set(colors, ["editor.rangeHighlightBackground"], ide.findMatchHighlight);
	set(colors, ["editor.wordHighlightTextBackground"], ide.wordHighlight);
	set(
		colors,
		["editor.stackFrameHighlightBackground"],
		appendAlpha(web.info, "26")
	);
	set(
		colors,
		["editor.focusedStackFrameHighlightBackground"],
		appendAlpha(web.warning, "33")
	);
	set(colors, ["editor.inlineValuesBackground"], appendAlpha(web.info, "0d"));
	set(colors, ["editor.inlineValuesForeground"], web.info);
	set(colors, ["editor.placeholder.foreground"], ide.placeholder);
	set(
		colors,
		["editorGhostText.foreground"],
		appendAlpha(ide.foreground, "40")
	);
	set(colors, ["editorUnicodeHighlight.background"], transparent);
	set(colors, ["editorUnicodeHighlight.border"], ide.bracketMatch);
	set(colors, ["editorLightBulb.foreground"], web.warning);
	set(colors, ["editorLightBulbAutoFix.foreground"], web.info);
	set(colors, ["editorGutter.commentRangeForeground"], ide.mutedForeground);
	set(colors, ["editorGutter.foldingControlForeground"], ide.mutedForeground);
	set(
		colors,
		[
			"editorGutter.addedSecondaryBackground",
			"editorGutter.modifiedSecondaryBackground",
			"editorGutter.deletedSecondaryBackground"
		],
		ide.preformatted
	);
	set(colors, ["editorGutter.itemBackground"], ide.preformatted);
	set(colors, ["editorGutter.itemGlyphForeground"], ide.foreground);
	set(colors, ["editorGutter.commentGlyphForeground"], ide.mutedForeground);
	set(colors, ["editorGutter.commentDraftGlyphForeground"], web.warning);
	set(colors, ["editorGutter.commentUnresolvedGlyphForeground"], web.info);
	set(colors, ["editorStickyScroll.background"], ide.tabBar);
	set(colors, ["editorStickyScrollGutter.background"], ide.tabBar);
	set(colors, ["editorStickyScrollHover.background"], ide.listHover);
	set(colors, ["editorHoverWidget.foreground"], ide.foreground);
	set(colors, ["editorHoverWidget.highlightForeground"], ide.focus);
	set(colors, ["editorHoverWidget.statusBarBackground"], ide.listHover);
	set(colors, ["editorWidget.foreground"], ide.foreground);
	set(colors, ["editorWidget.resizeBorder"], ide.separator);
	set(colors, ["editorActionList.background"], ide.widget);
	set(colors, ["editorActionList.foreground"], ide.inputForeground);
	set(colors, ["editorActionList.focusBackground"], ide.listSelection);
	set(
		colors,
		["editorActionList.focusForeground"],
		ide.listSelectionForeground
	);
	set(colors, ["editorSuggestWidget.foreground"], ide.inputForeground);
	set(
		colors,
		[
			"editorSuggestWidget.selectedIconForeground",
			"editorSuggestWidget.selectedForeground"
		],
		ide.listSelectionForeground
	);
	set(
		colors,
		[
			"editorSuggestWidget.focusHighlightForeground",
			"editorSuggestWidget.highlightForeground"
		],
		ide.focus
	);
	set(colors, ["editorSuggestWidgetStatus.foreground"], ide.mutedForeground);
	set(colors, ["editorGroupHeader.noTabsBackground"], ide.tabBar);
	set(colors, ["editorLineNumber.dimmedForeground"], ide.ignored);

	// Bracket pairs reuse the syntax roles.
	const bracketColors = [
		syntax.keyword,
		syntax.string,
		syntax.number,
		syntax.type,
		web.warning,
		web.destructive
	];
	for (let index = 0; index < 6; index++) {
		colors[`editorBracketHighlight.foreground${index + 1}`] =
			bracketColors[index];
		colors[`editorBracketPairGuide.background${index + 1}`] = appendAlpha(
			bracketColors[index],
			"26"
		);
		colors[`editorBracketPairGuide.activeBackground${index + 1}`] = appendAlpha(
			bracketColors[index],
			"59"
		);
	}
	colors["editorBracketHighlight.unexpectedBracket.foreground"] =
		web.destructive;

	// Overview ruler and minimap markers.
	const rulerMarkers = {
		errorForeground: web.destructive,
		warningForeground: web.warning,
		infoForeground: web.info,
		findMatchForeground: ide.findMatch,
		selectionHighlightForeground: ide.findMatchHighlight,
		wordHighlightForeground: ide.wordHighlight,
		wordHighlightStrongForeground: ide.wordHighlight,
		modifiedForeground: ide.gutterModified,
		addedForeground: ide.gutterAdded,
		deletedForeground: ide.gutterDeleted,
		bracketMatchForeground: ide.bracketMatch,
		commentForeground: ide.comment,
		rangeHighlightForeground: ide.findMatchHighlight,
		currentContentForeground: web.info,
		incomingContentForeground: web.success,
		commonContentForeground: ide.mutedForeground
	};
	for (const [suffix, color] of Object.entries(rulerMarkers))
		colors[`editorOverviewRuler.${suffix}`] = color;
	set(
		colors,
		[
			"minimap.findMatchHighlight",
			"minimap.selectionHighlight",
			"minimap.selectionOccurrenceHighlight"
		],
		ide.findMatchHighlight
	);
	set(colors, ["minimap.errorHighlight"], web.destructive);
	set(colors, ["minimap.warningHighlight"], web.warning);
	set(colors, ["minimap.infoHighlight"], web.info);
	set(colors, ["minimap.chatEditHighlight"], appendAlpha(web.info, "4d"));
	set(colors, ["minimapGutter.addedBackground"], ide.gutterAdded);
	set(colors, ["minimapGutter.modifiedBackground"], ide.gutterModified);
	set(colors, ["minimapGutter.deletedBackground"], ide.gutterDeleted);
	set(colors, ["minimapSlider.background"], ide.scrollbar);
	set(colors, ["minimapSlider.hoverBackground"], ide.scrollbarHover);
	set(colors, ["minimapSlider.activeBackground"], ide.scrollbarActive);

	// Input validation messages.
	for (const [status, color] of [
		["error", web.destructive],
		["warning", web.warning],
		["info", web.info]
	]) {
		colors[`inputValidation.${status}Background`] = appendAlpha(color, "1f");
		colors[`inputValidation.${status}Border`] = color;
		colors[`inputValidation.${status}Foreground`] = ide.foreground;
	}

	// Lists, filters and quick input.
	set(
		colors,
		["list.focusBackground", "list.inactiveFocusBackground"],
		ide.listHover
	);
	set(colors, ["list.focusForeground"], ide.foreground);
	set(
		colors,
		["list.hoverForeground", "list.inactiveSelectionForeground"],
		ide.foreground
	);
	set(colors, ["list.inactiveSelectionIconForeground"], ide.mutedForeground);
	set(
		colors,
		["list.errorForeground", "list.invalidItemForeground"],
		web.destructive
	);
	set(colors, ["list.warningForeground"], web.warning);
	set(
		colors,
		["list.focusHighlightForeground", "list.highlightForeground"],
		ide.focus
	);
	set(colors, ["list.deemphasizedForeground"], ide.ignored);
	set(colors, ["list.filterMatchBackground"], ide.findMatchHighlight);
	set(colors, ["list.filterMatchBorder"], transparent);
	set(colors, ["list.dropBetweenBackground"], ide.separator);
	set(colors, ["list.inactiveFocusOutline"], transparent);
	set(colors, ["listFilterWidget.background"], ide.widget);
	set(colors, ["listFilterWidget.outline"], transparent);
	set(colors, ["listFilterWidget.noMatchesOutline"], web.destructive);
	set(colors, ["quickInput.list.focusBackground"], ide.listSelection);
	set(colors, ["quickInputList.focusForeground"], ide.foreground);
	set(colors, ["quickInputList.focusIconForeground"], ide.foreground);
	set(colors, ["quickInputList.focusHighlightForeground"], ide.focus);

	// Merge editor surfaces.
	set(colors, ["merge.currentHeaderBackground"], appendAlpha(web.info, "26"));
	set(colors, ["merge.currentContentBackground"], appendAlpha(web.info, "1a"));
	set(
		colors,
		["merge.incomingHeaderBackground"],
		appendAlpha(web.success, "26")
	);
	set(
		colors,
		["merge.incomingContentBackground"],
		appendAlpha(web.success, "1a")
	);
	set(
		colors,
		["merge.commonHeaderBackground"],
		appendAlpha(ide.foreground, "1a")
	);
	set(
		colors,
		["merge.commonContentBackground"],
		appendAlpha(ide.foreground, "0f")
	);
	set(colors, ["merge.border"], transparent);

	// Tabs: dirty markers and hover states.
	set(
		colors,
		["tab.activeModifiedBorder", "tab.unfocusedActiveModifiedBorder"],
		web.warning
	);
	set(
		colors,
		["tab.inactiveModifiedBorder", "tab.unfocusedInactiveModifiedBorder"],
		appendAlpha(web.warning, "59")
	);
	set(
		colors,
		["tab.hoverForeground", "tab.unfocusedHoverForeground"],
		ide.foreground
	);
	set(colors, ["tab.dragAndDropBorder"], ide.focus);
	set(colors, ["tab.hoverBorder", "tab.unfocusedHoverBorder"], transparent);

	// Terminal decorations.
	set(colors, ["terminalCommandDecoration.defaultBackground"], ide.separator);
	set(colors, ["terminalCommandDecoration.errorBackground"], web.destructive);
	set(colors, ["terminalCommandDecoration.successBackground"], web.success);
	set(colors, ["terminalCursor.background"], ide.editor);
	set(colors, ["terminal.dropBackground"], ide.dropBackground);

	// Toolbars and drag surfaces.
	set(colors, ["toolbar.hoverBackground"], ide.listHover);
	set(colors, ["toolbar.activeBackground"], ide.listSelection);
	set(colors, ["toolbar.hoverOutline"], transparent);
	set(colors, ["sash.hoverBorder"], ide.focus);
	set(
		colors,
		[
			"profiles.sashBorder",
			"settings.sashBorder",
			"simpleFindWidget.sashBorder"
		],
		ide.separator
	);
	set(colors, ["sideBar.dropBackground"], ide.dropBackground);
	set(colors, ["sideBarStickyScroll.background"], ide.sideBar);
	set(colors, ["sideBarActivityBarTop.border"], transparent);
	set(
		colors,
		["activityBar.dropBorder", "activityBarTop.dropBorder"],
		ide.focus
	);
	set(colors, ["activityBarTop.foreground"], ide.foreground);
	set(colors, ["activityBarTop.inactiveForeground"], ide.activityBarInactive);
	set(colors, ["commandCenter.background"], ide.inputBackground);
	set(colors, ["commandCenter.foreground"], ide.inputForeground);
	set(colors, ["commandCenter.activeBackground"], ide.listSelection);
	set(colors, ["commandCenter.activeForeground"], ide.listSelectionForeground);
	set(colors, ["commandCenter.inactiveForeground"], ide.mutedForeground);
	set(colors, ["commandCenter.debuggingBackground"], ide.debugStatus);

	// Peek view.
	set(colors, ["peekViewEditorGutter.background"], ide.widget);
	set(colors, ["peekViewEditorStickyScroll.background"], ide.widget);
	set(colors, ["peekViewEditorStickyScrollGutter.background"], ide.widget);
	set(colors, ["peekViewResult.fileForeground"], ide.foreground);
	set(colors, ["peekViewResult.lineForeground"], ide.mutedForeground);
	set(colors, ["peekViewResult.selectionBackground"], ide.listSelection);
	set(
		colors,
		["peekViewResult.selectionForeground"],
		ide.listSelectionForeground
	);
	set(colors, ["peekViewTitleDescription.foreground"], ide.mutedForeground);
	set(colors, ["peekViewTitleLabel.foreground"], ide.foreground);
	set(colors, ["breadcrumbPicker.background"], ide.widget);

	// Settings editor.
	set(colors, ["settings.checkboxBackground"], ide.inputBackground);
	set(colors, ["settings.checkboxForeground"], ide.inputForeground);
	set(colors, ["settings.dropdownForeground"], ide.dropdownForeground);
	set(colors, ["settings.dropdownListBorder"], transparent);
	set(colors, ["settings.numberInputBackground"], ide.inputBackground);
	set(colors, ["settings.numberInputForeground"], ide.inputForeground);
	set(colors, ["settings.textInputBackground"], ide.inputBackground);
	set(colors, ["settings.textInputForeground"], ide.inputForeground);
	set(colors, ["settings.rowHoverBackground"], ide.listHover);
	set(colors, ["settings.focusedRowBackground"], ide.listSelection);
	set(colors, ["settings.focusedRowBorder"], transparent);
	set(colors, ["settings.headerBorder"], ide.separator);
	set(colors, ["settings.settingsHeaderHoverForeground"], ide.foreground);

	// Welcome page and walkthroughs.
	set(colors, ["welcomePage.tileBorder"], transparent);
	set(colors, ["welcomePage.tileHoverBackground"], ide.listHover);
	set(colors, ["walkThrough.embeddedEditorBackground"], ide.widget);
	set(colors, ["walkthrough.stepTitle.foreground"], ide.foreground);

	// Status bar items.
	set(colors, ["statusBarItem.activeBackground"], ide.listHover);
	set(colors, ["statusBarItem.errorForeground"], ide.buttonForeground);
	set(colors, ["statusBarItem.errorHoverBackground"], ide.listHover);
	set(colors, ["statusBarItem.errorHoverForeground"], ide.foreground);
	set(colors, ["statusBarItem.warningBackground"], web.warning);
	set(colors, ["statusBarItem.warningForeground"], ide.buttonForeground);
	set(colors, ["statusBarItem.warningHoverBackground"], ide.listHover);
	set(colors, ["statusBarItem.warningHoverForeground"], ide.foreground);
	set(colors, ["statusBarItem.prominentForeground"], ide.foreground);
	set(colors, ["statusBarItem.prominentHoverBackground"], ide.listSelection);
	set(colors, ["statusBarItem.prominentHoverForeground"], ide.foreground);
	set(colors, ["statusBarItem.remoteHoverBackground"], ide.badgeHover);
	set(colors, ["statusBarItem.remoteHoverForeground"], ide.foreground);
	set(colors, ["statusBarItem.offlineBackground"], ide.listSelection);
	set(colors, ["statusBarItem.offlineForeground"], ide.foreground);
	set(colors, ["statusBarItem.offlineHoverBackground"], ide.listHover);
	set(colors, ["statusBarItem.offlineHoverForeground"], ide.foreground);

	// Extension management.
	set(colors, ["extensionButton.background"], ide.inputBackground);
	set(colors, ["extensionButton.foreground"], ide.inputForeground);
	set(colors, ["extensionButton.hoverBackground"], ide.listHover);
	set(colors, ["extensionButton.border"], transparent);
	set(colors, ["extensionButton.separator"], ide.separator);
	set(colors, ["extensionButton.prominentBackground"], ide.button);
	set(colors, ["extensionButton.prominentForeground"], ide.buttonForeground);
	set(colors, ["extensionButton.prominentHoverBackground"], ide.buttonHover);

	// Notebooks.
	set(
		colors,
		["notebook.editorBackground", "notebook.cellEditorBackground"],
		ide.editor
	);
	set(colors, ["notebook.cellHoverBackground"], ide.listHover);
	set(colors, ["notebook.outputContainerBackgroundColor"], ide.preformatted);
	set(colors, ["notebook.outputContainerBorderColor"], ide.separator);
	set(
		colors,
		["notebook.focusedCellBorder", "notebook.focusedEditorBorder"],
		ide.focus
	);
	set(
		colors,
		[
			"notebook.inactiveFocusedCellBorder",
			"notebook.inactiveSelectedCellBorder"
		],
		ide.separator
	);
	set(colors, ["notebook.cellInsertionIndicator"], ide.focus);
	set(colors, ["notebook.cellToolbarSeparator"], ide.separator);
	set(colors, ["notebook.symbolHighlightBackground"], ide.findMatchHighlight);
	set(colors, ["notebookStatusErrorIcon.foreground"], web.destructive);
	set(colors, ["notebookStatusRunningIcon.foreground"], web.info);
	set(colors, ["notebookStatusSuccessIcon.foreground"], web.success);
	set(colors, ["notebookEditorOverviewRuler.runningCellForeground"], web.info);
	set(colors, ["notebookScrollbarSlider.background"], ide.scrollbar);
	set(colors, ["notebookScrollbarSlider.hoverBackground"], ide.scrollbarHover);
	set(
		colors,
		["notebookScrollbarSlider.activeBackground"],
		ide.scrollbarActive
	);

	// Debugging surfaces.
	set(colors, ["debugToolBar.border"], transparent);
	set(
		colors,
		["debugConsole.errorForeground", "debugView.exceptionLabelBackground"],
		web.destructive
	);
	set(colors, ["debugConsole.warningForeground"], web.warning);
	set(colors, ["debugConsole.infoForeground"], web.info);
	set(colors, ["debugConsole.sourceForeground"], ide.mutedForeground);
	set(colors, ["debugConsoleInputIcon.foreground"], ide.foreground);
	set(colors, ["debugExceptionWidget.background"], ide.widget);
	set(colors, ["debugExceptionWidget.border"], transparent);
	set(colors, ["debugView.exceptionLabelForeground"], ide.buttonForeground);
	set(colors, ["debugView.stateLabelBackground"], ide.listSelection);
	set(colors, ["debugView.stateLabelForeground"], ide.foreground);
	set(colors, ["debugView.valueChangedHighlight"], web.warning);
	set(colors, ["debugTokenExpression.boolean"], ide.keyword);
	set(colors, ["debugTokenExpression.number"], ide.number);
	set(colors, ["debugTokenExpression.string"], ide.string);
	set(colors, ["debugTokenExpression.type"], ide.type);
	set(colors, ["debugTokenExpression.name"], ide.foreground);
	set(colors, ["debugTokenExpression.value"], ide.foreground);
	set(colors, ["debugTokenExpression.error"], web.destructive);
	for (const key of [
		"debugIcon.continueForeground",
		"debugIcon.disconnectForeground",
		"debugIcon.pauseForeground",
		"debugIcon.restartForeground",
		"debugIcon.startForeground",
		"debugIcon.stepBackForeground",
		"debugIcon.stepIntoForeground",
		"debugIcon.stepOutForeground",
		"debugIcon.stepOverForeground",
		"debugIcon.stopForeground",
		"debugIcon.breakpointCurrentStackframeForeground",
		"debugIcon.breakpointStackframeForeground"
	])
		colors[key] = ide.foreground;
	set(colors, ["debugIcon.breakpointForeground"], web.destructive);
	set(colors, ["debugIcon.breakpointDisabledForeground"], ide.mutedForeground);
	set(colors, ["debugIcon.breakpointUnverifiedForeground"], web.warning);

	// Data charts and symbol icons - monochrome by default so no
	// workbench surface invents a colour. The registry registers one colour
	// per symbol kind; they are enumerated so a new upstream kind is visible
	// in the generated theme instead of silently falling back to its default.
	set(colors, ["charts.red"], web.destructive);
	set(colors, ["charts.green"], web.success);
	set(colors, ["charts.yellow", "charts.orange"], web.warning);
	set(colors, ["charts.blue"], web.info);
	set(colors, ["charts.purple"], ide.keyword);
	set(colors, ["charts.foreground"], ide.foreground);
	set(colors, ["charts.lines"], ide.mutedForeground);
	for (const key of [
		"symbolIcon.arrayForeground",
		"symbolIcon.booleanForeground",
		"symbolIcon.classForeground",
		"symbolIcon.colorForeground",
		"symbolIcon.constantForeground",
		"symbolIcon.constructorForeground",
		"symbolIcon.enumeratorForeground",
		"symbolIcon.enumeratorMemberForeground",
		"symbolIcon.eventForeground",
		"symbolIcon.fieldForeground",
		"symbolIcon.fileForeground",
		"symbolIcon.folderForeground",
		"symbolIcon.functionForeground",
		"symbolIcon.interfaceForeground",
		"symbolIcon.keyForeground",
		"symbolIcon.keywordForeground",
		"symbolIcon.methodForeground",
		"symbolIcon.moduleForeground",
		"symbolIcon.namespaceForeground",
		"symbolIcon.nullForeground",
		"symbolIcon.numberForeground",
		"symbolIcon.objectForeground",
		"symbolIcon.operatorForeground",
		"symbolIcon.packageForeground",
		"symbolIcon.propertyForeground",
		"symbolIcon.referenceForeground",
		"symbolIcon.snippetForeground",
		"symbolIcon.stringForeground",
		"symbolIcon.structForeground",
		"symbolIcon.textForeground",
		"symbolIcon.typeParameterForeground",
		"symbolIcon.unitForeground",
		"symbolIcon.variableForeground"
	])
		colors[key] = ide.mutedForeground;

	// Git decoration remainder.
	set(colors, ["gitDecoration.renamedResourceForeground"], web.info);
	set(colors, ["gitDecoration.submoduleResourceForeground"], web.info);

	// Diff editor remainder.
	set(colors, ["diffEditor.unchangedRegionForeground"], ide.mutedForeground);
	set(
		colors,
		["diffEditor.unchangedCodeBackground"],
		appendAlpha(ide.foreground, "08")
	);
	set(colors, ["diffEditor.diagonalFill"], ide.separator);

	// Chat and agents.
	set(
		colors,
		["chat.requestBubbleBackground"],
		appendAlpha(ide.foreground, "0d")
	);
	set(
		colors,
		["chat.requestBubbleHoverBackground"],
		appendAlpha(ide.foreground, "14")
	);
	set(colors, ["chat.requestCodeBorder"], ide.separator);
	set(colors, ["chat.checkpointSeparator"], ide.separator);
	set(colors, ["agentsVoice.speakingBackground"], appendAlpha(web.info, "26"));
	set(colors, ["agentsVoice.speakingForeground"], web.info);

	// Remaining surfaces.
	set(colors, ["banner.background"], ide.widget);
	set(colors, ["banner.foreground", "banner.iconForeground"], ide.foreground);
	set(colors, ["checkbox.disabled.background"], ide.preformatted);
	set(colors, ["checkbox.disabled.foreground"], ide.mutedForeground);
	set(colors, ["checkbox.foreground"], ide.inputForeground);
	set(colors, ["tree.inactiveIndentGuidesStroke"], ide.indentGuide);
	set(colors, ["tree.tableColumnsBorder"], ide.separator);
	set(colors, ["tree.tableOddRowsBackground"], ide.preformatted);
	set(
		colors,
		["testing.coveredMinimapBackground"],
		appendAlpha(web.success, "4d")
	);
	set(
		colors,
		["testing.uncoveredMinimapBackground"],
		appendAlpha(web.destructive, "4d")
	);

	return {
		$schema: "vscode://schemas/color-theme",
		name: `Composery ${scheme === "dark" ? "Dark" : "Light"}`,
		type: scheme,
		"//": "Generated from VS Code Modern. Product chrome and syntax follow packages/shared/theme.json; diagnostics, Git, diff, and ANSI status colours share the web status roles.",
		semanticHighlighting: features.semanticHighlighting,
		colors,
		semanticTokenColors,
		tokenColors
	};
}

const config = JSON.parse(await readFile(configPath, "utf8"));
const webTheme = config.web;
const ideFeatures = config.ide.features;
const ideTheme = { light: config.ide.light, dark: config.ide.dark };
const featureNames = [
	"surfaceBorders",
	"controlBorders",
	"tabBorders",
	"shadows",
	"activeTabIndicator",
	"activityBarIndicator",
	"panelTitleIndicator",
	"contrastBorders",
	"semanticHighlighting"
];
const isPalette = (palette) =>
	palette &&
	Object.values(palette).every(
		(value) =>
			typeof value === "string" && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)
	);
const sameKeys = (first, second) =>
	Object.keys(first).length === Object.keys(second).length &&
	Object.keys(first).every((key) => Object.hasOwn(second, key));
if (
	!sameKeys(config, { web: true, ide: true }) ||
	!sameKeys(webTheme, { light: true, dark: true }) ||
	!sameKeys(config.ide, { features: true, light: true, dark: true }) ||
	!sameKeys(webTheme.light, webTheme.dark) ||
	!sameKeys(ideTheme.light, ideTheme.dark) ||
	!isPalette(webTheme.light) ||
	!isPalette(webTheme.dark) ||
	!isPalette(ideTheme.light) ||
	!isPalette(ideTheme.dark) ||
	!sameKeys(
		ideFeatures,
		Object.fromEntries(featureNames.map((name) => [name, true]))
	) ||
	Object.values(ideFeatures).some((value) => typeof value !== "boolean")
)
	throw new Error(
		"theme.json must define matching light/dark web and IDE hex colours plus the supported IDE boolean features"
	);

for (const scheme of ["light", "dark"]) {
	const colors = webTheme[scheme];
	if (
		new Set([colors.success, colors.warning, colors.destructive, colors.info])
			.size !== 4
	)
		throw new Error(`${scheme} status colours must be distinct`);
	for (const [name, foreground, background] of [
		["page text", colors.foreground, colors.background],
		["muted page text", colors.mutedForeground, colors.background],
		["card text", colors.cardForeground, colors.card],
		["muted card text", colors.mutedForeground, colors.card],
		["popover text", colors.popoverForeground, colors.popover],
		["button text", colors.buttonForeground, colors.button],
		[
			"primary button text",
			colors.primaryButtonForeground,
			colors.primaryButton
		],
		[
			"secondary button text",
			colors.secondaryButtonForeground,
			colors.secondaryButton
		],
		["badge text", colors.badgeForeground, colors.badge],
		["field text", colors.fieldForeground, colors.field],
		["selected item text", colors.selectedForeground, colors.selected],
		["dialog text", colors.dialogForeground, colors.dialog]
	])
		if (contrast(foreground, background) < 4.5)
			throw new Error(`${scheme} ${name} must have 4.5:1 contrast`);
}

await emit(
	themeSourcePath,
	`// AUTO-GENERATED by packages/shared/scripts/theme.mjs from theme.json.
// Edit the theme with \`pnpm dev:colors\` or edit theme.json directly.
export const theme = ${JSON.stringify(webTheme, null, "\t")} as const;
export const ideTheme = ${JSON.stringify(ideTheme, null, "\t")} as const;
export const ideFeatures = ${JSON.stringify(ideFeatures, null, "\t")} as const;
`
);

const generatedThemes = {};
for (const scheme of ["light", "dark"]) {
	const modern = await flatten(`${scheme}_modern.json`);
	delete modern.include;
	generatedThemes[scheme] = retint(
		modern,
		webTheme[scheme],
		ideTheme[scheme],
		ideFeatures,
		scheme
	);
	await emit(
		join(outputThemes, `composery-${scheme}.json`),
		`${JSON.stringify(generatedThemes[scheme], null, "\t")}\n`
	);
}

const patchDirectory = join(root, "packages", "ide", "patches");
const patchNames = await readdir(patchDirectory);
const firstPaintPatches = [];
const workbenchPagePatches = [];
for (const name of patchNames) {
	if (!name.endsWith(".diff")) continue;
	const source = await readFile(join(patchDirectory, name), "utf8");
	if (
		source.includes("COLOR_THEME_DARK_INITIAL_COLORS") ||
		source.includes("COLOR_THEME_LIGHT_INITIAL_COLORS")
	)
		firstPaintPatches.push({ name, source });
	if (
		source.includes('meta name="theme-color"') &&
		source.includes("theme_color:")
	)
		workbenchPagePatches.push({ name, source });
}
if (firstPaintPatches.length !== 1)
	throw new Error(
		`expected one first-paint patch, found ${firstPaintPatches.length}`
	);

const firstPaint = firstPaintPatches[0];
const firstPaintLines = [];
let activeScheme = null;
let compared = 0;
for (const line of firstPaint.source.split("\n")) {
	if (line.includes("COLOR_THEME_DARK_INITIAL_COLORS")) activeScheme = "dark";
	else if (line.includes("COLOR_THEME_LIGHT_INITIAL_COLORS"))
		activeScheme = "light";
	else if (activeScheme && /^[ +]};$/.test(line)) activeScheme = null;

	const match =
		activeScheme && line.match(/^([ +])(\t'([^']+)': ')([^']*)(',?)$/);
	if (!match) {
		firstPaintLines.push(line);
		continue;
	}
	const [, sign, head, key, current, tail] = match;
	const wanted = generatedThemes[activeScheme].colors[key];
	if (!wanted) {
		firstPaintLines.push(line);
		continue;
	}
	compared++;
	if (wanted.toLowerCase() === current.toLowerCase()) {
		firstPaintLines.push(line);
		continue;
	}
	if (sign === "+") firstPaintLines.push(`+${head}${wanted}${tail}`);
	else
		firstPaintLines.push(
			`-${head}${current}${tail}`,
			`+${head}${wanted}${tail}`
		);
}
if (compared < 100)
	throw new Error(`first-paint patch exposed only ${compared} theme colours`);
await emitRaw(
	join(patchDirectory, firstPaint.name),
	firstPaintLines.join("\n")
);

if (workbenchPagePatches.length !== 1)
	throw new Error(
		`expected one workbench-page patch, found ${workbenchPagePatches.length}`
	);
const workbenchPage = workbenchPagePatches[0];
const workbenchPagePath = join(patchDirectory, workbenchPage.name);
let workbenchPageSource = workbenchPage.source;
for (const [name, pattern, value] of [
	[
		"light theme-color",
		/(<meta name="theme-color" content=")#[0-9a-f]{6}(" media="\(prefers-color-scheme: light\)")/i,
		ideTheme.light.titleBar
	],
	[
		"dark theme-color",
		/(<meta name="theme-color" content=")#[0-9a-f]{6}(" media="\(prefers-color-scheme: dark\)")/i,
		ideTheme.dark.titleBar
	],
	[
		"light first paint",
		/^(\+\s*html, body \{ background-color: )#[0-9a-f]{6}(; \})$/im,
		ideTheme.light.editor
	],
	[
		"dark first paint",
		/^(\+\s*@media \(prefers-color-scheme: dark\) \{ html, body \{ background-color: )#[0-9a-f]{6}(; \} \})$/im,
		ideTheme.dark.editor
	],
	[
		"manifest theme",
		/(theme_color: ")#[0-9a-f]{6}(")/i,
		ideTheme.dark.titleBar
	],
	[
		"manifest background",
		/(background_color: ")#[0-9a-f]{6}(")/i,
		ideTheme.dark.editor
	]
]) {
	const matches =
		workbenchPageSource.match(
			new RegExp(
				pattern.source,
				pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`
			)
		) ?? [];
	if (matches.length !== 1)
		throw new Error(
			`${name}: expected one patch literal, found ${matches.length}`
		);
	workbenchPageSource = workbenchPageSource.replace(pattern, `$1${value}$2`);
}
await emitRaw(workbenchPagePath, workbenchPageSource);

if (check && stale.length)
	throw new Error(
		`Theme outputs are stale; run \`pnpm fix:assets\`:\n${stale
			.map((path) => `  ${path}`)
			.join("\n")}`
	);
