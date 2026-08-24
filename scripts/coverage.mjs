import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Coverage of the lines a change adds, which is the only coverage question with
// a useful answer. A global percentage is a target, and a target is the one
// number that can be met while making the suite worse - run the line, assert
// nothing. This asks something narrower and unfakeable in that direction: did
// anything at all execute the code you just wrote?
//
// The global figure is reported and never thresholded - there is no ratchet to
// hold it, deliberately, because it falls when a well-covered file is deleted.
// See vitest.config.ts and docs/developing/testing.md.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COVERAGE = resolve(REPO_ROOT, "coverage/coverage-final.json");

function git(args) {
	const result = spawnSync("git", args, {
		cwd: REPO_ROOT,
		encoding: "utf8"
	});
	return result.status === 0 ? result.stdout.trim() : undefined;
}

// Prefer the fork point from the default branch; fall back to the previous
// commit. A shallow clone has neither, and that has to be loud: reporting "no
// uncovered lines" because we could not find any lines is the exact failure this
// file exists to prevent.
function baseRef() {
	for (const candidate of ["origin/main", "main"]) {
		const merged = git(["merge-base", candidate, "HEAD"]);
		if (merged) return merged;
	}
	const parent = git(["rev-parse", "HEAD~1"]);
	if (parent) return parent;
	console.error(
		"No base commit to diff against. Fetch history (actions/checkout needs\n" +
			"fetch-depth: 0) - diff coverage cannot be computed from a shallow clone."
	);
	process.exit(1);
}

// Line numbers each file gained, from a zero-context diff.
function addedLines(base) {
	const diff = execFileSync(
		"git",
		["diff", "--unified=0", "--diff-filter=d", base],
		{ cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
	);
	const byFile = new Map();
	let file;
	for (const line of diff.split("\n")) {
		const header = /^\+\+\+ b\/(.+)$/.exec(line);
		if (header) {
			file = header[1];
			continue;
		}
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (!hunk || !file) continue;
		const start = Number(hunk[1]);
		const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
		const lines = byFile.get(file) ?? new Set();
		for (let n = start; n < start + count; n++) lines.add(n);
		byFile.set(file, lines);
	}
	return byFile;
}

// A line counts as covered when some statement spanning it ran. Istanbul's map
// is per statement, so a line inside a multi-line statement inherits its verdict
// - which is what "did this execute" means.
function uncoveredLines() {
	if (!existsSync(COVERAGE)) {
		console.error(
			`No coverage report at ${relative(REPO_ROOT, COVERAGE)}.\n` +
				"Run `pnpm check:test` first - it writes the report this reads. A failed\n" +
				"suite writes nothing (vitest `coverage.reportOnFailure` is off), so a\n" +
				"red run reaches here too: fix the failures rather than this message."
		);
		process.exit(1);
	}
	const report = JSON.parse(readFileSync(COVERAGE, "utf8"));
	const byFile = new Map();
	for (const entry of Object.values(report)) {
		const path = relative(REPO_ROOT, entry.path).split("\\").join("/");
		const hit = new Set();
		const missed = new Set();
		for (const [id, location] of Object.entries(entry.statementMap)) {
			const target = entry.s[id] > 0 ? hit : missed;
			for (let n = location.start.line; n <= location.end.line; n++) {
				target.add(n);
			}
		}
		byFile.set(path, new Set([...missed].filter((n) => !hit.has(n))));
	}
	return byFile;
}

const base = baseRef();
const added = addedLines(base);
const uncovered = uncoveredLines();

const gaps = [];
for (const [file, lines] of added) {
	const missed = uncovered.get(file);
	if (!missed) continue; // Not instrumented: not product code, or not covered by the include set.
	const inDiff = [...lines].filter((n) => missed.has(n)).sort((a, b) => a - b);
	if (inDiff.length) gaps.push([file, inDiff]);
}

if (!gaps.length) {
	const instrumented = [...added.keys()].filter((f) => uncovered.has(f)).length;
	console.log(
		instrumented
			? `Every line added to ${instrumented} instrumented file(s) is covered.`
			: "This change adds no lines to instrumented source."
	);
	process.exit(0);
}

console.error(
	`Lines added since ${base.slice(0, 8)} that no behaviour test reaches:\n`
);
for (const [file, lines] of gaps) {
	console.error(`  ${file}: ${lines.join(", ")}`);
}
console.error(
	"\nCover them, or move the code out of the coverage include set in\n" +
		"vitest.config.ts with a reason. Do not lower a threshold - there isn't one."
);
process.exit(1);
