import { Buffer } from "node:buffer";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, test, vi } from "vitest";

import { BRAND_COLORS } from "../../../index.ts";

const host = vi.hoisted(() => ({
	icoInputs: [] as Buffer[][],
	writes: [] as Array<{ path: string; contents: Buffer }>
}));

vi.mock("node:fs/promises", () => ({
	writeFile: (path: string, contents: Buffer) => {
		host.writes.push({ path, contents });
		return Promise.resolve();
	}
}));

vi.mock("sharp", () => ({
	default: (input: Buffer) => ({
		png: () => ({
			toBuffer: () => Promise.resolve(Buffer.from(input))
		})
	})
}));

vi.mock("png-to-ico", () => ({
	default: (inputs: Buffer[]) => {
		host.icoInputs.push(inputs);
		return Promise.resolve(Buffer.from("fixture-ico"));
	}
}));

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { generateIcons }: { generateIcons: () => Promise<void> } =
	// @ts-expect-error The behavior-tested JavaScript entry point has no declaration file.
	await import("../../../scripts/icons.mjs");

const slash = (path: string) => path.replaceAll("\\", "/");
const repoRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../.."
);
let generationLogs: unknown[][];
let outputs: Record<string, string>;

beforeEach(async () => {
	host.icoInputs.length = 0;
	host.writes.length = 0;
	const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
	await generateIcons();
	generationLogs = log.mock.calls;
	log.mockRestore();
	outputs = Object.fromEntries(
		host.writes.map(({ path, contents }) => [
			slash(path).replace(/^.*\/packages\//, "packages/"),
			contents.toString()
		])
	);
});

describe("raster icon generator", () => {
	test("writes every platform icon to the path its manifest consumes", () => {
		expect(Object.keys(outputs)).toEqual([
			"packages/ide/overlay/src/browser/media/pwa-icon-192.png",
			"packages/ide/overlay/src/browser/media/pwa-icon-512.png",
			"packages/ide/overlay/src/browser/media/pwa-icon-maskable-192.png",
			"packages/ide/overlay/src/browser/media/pwa-icon-maskable-512.png",
			"packages/ide/overlay/src/browser/media/favicon.ico",
			"packages/web/app/apple-icon.png",
			"packages/web/app/favicon.ico"
		]);
		expect(outputs["packages/ide/overlay/src/browser/media/favicon.ico"]).toBe(
			"fixture-ico"
		);
		expect(outputs["packages/web/app/favicon.ico"]).toBe("fixture-ico");
		expect(slash(host.writes[0]!.path)).toBe(
			`${slash(
				repoRoot
			)}/packages/ide/overlay/src/browser/media/pwa-icon-192.png`
		);
		expect(generationLogs).toEqual([
			["Wrote raster icons for the editor overlay and website."]
		]);
	});

	test("preserves each platform's size, padding, corner, and color contract", () => {
		expect(
			outputs["packages/ide/overlay/src/browser/media/pwa-icon-192.png"]
		).toContain('<svg width="192" height="192" viewBox="0 0 256 256"');
		expect(
			outputs["packages/ide/overlay/src/browser/media/pwa-icon-192.png"]
		).toContain(
			`<rect width="256" height="256" rx="46" fill="${BRAND_COLORS.surface.tile}"/><g transform="translate(128 128) scale(8.793600000000001) translate(-10 -10)">`
		);
		expect(
			outputs["packages/ide/overlay/src/browser/media/pwa-icon-512.png"]
		).toContain('<svg width="512" height="512"');
		expect(
			outputs[
				"packages/ide/overlay/src/browser/media/pwa-icon-maskable-192.png"
			]
		).toContain(
			`<rect width="256" height="256" fill="${BRAND_COLORS.surface.tile}"/><g transform="translate(128 128) scale(6.988800000000001) translate(-10 -10)">`
		);
		expect(
			outputs[
				"packages/ide/overlay/src/browser/media/pwa-icon-maskable-512.png"
			]
		).toContain('<svg width="512" height="512"');

		expect(outputs["packages/web/app/apple-icon.png"]).toContain(
			'<svg width="180" height="180"'
		);
		expect(outputs["packages/web/app/apple-icon.png"]).toContain(
			`<rect width="256" height="256" fill="${BRAND_COLORS.surface.tile}"/><g transform="translate(128 128) scale(8.959999999999999) translate(-10 -10)">`
		);
	});

	test("builds both legacy favicons from the exact 16, 32, and 48 pixel set", () => {
		expect(host.icoInputs).toHaveLength(2);
		for (const inputs of host.icoInputs) {
			expect(
				inputs.map((input) =>
					input
						.toString()
						.match(/^<svg width="(\d+)" height="(\d+)"/)
						?.slice(1)
				)
			).toEqual([
				["16", "16"],
				["32", "32"],
				["48", "48"]
			]);
		}
	});
});
