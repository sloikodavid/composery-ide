import { Buffer } from "node:buffer";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, test, vi } from "vitest";

import { BRAND_COLORS } from "../../../index.ts";

const host = vi.hoisted<{
	capHeight: number | undefined;
	extremeBounds: boolean;
	formatted: Array<{ path: string; contents: string }>;
	writes: Array<{ path: string; contents: string }>;
}>(() => ({
	capHeight: 800,
	extremeBounds: false,
	formatted: [],
	writes: []
}));

vi.mock("node:fs/promises", () => ({
	writeFile: (path: string, contents: string) => {
		host.writes.push({ path, contents });
		return Promise.resolve();
	}
}));

vi.mock("fontkit", () => ({
	create: () => ({
		unitsPerEm: 1000,
		capHeight: host.capHeight,
		ascent: 600,
		layout: (text: string) => {
			if (text !== "Composery")
				throw new Error(`Unexpected logo text: ${text}`);
			return {
				glyphs: host.extremeBounds
					? [
							{
								path: {
									bbox: {
										minX: -3000,
										maxX: -100,
										minY: -1000,
										maxY: 2000
									},
									toSVG: () => "M0 0L1 1"
								}
							},
							{
								path: {
									bbox: {
										minX: -200,
										maxX: -100,
										minY: -500,
										maxY: 1500
									},
									toSVG: () => "M2 2L3 3"
								}
							}
						]
					: [
							{
								path: {
									bbox: { minX: 0, maxX: 500, minY: -100, maxY: 700 },
									toSVG: () => "M0 0L1 1"
								}
							},
							{
								path: {
									bbox: { minX: 10, maxX: 400, minY: -50, maxY: 680 },
									toSVG: () => "M2 2L3 3"
								}
							}
						],
				positions: host.extremeBounds
					? [{ xAdvance: 0 }, { xAdvance: 0 }]
					: [{ xAdvance: 600 }, { xAdvance: 500 }]
			};
		}
	})
}));

vi.mock("../../../../../scripts/write-formatted.mjs", () => ({
	writeFormatted: (path: string, contents: string) => {
		host.formatted.push({ path, contents });
		return Promise.resolve();
	}
}));

vi.stubGlobal("fetch", (url: string) => {
	if (
		url !== "https://rsms.me/inter/font-files/InterDisplay-SemiBold.woff2?v=4.1"
	)
		throw new Error(`Unexpected font URL: ${url}`);
	return Promise.resolve({
		arrayBuffer: () => Promise.resolve(Buffer.from("fixture-font"))
	});
});

const slash = (path: string) => path.replaceAll("\\", "/");
const repoRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../.."
);

async function generate(capHeight: number | undefined, extremeBounds = false) {
	host.capHeight = capHeight;
	host.extremeBounds = extremeBounds;
	host.formatted.length = 0;
	host.writes.length = 0;
	vi.resetModules();
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
	const { generateLogo }: { generateLogo: () => Promise<void> } =
		// @ts-expect-error The behavior-tested JavaScript entry point has no declaration file.
		await import("../../../scripts/logo.mjs");
	const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
	await generateLogo();
	const logs = log.mock.calls;
	log.mockRestore();

	expect(host.formatted).toHaveLength(1);
	expect(host.writes).toHaveLength(1);
	return {
		data: host.formatted[0]!,
		logs,
		svg: host.writes[0]!
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("outlined logo generator", () => {
	test("outlines the brand text and emits one shared geometry for web and IDE", async () => {
		const { data, logs, svg } = await generate(800);

		expect(slash(data.path)).toBe(
			`${slash(repoRoot)}/packages/web/lib/logo-data.ts`
		);
		expect(slash(svg.path)).toBe(
			`${slash(
				repoRoot
			)}/packages/ide/overlay/src/browser/media/composery-logo.svg`
		);
		expect(data.contents).toContain(
			'export const LOGO_VIEWBOX = "-1.5 -1.5 64.84 42.5";'
		);
		expect(data.contents).toContain("export const LOGO_WIDTH = 64.84;");
		expect(data.contents).toContain("export const LOGO_HEIGHT = 42.5;");

		const encodedInner = data.contents.match(
			/export const LOGO_INNER = (".*");/
		)?.[1];
		expect(encodedInner).not.toBeUndefined();
		const inner = JSON.parse(encodedInner ?? '""') as string;
		expect(inner).toContain(
			'<svg x="0.5" y="0.5" width="38.5" height="38.5" viewBox="0 0 20 20" fill="none">'
		);
		expect(inner).toContain('id="composery-logo-icon-holes"');
		expect(inner).toContain(
			'<g transform="translate(40 28.80) scale(0.02200 -0.02200)" fill="currentColor"><path transform="translate(0 0)" d="M0 0L1 1"/><path transform="translate(570 0)" d="M2 2L3 3"/></g>'
		);
		expect(svg.contents).toBe(
			`<svg xmlns="http://www.w3.org/2000/svg" width="64.84" height="42.5" viewBox="-1.5 -1.5 64.84 42.5" fill="none"><style>svg{color:${BRAND_COLORS.surface.lightText}}@media (prefers-color-scheme:dark){svg{color:${BRAND_COLORS.surface.darkText}}}</style>${inner}</svg>\n`
		);
		expect(logs).toEqual([
			[
				'Wrote web/lib/logo-data.ts and the editor overlay logo (viewBox "-1.5 -1.5 64.84 42.5").'
			]
		]);
	});

	test("uses the ascent estimate when a font has no cap-height metric", async () => {
		const { data } = await generate(undefined);
		const encodedInner = data.contents.match(
			/export const LOGO_INNER = (".*");/
		)?.[1];
		const inner = JSON.parse(encodedInner ?? '""') as string;

		expect(inner).toContain(
			'<g transform="translate(40 24.62) scale(0.02200 -0.02200)" fill="currentColor">'
		);
	});

	test("takes every logo edge from whichever ink extends farthest", async () => {
		const { data } = await generate(800, true);
		const encodedInner = data.contents.match(
			/export const LOGO_INNER = (".*");/
		)?.[1];
		const inner = JSON.parse(encodedInner ?? '""') as string;

		expect(data.contents).toContain(
			'export const LOGO_VIEWBOX = "-28 -17.2 69 70";'
		);
		expect(data.contents).toContain("export const LOGO_WIDTH = 69;");
		expect(data.contents).toContain("export const LOGO_HEIGHT = 70;");
		expect(inner).toContain(
			'<path transform="translate(-30 0)" d="M2 2L3 3"/>'
		);
	});
});
