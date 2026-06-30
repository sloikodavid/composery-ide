import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, test, vi } from "vitest";

import { theme } from "../../../index.ts";

const host = vi.hoisted<{
	current: Map<string, string>;
	readiness: string;
	writes: Array<{ path: string; contents: string }>;
}>(() => ({
	current: new Map(),
	readiness:
		"const page = '<style>body{margin:0;background:#111111;color:#222222}@media (prefers-color-scheme:dark){body{background:#333333;color:#444444}}</style>';",
	writes: []
}));

const pageThemeMeta = `<meta
	name="theme-color"
	content="#111111"
	media="(prefers-color-scheme: light)"
/>
<meta
	name="theme-color"
	content="#222222"
	media="(prefers-color-scheme: dark)"
/>`;

vi.mock("node:fs/promises", () => ({
	readFile: (path: string, encoding: string) => {
		if (encoding !== "utf8")
			throw new Error(`Unexpected encoding: ${encoding}`);
		const normalized = path.replaceAll("\\", "/");
		if (host.current.has(normalized))
			return Promise.resolve(host.current.get(normalized));
		if (normalized.endsWith("/persistence/readiness.ts"))
			return Promise.resolve(host.readiness);
		if (
			normalized.endsWith("/pages/auth.html") ||
			normalized.endsWith("/pages/error.html")
		)
			return Promise.resolve(pageThemeMeta);
		return Promise.resolve(null);
	},
	writeFile: (path: string, contents: string) => {
		host.writes.push({ path, contents });
		return Promise.resolve();
	}
}));

vi.mock("../../../../../scripts/write-formatted.mjs", () => ({
	formatContent: (_path: string, contents: string) => Promise.resolve(contents)
}));

const slash = (path: string) => path.replaceAll("\\", "/");
const repoRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../.."
);

async function run(check = false) {
	host.writes.length = 0;
	vi.resetModules();
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
	const {
		syncAssets
	}: { syncAssets: (options: { check: boolean }) => Promise<void> } =
		// @ts-expect-error The behavior-tested JavaScript entry point has no declaration file.
		await import("../../../scripts/sync.mjs");
	const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
	try {
		await syncAssets({ check });
		return log.mock.calls;
	} finally {
		log.mockRestore();
	}
}

function output(path: RegExp) {
	const match = host.writes.find((entry) => path.test(slash(entry.path)));
	expect(match).not.toBeUndefined();
	return match?.contents ?? "";
}

beforeEach(() => {
	host.current = new Map();
});

describe("text brand asset generator", () => {
	test("derives CSS, favicons, and startup literals from one theme", async () => {
		const logs = await run();

		expect(
			host.writes.map(({ path }) =>
				slash(path).replace(/^.*\/packages\//, "packages/")
			)
		).toEqual([
			"packages/web/app/brand.css",
			"packages/ide/overlay/lib/vscode/extensions/composery-ssh/prompt.js",
			"packages/ide/overlay/src/browser/pages/auth.html",
			"packages/ide/overlay/src/browser/pages/error.html",
			"packages/ide/overlay/src/browser/pages/brand.css",
			"packages/ide/overlay/src/node/persistence/readiness.ts",
			"packages/web/app/icon.svg",
			"packages/web/public/icon-light.svg",
			"packages/web/public/icon-dark.svg",
			"packages/ide/overlay/src/browser/media/favicon.svg",
			"packages/ide/overlay/src/browser/media/favicon-light.svg",
			"packages/ide/overlay/src/browser/media/favicon-dark.svg"
		]);
		expect(slash(host.writes[0]!.path)).toBe(
			`${slash(repoRoot)}/packages/web/app/brand.css`
		);

		const webCss = output(/packages\/web\/app\/brand\.css$/);
		expect(webCss).toContain(`:root {
	--background: ${theme.light.background};
	--foreground: ${theme.light.foreground};
	--header: ${theme.light.header};
	--header-foreground: ${theme.light.headerForeground};`);
		expect(webCss).toContain(`.dark {
	--background: ${theme.dark.background};
	--foreground: ${theme.dark.foreground};
	--header: ${theme.dark.header};`);
		for (const page of ["auth", "error"])
			expect(
				output(
					new RegExp(`packages/ide/overlay/src/browser/pages/${page}\\.html$`)
				)
			).toContain(`content="${theme.light.background}"
	media="(prefers-color-scheme: light)"`);

		const ideCss = output(
			/packages\/ide\/overlay\/src\/browser\/pages\/brand\.css$/
		);
		expect(ideCss).toContain(`	--vscode-button-background: ${theme.light.button};
	--vscode-button-foreground: ${theme.light.buttonForeground};
	--vscode-button-hoverBackground: ${theme.light.buttonHover};
	--vscode-focusBorder: ${theme.light.ring};
	--vscode-editor-background: ${theme.light.background};
	--vscode-editorHoverWidget-background: ${theme.light.popover};
	--vscode-editorHoverWidget-border: ${theme.light.border};
	--vscode-editorHoverWidget-foreground: ${theme.light.popoverForeground};
	--vscode-errorForeground: ${theme.light.destructive};
	--vscode-descriptionForeground: ${theme.light.mutedForeground};
	--auth-success: ${theme.light.success};
	--auth-warning: ${theme.light.warning};
	--auth-input-focus: ${theme.light.ring};
	--vscode-foreground: ${theme.light.foreground};
	--vscode-input-background: ${theme.light.field};
	--vscode-input-border: ${theme.light.fieldBorder};
	--vscode-input-foreground: ${theme.light.fieldForeground};
	--vscode-toolbar-activeBackground: ${theme.light.mutedForeground}50;
	--vscode-toolbar-hoverBackground: ${theme.light.hover};
	--vscode-shadow-hover: 0 2px 8px ${theme.light.shadow};
	--composery-selection: ${theme.light.selection};
	--composery-scrollbar-track: ${theme.light.scrollbarTrack};
	--composery-scrollbar: ${theme.light.scrollbar};
	--composery-scrollbar-hover: ${theme.light.scrollbarHover};
	--composery-scrollbar-active: ${theme.light.scrollbarActive};`);
		expect(ideCss).toContain(`		--vscode-button-background: ${theme.dark.button};
		--vscode-button-foreground: ${theme.dark.buttonForeground};
		--vscode-button-hoverBackground: ${theme.dark.buttonHover};
		--vscode-focusBorder: ${theme.dark.ring};
		--vscode-editor-background: ${theme.dark.background};
		--vscode-editorHoverWidget-background: ${theme.dark.popover};`);
		expect(ideCss).toContain(
			`--vscode-shadow-hover: 0 2px 8px ${theme.dark.shadow};`
		);
		expect(
			output(/packages\/ide\/overlay\/src\/node\/persistence\/readiness\.ts$/)
		).toBe(
			`const page = '<style>body{margin:0;background:${theme.light.background};color:${theme.light.foreground}}@media (prefers-color-scheme:dark){body{background:${theme.dark.background};color:${theme.dark.foreground}}}</style>';`
		);

		expect(output(/packages\/web\/app\/icon\.svg$/)).toMatch(
			new RegExp(
				`^<svg width="256" height="256" viewBox="0 0 20 20" fill="none" xmlns="http://www\\.w3\\.org/2000/svg"><style>svg\\{color:${theme.light.foreground}\\}@media \\(prefers-color-scheme:dark\\)\\{svg\\{color:${theme.dark.foreground}\\}\\}<\\/style>`
			)
		);
		expect(output(/packages\/web\/public\/icon-light\.svg$/)).toContain(
			`color="${theme.light.foreground}"`
		);
		expect(output(/packages\/web\/public\/icon-dark\.svg$/)).toContain(
			`color="${theme.dark.foreground}"`
		);
		expect(
			output(/packages\/ide\/overlay\/src\/browser\/media\/favicon\.svg$/)
		).toMatch(
			new RegExp(
				`^<svg width="100%" height="100%" viewBox="0 0 20 20".*<style>svg\\{color:${theme.light.foreground}\\}`
			)
		);
		expect(
			output(/packages\/ide\/overlay\/src\/browser\/media\/favicon-light\.svg$/)
		).toContain('<svg width="100%" height="100%"');
		expect(
			output(/packages\/ide\/overlay\/src\/browser\/media\/favicon-dark\.svg$/)
		).toContain(`color="${theme.dark.foreground}"`);

		expect(logs).toEqual([["Synced generated brand CSS and SVGs."]]);
	});

	test("refuses an ambiguous literal instead of silently changing one copy", async () => {
		const original = host.readiness;
		host.readiness = `${original}\n${original}`;
		try {
			await expect(run()).rejects.toThrow(
				"startup light: expected one palette literal, found 2"
			);
		} finally {
			host.readiness = original;
		}
	});

	test("names every ambiguous source literal in its failure", async () => {
		const originalReadiness = host.readiness;
		const cases = [
			{
				extra:
					"@media (prefers-color-scheme:dark){body{background:#999999;color:#aaaaaa",
				message: "startup dark: expected one palette literal, found 2"
			}
		];
		try {
			for (const { extra, message } of cases) {
				host.readiness = `${originalReadiness}\n${extra}`;
				await expect(run()).rejects.toThrow(message);
			}
		} finally {
			host.readiness = originalReadiness;
		}
	});

	test("rejects a missing source literal before emitting a partial replacement", async () => {
		const original = host.readiness;
		host.readiness = original.replace("body{margin:0", "body{padding:0");
		try {
			await expect(run()).rejects.toThrow(
				"startup light: expected one palette literal, found 0"
			);
		} finally {
			host.readiness = original;
		}
	});

	test("check mode reports stale outputs without writing replacements", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation(((
			code?: number
		) => {
			throw new Error(`exit ${code}`);
		}) as never);
		const error = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		try {
			await expect(run(true)).rejects.toThrow("exit 1");
			expect(exit).toHaveBeenCalledWith(1);
			expect(error).toHaveBeenCalledWith(
				expect.stringMatching(
					/^Brand assets are stale - run `pnpm fix:assets`:\n {2}packages/
				)
			);
			const message = error.mock.calls[0]?.[0] as string;
			expect(message.split("\n")).toHaveLength(13);
			expect(host.writes).toEqual([]);
		} finally {
			exit.mockRestore();
			error.mockRestore();
		}
	});

	test("check mode reports current outputs without writing replacements", async () => {
		await run();
		host.current = new Map(
			host.writes.map(({ path, contents }) => [slash(path), contents])
		);

		const logs = await run(true);

		expect(logs).toEqual([["Brand assets are up to date."]]);
		expect(host.writes).toEqual([]);
	});
});
