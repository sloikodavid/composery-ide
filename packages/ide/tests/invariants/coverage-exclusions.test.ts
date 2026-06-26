import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

import { readRepoFile, repoRoot } from "../../../../tests/support/repo.ts";
import config from "../../../../vitest.config.ts";

// The overlay modules excluded from coverage, and the one thing that has to stay
// true of every one of them.
//
// They are excluded because their numbers are wrong, not because nothing runs
// them: the loader re-prints a module to CommonJS and v8's ranges land on the
// wrong lines, so a percentage for one of these is noise
// (packages/ide/tests/support/overlay.ts has the measurements). That is a
// deliberate trade, and it costs the thing an exclusion always costs - lines
// added to these files can never fail `check:coverage`, and nothing would say
// so. The files here are the auth routes and the API that spawns shells, which
// is the worst possible place for a module to quietly stop being tested.
//
// So this is the last rung of the ladder rather than a duplicate list: the
// exclusions are read from vitest.config.ts itself, and what is asserted is that
// each one is still loaded by a behaviour test. It cannot measure how much of a
// module runs - only that the answer is not "none", which is the failure an
// excluded file can otherwise hide forever.

const OVERLAY = "packages/ide/overlay/";
const BEHAVIOR = "packages/ide/tests/behavior";

const exclude =
	(config.test?.coverage as { exclude?: string[] } | undefined)?.exclude ?? [];

// Only concrete files: a glob (`src/browser/pages/**`) names a directory whose
// exclusion vitest.config.ts argues for on its own terms, and there is no single
// module to look for.
const excludedModules = exclude.filter(
	(entry) => entry.startsWith(OVERLAY) && entry.endsWith(".ts")
);

function testSources(directory: string): string[] {
	return readdirSync(resolve(repoRoot, directory)).flatMap((name) => {
		const path = `${directory}/${name}`;
		if (statSync(resolve(repoRoot, path)).isDirectory())
			return testSources(path);
		return name.endsWith(".test.ts") ? [readRepoFile(path)] : [];
	});
}

describe("every excluded overlay module is still exercised", () => {
	// Guards the list itself: if this ever empties, the assertion below passes
	// for the wrong reason and the whole file reports success forever.
	test("there are exclusions to check", () => {
		expect(excludedModules.length).toBeGreaterThan(5);
	});

	test("a behaviour test loads each one", () => {
		const sources = testSources(BEHAVIOR);
		// A test names the module by the path it loads it from, which always ends
		// with the module's path below `overlay/` - whether it is spelled relative
		// to the test or against an `OVERLAY` base.
		const unloaded = excludedModules.filter((entry) => {
			const suffix = entry.slice(OVERLAY.length);
			return !sources.some((source) => source.includes(suffix));
		});

		expect(
			unloaded,
			"excluded from coverage and loaded by no behaviour test - either write one, or say here why it cannot have one"
		).toEqual([]);
	});
});
