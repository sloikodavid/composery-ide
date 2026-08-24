import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import prettier from "prettier";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";

import { repoRoot, readRepoFile } from "../support/repo.ts";

// packages/ide/overlay/src/ is copied into code-server's src/ by the build, so
// upstream's .prettierrc.yaml decides how those files are written. This reads
// prettier's *resolved* options for real files rather than the text of
// prettier.config.mjs, because the way that wiring breaks is silent: an override
// whose glob matches nothing does not fail, it just hands the files back to this
// repo's style, and only a diff against upstream would ever say so.
//
// prettier.config.mjs reads the same YAML this test reads, so the two are not
// two copies of the six options - the duplication is gone, and what is left to
// check is that the reading reaches the files it claims to.
const OVERLAY = "packages/ide/overlay/src";

function overlayFiles(dir: string): string[] {
	return readdirSync(resolve(repoRoot, dir), { withFileTypes: true }).flatMap(
		(entry) =>
			entry.isDirectory()
				? overlayFiles(`${dir}/${entry.name}`)
				: [`${dir}/${entry.name}`]
	);
}

describe("the overlay is formatted with upstream's own prettier options", () => {
	const upstream = parse(
		readRepoFile("packages/ide/upstream/.prettierrc.yaml")
	) as Record<string, unknown>;
	const files = overlayFiles(OVERLAY);

	test("the enumeration found something to check", () => {
		// Both test.each blocks below pass vacuously on an empty list, and an
		// upstream file that parsed to nothing would make every assertion trivial.
		expect(files.length).toBeGreaterThan(10);
		expect(Object.keys(upstream)).toContain("useTabs");
		expect(upstream.useTabs).toBe(false);
	});

	test.each(files)("%s resolves to upstream's options", async (path) => {
		const resolved = await prettier.resolveConfig(resolve(repoRoot, path));

		expect(resolved).toMatchObject(upstream);
	});

	// The override has to be scoped, not global: if it ever matched the whole
	// repository the check above would still pass while every other file silently
	// changed style.
	test.each([
		"packages/web/lib/utils.ts",
		"scripts/tree.mjs",
		"tests/support/repo.ts"
	])("%s keeps this repository's own style", async (path) => {
		const resolved = await prettier.resolveConfig(resolve(repoRoot, path));

		expect(resolved?.useTabs).toBe(true);
		expect(resolved?.trailingComma).toBe("none");
		expect(resolved?.semi).toBeUndefined();
	});
});
