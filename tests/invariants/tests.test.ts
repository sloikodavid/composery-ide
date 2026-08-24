import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, test } from "vitest";

import config from "../../vitest.config.ts";
import { readRepoFile, repoRoot } from "../support/repo.ts";

// The rules in docs/developing/testing.md, made mechanical.
//
// Duplication, and why it cannot be removed: a convention written only in prose
// is a suggestion to whoever reads it, and nobody here reads it - every line in
// this repository is written by an agent that has never seen the last review.
// The doc and this file are therefore two copies on purpose, and the doc says so
// beside each rule. Deriving one from the other would mean parsing English or
// generating it, and both are worse than the pair.

const KINDS = ["behavior", "invariants", "system"];

const checkoutFiles = execFileSync(
	"git",
	["ls-files", "--cached", "--others", "--exclude-standard"],
	{
		cwd: repoRoot,
		encoding: "utf8"
	}
)
	.split("\n")
	.filter((file) => file && existsSync(resolve(repoRoot, file)));

const testFiles = checkoutFiles.filter((f) => /\.test\.[cm]?tsx?$/.test(f));
const read = (f: string) => readFileSync(resolve(repoRoot, f), "utf8");

// Behaviour tests that still lift code out of a diff instead of loading the
// module. Every entry is debt from before `packages/ide/patches/` became call
// sites, and the migration empties this list one patch at a time.
//
// It may only shrink. A file that stops reading patches has to leave (the stale
// -entry test below fails until it does), and a file that starts reading them
// fails the confinement test unless someone adds it here on purpose - which the
// doctrine forbids.
const PATCH_READING_TESTS: string[] = [];

// Behaviour tests that still wait on the wall clock. Same ratchet: a real delay
// in an in-process test is a race the suite has decided to lose slowly.
const SLEEPING_TESTS: string[] = [];

describe("test layout", () => {
	test("no test file sits outside a tests directory", () => {
		const stray = testFiles.filter(
			(f) => !f.startsWith("tests/") && !f.includes("/tests/")
		);
		expect(stray).toEqual([]);
	});

	test("every test file sits under a known kind", () => {
		const unkinded = testFiles.filter((f) => {
			const after = f.replace(/^.*?tests\//, "");
			return !KINDS.some((k) => after.startsWith(`${k}/`));
		});
		expect(unkinded).toEqual([]);
	});

	test("every suite a kind directory implies is scheduled by a project", () => {
		// The config is the schedule; this reads it rather than restating it, so a
		// package that grows a tests/ directory nobody wired up fails here instead
		// of reporting zero failures forever.
		const projects = (
			config.test?.projects as Array<{ test: { root: string } }> | undefined
		)?.map((p) => relative(repoRoot, p.test.root).split("\\").join("/") || ".");
		expect(projects).toBeDefined();

		const suiteRoots = new Set(
			testFiles
				.filter(
					(f) => !f.includes("/system/") && !f.startsWith("tests/system/")
				)
				.map((f) => {
					const i = f.indexOf("tests/");
					return i === 0 ? "." : f.slice(0, i - 1);
				})
		);
		expect([...suiteRoots].filter((r) => !projects?.includes(r))).toEqual([]);
	});
});

describe("test hygiene", () => {
	test("no focused or skipped tests", () => {
		const offenders = testFiles.filter((f) =>
			/\b(?:describe|test)\.(?:only|skip|todo|skipIf|runIf)\b/.test(read(f))
		);
		expect(offenders).toEqual([]);
	});

	test("tests are declared with test(, never the it( alias", () => {
		// Anchored on the declaration shape - a quoted name always follows - so a
		// comment that happens to end in "it." cannot read as a call.
		const offenders = testFiles.filter((f) =>
			/(?:^|[^.\w])it(?:\.\w+)?\(\s*["'`]/m.test(read(f))
		);
		expect(offenders).toEqual([]);
	});

	test("test names are sentences, not shoulds", () => {
		const offenders = testFiles.filter((f) =>
			/(?:describe|test)\(\s*["'`]should\b/i.test(read(f))
		);
		expect(offenders).toEqual([]);
	});

	test("a behaviour test that reads the clock pins it", () => {
		const offenders = testFiles
			.filter((f) => f.includes("/behavior/"))
			.filter((f) => {
				const source = read(f);
				const reads = /\bDate\.now\(\)|new Date\(\s*\)/.test(source);
				const pinned = /vi\.(?:useFakeTimers|setSystemTime)\b/.test(source);
				return reads && !pinned;
			});
		expect(offenders).toEqual([]);
	});

	test("a behaviour test does not wait on the wall clock", () => {
		const offenders = testFiles
			.filter((f) => f.includes("/behavior/"))
			.filter((f) => /setTimeout\([^,]+,\s*(?!0\s*\))\w/.test(read(f)))
			.filter((f) => !SLEEPING_TESTS.includes(f));
		expect(offenders).toEqual([]);
	});

	test("no test still listed as sleeping has stopped", () => {
		const settled = SLEEPING_TESTS.filter(
			(f) => !/setTimeout\([^,]+,\s*(?!0\s*\))\w/.test(read(f))
		);
		expect(settled, "delete these from SLEEPING_TESTS").toEqual([]);
	});
});

describe("source text stays out of behaviour tests", () => {
	const importsPatchHelpers = (f: string) =>
		/from "[^"]*ide\/tests\/support\/patch\.ts"|from "\.[^"]*support\/patch\.ts"/.test(
			read(f)
		);

	test("patch helpers are imported only from an invariants directory", () => {
		const offenders = testFiles
			.filter(importsPatchHelpers)
			.filter((f) => !f.includes("/invariants/"))
			.filter((f) => !PATCH_READING_TESTS.includes(f));
		expect(offenders).toEqual([]);
	});

	test("no test still listed as reading patches has stopped", () => {
		const migrated = PATCH_READING_TESTS.filter((f) => !importsPatchHelpers(f));
		expect(migrated, "delete these from PATCH_READING_TESTS").toEqual([]);
	});

	test("the patch helpers are reachable only through the support module", () => {
		// Copying an extractor into a test would route around the confinement
		// above, so the one definition has to stay the only one.
		const offenders = testFiles.filter((f) =>
			/function (?:addedLines|postImageLines|extractAdded\w+)\b/.test(read(f))
		);
		expect(offenders).toEqual([]);
	});
});

describe("invariants earn their place", () => {
	test("every invariants file opens with the case for being one", () => {
		// An invariant is the last rung of the duplication ladder, and taking it
		// makes the duplication permanent - so it has to be a decision someone
		// wrote down rather than the path of least resistance. The header says why
		// this cannot be a behaviour test: whose copy is being pinned and why it
		// cannot be removed or derived, or what it asserts that running code
		// cannot reach.
		const offenders = testFiles
			.filter((f) => f.includes("/invariants/"))
			.filter((f) => {
				const source = read(f);
				const head = source.slice(0, source.search(/^describe\(/m) >>> 0);
				return !/^\s*\/\/.+/m.test(head);
			});
		expect(offenders).toEqual([]);
	});
});

describe("system harnesses are reachable", () => {
	test("every system harness is wired to a workflow", () => {
		// A harness nothing runs is worse than a missing one: its presence reads as
		// coverage while it proves nothing. tests/system/overlay/run.sh sat
		// unreferenced by any workflow for exactly as long as nobody checked.
		const harnesses = checkoutFiles.filter((f) =>
			/(?:^|\/)tests\/system\/.*(?:run\.(?:mjs|sh)|smoke\.mjs|e2e\.yaml)$/.test(
				f
			)
		);
		expect(harnesses.length).toBeGreaterThan(0);

		const workflows = checkoutFiles
			.filter((f) => f.startsWith(".github/workflows/"))
			.map(read)
			.join("\n");
		const scripts = JSON.parse(readRepoFile("package.json")) as {
			scripts: Record<string, string>;
		};

		const unreachable = harnesses.filter((h) => {
			// Either the workflow names the harness, or it calls a package script
			// that does. A path relative to its own package counts: some jobs run
			// from inside their package directory.
			const local = h.replace(/^packages\/[^/]+\//, "");
			const named = (text: string) => text.includes(h) || text.includes(local);
			if (named(workflows)) return false;
			return !Object.entries(scripts.scripts).some(
				([name, body]) => named(body) && workflows.includes(`pnpm ${name}`)
			);
		});
		expect(unreachable).toEqual([]);
	});
});

// A mutant is silenced one line at a time, never in bulk.
//
// Stryker takes `// Stryker disable <mutators>` as a switch that stays on until a
// matching `restore`, and `// Stryker disable next-line <mutators>` as one line.
// The block form is the dangerous one: it silences every mutant of those kinds in
// its range, including ones tests were killing, and the report says only that the
// count of ignored mutants went up. Measured while writing these: one block pair
// around a short helper in `convex/boxes/snapshots.ts` took Ignored from 14 to 151
// and Killed from 303 to 193 - about a hundred and ten real kills hidden, with
// nothing in the run that looked wrong.
//
// `next-line` cannot do that: its blast radius is one line, and a line it does
// not reach stays measured. The rule is therefore absolute rather than "use the
// block form carefully", because the failure is invisible in the only report
// anyone reads.
// The one path excluded from both coverage and mutation, held in step.
//
// Duplication, and why it cannot be removed: `stryker.config.json` is JSON read
// by an external tool, so it can neither import `vitest.config.ts` nor derive
// anything from it. The pair is the last rung of the ladder, which is what this
// pins. The argument for excluding it is written once, beside the coverage
// entry; the mutation entry points at it rather than restating it.
//
// It is deliberately this one path rather than "every coverage exclusion is also
// a mutation exclusion", because the two lists exclude for different reasons and
// only this reason travels. The IDE overlay modules are excluded from coverage
// because their *numbers* are wrong while tests do run them - they must stay
// mutable, and a general rule would quietly stop mutating the auth routes.
//
// A workflow body is the other kind: no test runs it at all, so every mutant in
// it survives by construction and the gate would ask for kills nobody can write.
// That holds only while those files stay wiring - each entry's reason says so.
const UNMUTATED_UNCOVERED = "packages/web/convex/boxes/workflows/";

describe("what no test can run is excluded from both gates", () => {
	const stryker = JSON.parse(readRepoFile("stryker.config.json")) as {
		mutate: string[];
	};
	const coverageExclude =
		(config.test?.coverage as { exclude?: string[] } | undefined)?.exclude ??
		[];

	// Both lists really were read. Without this, a renamed key or a moved config
	// leaves two empty arrays agreeing with each other forever.
	test("both exclusion lists were found", () => {
		expect(stryker.mutate.length).toBeGreaterThan(3);
		expect(coverageExclude.length).toBeGreaterThan(3);
	});

	test.each([
		["coverage", () => coverageExclude],
		["mutation", () => stryker.mutate.map((entry) => entry.replace(/^!/, ""))]
	])("the workflow bodies are excluded from %s", (_gate, entries) => {
		expect(
			entries().some((entry) => entry.startsWith(UNMUTATED_UNCOVERED)),
			`${UNMUTATED_UNCOVERED} must be excluded from both gates or neither: mutating a file no test can run asks for kills nobody can write, and covering it asks for a percentage of nothing`
		).toBe(true);
	});
});

describe("mutants are silenced one line at a time", () => {
	const sourceFiles = checkoutFiles.filter(
		(f) => /\.[cm]?tsx?$/.test(f) && !/\.test\.[cm]?tsx?$/.test(f)
	);

	// A green run has to mean the tree is clean, not that the pattern stopped
	// matching the directive Stryker actually understands.
	test("there are narrow disables to find", () => {
		const narrow = sourceFiles.filter((f) =>
			read(f).includes("Stryker disable next-line")
		);

		expect(narrow.length).toBeGreaterThan(0);
	});

	test("no source file opens a disable block", () => {
		const blockForm = sourceFiles.filter((f) =>
			/\/\/\s*Stryker\s+disable\s+(?!next-line)/.test(read(f))
		);

		expect(blockForm).toEqual([]);
	});

	// Every silenced mutant says why. A bare directive is the same untriaged
	// survivor the doctrine forbids, just hidden from the report.
	test("every disable carries its reason", () => {
		const unexplained = sourceFiles.flatMap((f) =>
			read(f)
				.split("\n")
				.filter(
					(line) =>
						line.includes("Stryker disable next-line") && !line.includes(":")
				)
				.map(() => f)
		);

		expect([...new Set(unexplained)]).toEqual([]);
	});
});
