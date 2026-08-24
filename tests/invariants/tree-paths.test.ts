import { describe, expect, test } from "vitest";

import { gitFiles, MODES, renderTree } from "../../scripts/tree.mjs";

// A fact about this checkout's index, not about the function that reads it.
//
// It lives here rather than beside the `tree.mjs` behaviour tests because that
// is what it asserts: that the repository reports paths as it stores them. The
// distinction is not bookkeeping - mutation testing runs the behaviour suite
// inside a sandboxed copy of the project with no index of its own, where
// `git ls-files` legitimately reports nothing and this could only ever fail for
// a reason that has nothing to do with any mutant.
//
// The generated tree block is committed and checked on three operating systems,
// so it may not depend on the filesystem that produced it. It did: paths were
// re-resolved against the real directory and took its spelling, so a committed
// case-only rename kept its pre-rename name on Windows and macOS and no
// case-sensitive checkout could ever agree.
//
// Nothing here names a file, deliberately. Two earlier versions pinned one - a
// path under `prompts/`, then `.github/ISSUE_TEMPLATE/bug.yaml` - and both were
// renamed out from under the test. The subject is every mixed-case path the
// index happens to hold, so a rename cannot invalidate it and a new one is
// covered the day it lands.

describe("tree path discovery", () => {
	const files = gitFiles().map((entry) => entry.path);

	// Directory segments specifically: re-resolving a *directory* is the failure
	// this guards, and it is the one a case-insensitive filesystem hides.
	const mixedCaseDirectories = files.filter((path) =>
		path
			.split("/")
			.slice(0, -1)
			.some((segment) => segment !== segment.toLowerCase())
	);

	test("the repository still has a mixed-case path to check", () => {
		// Without this the assertion below passes vacuously the moment the last
		// such path is renamed away - which is how both previous versions of this
		// test quietly stopped meaning anything.
		expect(mixedCaseDirectories.length).toBeGreaterThan(0);
	});

	test("reports the index's spelling, not the working tree's", () => {
		const foldedAway = mixedCaseDirectories.filter((path) =>
			files.includes(path.toLowerCase())
		);

		expect(foldedAway).toEqual([]);
	});
});

// A path whose name does not say what it is. The listing this generates is
// loaded into every agent's context as the map of the repository, so a symlink
// that reads as an ordinary file gets edited instead of the file it points at,
// and a submodule reads as a directory this repository's patches do not own.
//
// Checked against the rendered tree rather than the labelling function, because
// only that reaches the wiring: every assertion on `entryLabel` alone stays
// green with it unwired from the generator.
describe("index entries that are not plain files", () => {
	const special = gitFiles().filter((entry) => entry.mode !== MODES.file);
	const tree = renderTree();

	test("the repository still has one to check", () => {
		expect(special.length).toBeGreaterThan(0);
	});

	test("each is announced in the tree as what it is", () => {
		const unannounced = special.filter(({ mode, path }) => {
			const name = path.split("/").at(-1);
			if (mode === MODES.symlink) return !tree.includes(`${name} -> `);
			if (mode === MODES.submodule)
				return !tree.includes(`${name}/ (submodule)`);
			return !tree.includes(`${name}*`);
		});

		expect(unannounced).toEqual([]);
	});
});
