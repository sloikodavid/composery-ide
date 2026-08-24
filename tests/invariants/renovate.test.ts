import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

import { repoRoot } from "../support/repo.ts";

// Renovate is configured entirely in renovate.json, and its custom managers
// point at files by name. A manager whose file pattern matches nothing is not
// a warning - it is a silent retirement: the caddy digest rule pointed at
// runtimeArtifacts.ts through the refactor that renamed it to artifacts.ts,
// and from then on the version that feeds the deployed box images was simply
// never moved again. And the reverse rots too: a `renovate:` comment with no
// manager anywhere claims to be maintained (the cloud-init schema URL did)
// and nothing ever updates it.
//
// Both directions are checked here from the config alone, so a rename, a new
// managed dependency, or a comment added to an unmanaged file fails the
// checkout instead of quietly going dead.

const renovate = JSON.parse(
	readFileSync(resolve(repoRoot, "renovate.json"), "utf8")
) as {
	customManagers?: {
		customType: string;
		managerFilePatterns: string[];
		matchStrings: string[];
	}[];
};

function walk(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (
			[
				"node_modules",
				".git",
				"upstream",
				"tmp",
				"build",
				"target",
				".next",
				".source",
				"dist",
				"coverage"
			].includes(entry.name)
		)
			continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...walk(path));
		else if (statSync(path).isFile()) found.push(path);
	}
	return found;
}

const repoFiles = walk(repoRoot).map((path) =>
	relative(repoRoot, path).replaceAll("\\", "/")
);

function patternToRegex(pattern: string): RegExp {
	// Patterns are written as /^path$/; the slashes are syntax, not content.
	const body = pattern.replace(/^\//, "").replace(/\/$/, "");
	return new RegExp(body);
}

// A match string names its datasource either literally or inside a capture
// group's alternatives (`datasource=(?<datasource>npm|crate)`); both forms
// are read back, because the config is the artifact being checked.
function namesDatasource(matchString: string, datasource: string): boolean {
	const group = /datasource=\(\?<\w+>([^)]*)\)/.exec(matchString);
	if (group) return group[1]!.split("|").includes(datasource);
	// The literal form is followed by `\s+...` (escaped whitespace) in the
	// config's regex string, so the boundary is a backslash or whitespace.
	return new RegExp(`datasource=${datasource}(\\\\|\\s|$)`).test(matchString);
}

const managers = renovate.customManagers ?? [];

describe("renovate custom managers", () => {
	test("every manager file pattern matches at least one real file", () => {
		const unmatched: string[] = [];
		for (const manager of managers) {
			for (const pattern of manager.managerFilePatterns) {
				const regex = patternToRegex(pattern);
				if (!repoFiles.some((file) => regex.test(file))) {
					unmatched.push(pattern);
				}
			}
		}
		expect(unmatched).toEqual([]);
	});

	test("every renovate: comment is covered by a manager for its file", () => {
		// All `renovate:` comments in the repository, with the datasource they
		// name. A comment is covered when a manager whose file pattern matches
		// the comment's file names that datasource in one of its match strings.
		const orphans: { file: string; datasource: string }[] = [];
		for (const file of repoFiles) {
			if (file === "renovate.json") continue;
			if (!/\.(ts|mjs|json|yaml|yml|sh)$/.test(file) && file !== "Dockerfile")
				continue;
			const content = readFileSync(join(repoRoot, file), "utf8");
			for (const match of content.matchAll(
				/(?:#|\/\/)\s*renovate:\s*datasource=(\S+)\s+depName=\S+/g
			)) {
				const datasource = match[1]!;
				const covering = managers.some(
					(manager) =>
						manager.managerFilePatterns.some((pattern) =>
							patternToRegex(pattern).test(file)
						) &&
						manager.matchStrings.some((line) =>
							namesDatasource(line, datasource)
						)
				);
				if (!covering) orphans.push({ file, datasource });
			}
		}
		expect(orphans).toEqual([]);
	});

	test("every match string matches the content of a file its manager points at", () => {
		// A manager that matches a real file's *name* but nothing in its
		// *content* is the same silent retirement one directory level deeper:
		// the regex that must extract the version never does. The match strings
		// are regexes themselves, so the honest check is to run them against
		// the files each manager names.
		const dead: { pattern: string; file: string }[] = [];
		for (const manager of managers) {
			const files = repoFiles.filter((file) =>
				manager.managerFilePatterns.some((pattern) =>
					patternToRegex(pattern).test(file)
				)
			);
			for (const matchString of manager.matchStrings) {
				const regex = new RegExp(matchString);
				const matched = files.filter((file) =>
					regex.test(readFileSync(join(repoRoot, file), "utf8"))
				);
				if (matched.length === 0) {
					dead.push({ pattern: matchString, file: files[0] ?? "no files" });
				}
			}
		}
		expect(dead).toEqual([]);
	});

	test("the config itself is the fixture for both checks", () => {
		expect(managers.length).toBeGreaterThan(0);
		expect(repoFiles.length).toBeGreaterThan(100);
	});
});
