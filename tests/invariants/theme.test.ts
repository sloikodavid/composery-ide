// The shape of the committed theme source. `packages/shared/scripts/theme.mjs
// --check` already
// proves the generated artifacts match `theme.json`, so this is not that: it
// constrains the source itself - every editable value canonical hex, light and
// dark carrying the same keys - because a generator propagates a malformed value
// as happily as a good one and reports success either way.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

import {
	BRAND_IDE_FEATURES,
	BRAND_IDE_THEME,
	BRAND_THEME
} from "../../packages/shared/index.ts";
import { readRepoFile, repoRoot } from "../support/repo.ts";
const schemes = ["light", "dark"] as const;

const source = JSON.parse(
	readFileSync(resolve(repoRoot, "packages/shared/theme.json"), "utf8")
) as {
	web: typeof BRAND_THEME;
	ide: {
		features: typeof BRAND_IDE_FEATURES;
		light: typeof BRAND_IDE_THEME.light;
		dark: typeof BRAND_IDE_THEME.dark;
	};
};

function composite(
	color: string,
	background: string
): [number, number, number] {
	const match = /^#(..)(..)(..)(..)?$/i.exec(color);
	const backdrop = /^#(..)(..)(..)/i.exec(background);
	if (!match || !backdrop) throw new Error(`not a hex colour: ${color}`);
	const alpha = match[4] ? parseInt(match[4], 16) / 255 : 1;
	return [1, 2, 3].map((index) =>
		Math.round(
			parseInt(match[index]!, 16) * alpha +
				parseInt(backdrop[index]!, 16) * (1 - alpha)
		)
	) as [number, number, number];
}

function luminance(channels: [number, number, number]): number {
	const [r, g, b] = channels.map((value) => {
		const channel = value / 255;
		return channel <= 0.03928
			? channel / 12.92
			: ((channel + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(foreground: string, background: string): number {
	const first = luminance(composite(foreground, background));
	const second = luminance(composite(background, background));
	return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe("shared theme", () => {
	test("the editable source is exported without a second copy", () => {
		expect(BRAND_THEME).toEqual(source.web);
		expect(BRAND_IDE_THEME).toEqual({
			light: source.ide.light,
			dark: source.ide.dark
		});
		expect(BRAND_IDE_FEATURES).toEqual(source.ide.features);
	});

	test("both schemes expose the same website and IDE roles", () => {
		expect(Object.keys(BRAND_THEME.light)).toEqual(
			Object.keys(BRAND_THEME.dark)
		);
		expect(Object.keys(BRAND_IDE_THEME.light)).toEqual(
			Object.keys(BRAND_IDE_THEME.dark)
		);
	});

	// One state system, expressed as relationships rather than values. The
	// relationship is a *raise*: the transient overlays darken in light and
	// lighten in dark, and the solid fills sit between their scheme's
	// background and foreground. What must not drift is the relationship, and
	// it holds in both modes at once when the same band applies to both - a
	// fill that collapses into its surface in one mode is a half-drift even if
	// the other mode still looks right. The band is deliberately not an
	// equality: dark themes need a stronger raise than light themes for the
	// same visible lift, because their luminance scale is compressed, so
	// forcing identical ratios is what ruins the dark scheme.
	test("state relationships are identical across schemes", () => {
		const share = (background: string, foreground: string, value: string) => {
			const channel = (hex: string, index: number) =>
				parseInt(hex.slice(index * 2 - 1, index * 2 + 1), 16);
			const ratios = [1, 2, 3].map(
				(index) =>
					(channel(value, index) - channel(background, index)) /
					(channel(foreground, index) - channel(background, index))
			);
			return ratios.reduce((sum, ratio) => sum + ratio, 0) / 3;
		};
		// The band: raised above the surface it sits on (the card role sits at
		// ~0.04 in dark), but still a fill, not a wall. Both bounds apply to
		// both modes.
		const MIN_RAISE = 0.04;
		const MAX_RAISE = 0.2;

		for (const role of ["muted", "selected", "badge"] as const)
			for (const scheme of ["light", "dark"] as const)
				expect(
					share(
						BRAND_THEME[scheme].background,
						BRAND_THEME[scheme].foreground,
						BRAND_THEME[scheme][role]
					),
					`${role} ${scheme} fill raise`
				).toBeGreaterThanOrEqual(MIN_RAISE);
		for (const role of [
			"listHover",
			"listSelection",
			"tabHover",
			"badge"
		] as const)
			for (const scheme of ["light", "dark"] as const)
				expect(
					share(
						BRAND_IDE_THEME[scheme].editor,
						BRAND_IDE_THEME[scheme].foreground,
						BRAND_IDE_THEME[scheme][role]
					),
					`${role} ${scheme} IDE fill raise`
				).toBeGreaterThanOrEqual(MIN_RAISE);
		// The fills are not a single unbroken ramp either: a role that swallows
		// its foreground would read as a solid block, not a raised surface.
		for (const scheme of ["light", "dark"] as const) {
			expect(
				share(
					BRAND_THEME[scheme].background,
					BRAND_THEME[scheme].foreground,
					BRAND_THEME[scheme].selected
				),
				`selected ${scheme} fill cap`
			).toBeLessThanOrEqual(MAX_RAISE);
			expect(
				share(
					BRAND_IDE_THEME[scheme].editor,
					BRAND_IDE_THEME[scheme].foreground,
					BRAND_IDE_THEME[scheme].listSelection
				),
				`listSelection ${scheme} IDE fill cap`
			).toBeLessThanOrEqual(MAX_RAISE);
		}

		// The transient overlays: each sits on the far pole of its scheme -
		// black over light, white over dark - so it always darkens or lightens
		// its surface rather than repainting it, and its alpha stays in the
		// subtle band in both modes. A hover that became a solid repaint would
		// fail the pole check; one that faded to nothing would fail the band.
		for (const role of ["hover", "focus"] as const) {
			for (const scheme of ["light", "dark"] as const) {
				const value = BRAND_THEME[scheme][role];
				expect(
					parseInt(value.slice(7, 9), 16) / 255,
					`${role} ${scheme} overlay alpha`
				).toBeGreaterThanOrEqual(0.03);
				expect(
					parseInt(value.slice(7, 9), 16) / 255,
					`${role} ${scheme} overlay alpha`
				).toBeLessThanOrEqual(0.2);
				expect(value.slice(1, 7), `${role} ${scheme} overlay pole`).toBe(
					scheme === "light" ? "000000" : "ffffff"
				);
			}
		}
	});

	// Two buttons are surfaces, not fills: the secondary button is the chrome
	// (header/footer) surface, and the outline button is the page background
	// showing through - so it stays visible on any card in both modes without
	// ever becoming a new fill. Pinning the equalities is what the raise band
	// did for the fills, so a future palette cannot quietly give either button
	// a colour of its own again.
	test("secondary buttons are the chrome surface in both schemes", () => {
		for (const scheme of schemes) {
			expect(BRAND_THEME[scheme].secondaryButton).toBe(
				BRAND_THEME[scheme].header
			);
			expect(BRAND_IDE_THEME[scheme].secondaryButton).toBe(
				BRAND_THEME[scheme].header
			);
		}
	});

	test("outline buttons are the page background in both schemes", () => {
		for (const scheme of schemes)
			expect(BRAND_THEME[scheme].outlineButton).toBe(
				BRAND_THEME[scheme].background
			);
	});

	test("every editable value is canonical hex or hex-alpha", () => {
		// Typed at the entry point: the parsed JSON widens to `any` inside a bare
		// Object.values walk, which silently disables every check below it.
		const areas: Array<Record<string, Record<string, string>>> = [
			source.web,
			{ light: source.ide.light, dark: source.ide.dark }
		];
		for (const area of areas)
			for (const values of Object.values(area))
				for (const color of Object.values(values))
					expect(color).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
	});

	test("every IDE feature is a boolean", () => {
		for (const feature of Object.values(BRAND_IDE_FEATURES))
			expect(typeof feature).toBe("boolean");
	});

	test.each(schemes)("%s status roles are distinct", (scheme) => {
		const colors = BRAND_THEME[scheme];
		expect(
			new Set([colors.success, colors.warning, colors.destructive, colors.info])
				.size
		).toBe(4);
	});

	test.each(schemes)("%s normal text meets WCAG AA contrast", (scheme) => {
		const colors = BRAND_THEME[scheme];
		for (const [name, foreground, background] of [
			["page", colors.foreground, colors.background],
			["header", colors.headerForeground, colors.header],
			["footer", colors.footerForeground, colors.footer],
			["sidebar", colors.sidebarForeground, colors.sidebar],
			["muted page", colors.mutedForeground, colors.background],
			["card", colors.cardForeground, colors.card],
			["muted card", colors.mutedForeground, colors.card],
			["dialog", colors.dialogForeground, colors.dialog],
			["popover", colors.popoverForeground, colors.popover],
			["button", colors.buttonForeground, colors.button],
			["primary button", colors.primaryButtonForeground, colors.primaryButton],
			[
				"secondary button",
				colors.secondaryButtonForeground,
				colors.secondaryButton
			],
			["badge", colors.badgeForeground, colors.badge],
			["field", colors.fieldForeground, colors.field],
			["selected item", colors.selectedForeground, colors.selected]
		] as const)
			expect(contrast(foreground, background), name).toBeGreaterThanOrEqual(
				4.5
			);
	});
});

describe("generated editor themes", () => {
	const readTheme = (scheme: (typeof schemes)[number]) =>
		JSON.parse(
			readRepoFile(
				`packages/ide/overlay/lib/vscode/extensions/composery-themes/themes/composery-${scheme}.json`
			)
		) as {
			semanticHighlighting: boolean;
			colors: Record<string, string>;
			semanticTokenColors: Record<string, string | { foreground?: string }>;
			tokenColors: {
				name?: string;
				scope?: string | string[];
				settings?: { foreground?: string };
			}[];
		};

	test.each(schemes)(
		"%s diagnostics, Git decorations, and ANSI statuses share product roles",
		(scheme) => {
			const theme = readTheme(scheme);
			const colors = BRAND_THEME[scheme];
			for (const [role, keys] of [
				[
					"success",
					[
						"gitDecoration.addedResourceForeground",
						"gitDecoration.untrackedResourceForeground",
						"terminal.ansiGreen"
					]
				],
				[
					"warning",
					[
						"editorWarning.foreground",
						"gitDecoration.conflictingResourceForeground",
						"terminal.ansiYellow"
					]
				],
				[
					"destructive",
					[
						"editorError.foreground",
						"gitDecoration.deletedResourceForeground",
						"terminal.ansiRed"
					]
				],
				[
					"info",
					[
						"editorInfo.foreground",
						"notificationsInfoIcon.foreground",
						"terminal.ansiBlue"
					]
				]
			] as const)
				for (const key of keys)
					expect(theme.colors[key], `${role}: ${key}`).toBe(colors[role]);
		}
	);

	test("every IDE role is wired, and nothing is wired that is not a role", () => {
		const generator = readRepoFile("packages/shared/scripts/theme.mjs");
		const consumed = new Set(
			[...generator.matchAll(/\bide\.([A-Za-z0-9]+)\b/g)].map(
				(match) => match[1]!
			)
		);

		expect(
			Object.keys(BRAND_IDE_THEME.light).filter((role) => !consumed.has(role))
		).toEqual([]);
	});

	test("every emitted workbench color ID exists in the pinned upstream", () => {
		// The color registry is an external API owned by the pinned VS Code fork.
		// Some IDs are registered by core, some by bundled extensions, and a few
		// are supplied by upstream default themes. Reading all three actual
		// contribution surfaces avoids maintaining another hand-written list.
		const ids = Object.keys(readTheme("light").colors);
		const directory = mkdtempSync(join(tmpdir(), "composery-theme-"));
		const patterns = join(directory, "ids.txt");
		writeFileSync(
			patterns,
			ids.flatMap((id) => [`'${id}'`, `"${id}"`]).join("\n")
		);
		let upstream: string;
		try {
			upstream = execFileSync(
				"git",
				[
					"grep",
					"-F",
					"-f",
					patterns,
					"--",
					"src",
					"extensions/git",
					"extensions/theme-defaults/themes"
				],
				{
					cwd: resolve(repoRoot, "packages/ide/upstream/lib/vscode"),
					encoding: "utf8",
					maxBuffer: 16 * 1024 * 1024
				}
			);
		} finally {
			rmSync(directory, { recursive: true });
		}

		expect(
			ids.filter(
				(id) => !upstream.includes(`'${id}'`) && !upstream.includes(`"${id}"`)
			)
		).toEqual([]);
	});

	test.each(schemes)("%s applies the editable VS Code features", (scheme) => {
		const generated = readTheme(scheme);
		const colors = BRAND_IDE_THEME[scheme];
		const optional = (enabled: boolean, color: string) =>
			enabled ? color : "#00000000";
		expect(generated.semanticHighlighting).toBe(
			BRAND_IDE_FEATURES.semanticHighlighting
		);
		expect(generated.colors["activityBar.border"]).toBe(
			optional(BRAND_IDE_FEATURES.surfaceBorders, colors.border)
		);
		expect(generated.colors["input.border"]).toBe(
			optional(BRAND_IDE_FEATURES.controlBorders, colors.inputBorder)
		);
		expect(generated.colors["tab.border"]).toBe(
			optional(BRAND_IDE_FEATURES.tabBorders, colors.tabBorder)
		);
		expect(generated.colors["widget.shadow"]).toBe(
			optional(BRAND_IDE_FEATURES.shadows, colors.shadow)
		);
		expect(generated.colors["tab.activeBorderTop"]).toBe(
			optional(BRAND_IDE_FEATURES.activeTabIndicator, colors.focus)
		);
		expect(generated.colors["activityBar.activeBorder"]).toBe(
			optional(BRAND_IDE_FEATURES.activityBarIndicator, colors.focus)
		);
		expect(generated.colors["panelTitle.activeBorder"]).toBe(
			optional(BRAND_IDE_FEATURES.panelTitleIndicator, colors.focus)
		);
		expect(generated.colors.contrastBorder).toBe(
			optional(BRAND_IDE_FEATURES.contrastBorders, colors.border)
		);
	});

	test.each(schemes)(
		"%s workbench and terminal neutrals follow the editable IDE roles",
		(scheme) => {
			const theme = readTheme(scheme);
			const colors = BRAND_IDE_THEME[scheme];
			for (const [role, keys] of [
				["titleBar", ["titleBar.activeBackground"]],
				["activityBar", ["activityBar.background"]],
				["sideBar", ["sideBar.background"]],
				["statusBar", ["statusBar.background"]],
				["editor", ["editor.background", "terminal.background"]],
				["widget", ["editorWidget.background", "quickInput.background"]],
				["tabActive", ["tab.activeBackground"]],
				["tabInactive", ["tab.inactiveBackground"]],
				["listHover", ["list.hoverBackground"]],
				["listSelection", ["quickInputList.focusBackground"]],
				["foreground", ["editor.foreground", "terminal.foreground"]],
				["mutedForeground", ["descriptionForeground"]],
				["border", ["editorWidget.border", "widget.border"]],
				["inputBorder", ["input.border"]],
				["focus", ["focusBorder"]],
				["shadow", ["widget.shadow"]],
				["button", ["button.background"]],
				["buttonForeground", ["button.foreground"]],
				["lineNumber", ["editorLineNumber.foreground"]],
				["ignored", ["gitDecoration.ignoredResourceForeground"]],
				["gutterAdded", ["editorGutter.addedBackground"]],
				["gutterDeleted", ["editorGutter.deletedBackground"]],
				["selection", ["editor.selectionBackground"]],
				["cursor", ["editorCursor.foreground"]],
				["scrollbar", ["scrollbarSlider.background"]],
				["link", ["textLink.foreground"]],
				["ansiBlack", ["terminal.ansiBlack"]],
				["ansiMagenta", ["terminal.ansiMagenta"]],
				["ansiCyan", ["terminal.ansiCyan"]],
				["ansiWhite", ["terminal.ansiWhite"]],
				["ansiBrightBlack", ["terminal.ansiBrightBlack"]],
				["ansiBrightRed", ["terminal.ansiBrightRed"]],
				["ansiBrightWhite", ["terminal.ansiBrightWhite"]]
			] as const)
				for (const key of keys)
					expect(theme.colors[key], `${role}: ${key}`).toBe(colors[role]);
		}
	);

	test.each(schemes)("%s syntax follows the editable IDE roles", (scheme) => {
		const theme = readTheme(scheme);
		const colors = BRAND_IDE_THEME[scheme];
		const ruleFor = (scope: string) =>
			theme.tokenColors.find((rule) => {
				const scopes = Array.isArray(rule.scope) ? rule.scope : [rule.scope];
				return scopes.includes(scope);
			});
		const functionRule = theme.tokenColors.find(
			(rule) => rule.name === "Function declarations"
		);

		expect(functionRule?.settings?.foreground).toBe(colors.function);
		expect(ruleFor("constant.numeric")?.settings?.foreground).toBe(
			colors.number
		);
		expect(ruleFor("comment")?.settings?.foreground).toBe(colors.comment);
		expect(ruleFor("string")?.settings?.foreground).toBe(colors.string);
		expect(theme.semanticTokenColors.numberLiteral).toBe(colors.number);
		expect(theme.semanticTokenColors.stringLiteral).toBe(colors.string);
	});
});
