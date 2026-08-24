import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

import { readRepoFile, repoRoot } from "../support/repo.ts";

// The "Fixed windows" table in docs/developing/web/maintenance.md restates ~14
// durations that live in convex/. It is the one value table the repository keeps.
// The rows cannot be derived: the prose around each number is hand-written on
// purpose - "3 probes (~30 minutes)" and "6 calendar years after the box ends"
// are explanations, not values - and the durations themselves sit in a dozen
// separate files, so an operator asking how long a thing is held has no single
// source to read instead. What can be removed is the guessing: each constant
// carries a `// window: <Behavior cell>` line, and this test binds the two.
// Adding a window is then annotate the constant plus write the row; there is no
// third list to update.
//
// It fails in both directions deliberately. A number that drifts is the obvious
// case, but a row whose constant was deleted is the worse one: it keeps telling
// an operator a window still exists, and nothing else in the repo would notice.

const CONVEX_DIR = "packages/web/convex";
const DOC = "docs/developing/web/maintenance.md";
const HEADING = "## Fixed windows";

// A scanner that quietly stops matching would report every row backed and every
// number correct - the exact silent success this file exists to prevent. The
// table has 14 rows today; 10 is a floor that a broken regex cannot clear and
// that a deliberate removal of several windows would not trip by accident.
const MINIMUM = 10;

// Units a Window cell may state a value in, and what one of each is worth in the
// constant's own unit. Only exact divisions are offered as renderings: "1 hour"
// for 3_600_000 ms is the same value, "0.5 hours" for 1_800_000 would be a
// rounding the doc should not be inviting.
const SCALES: Record<string, [string, number][]> = {
	MS: [
		["millisecond", 1],
		["second", 1000],
		["minute", 60 * 1000],
		["hour", 60 * 60 * 1000],
		["day", 24 * 60 * 60 * 1000]
	],
	MINUTES: [
		["minute", 1],
		["hour", 60]
	],
	DAYS: [["day", 1]],
	YEARS: [["year", 1]]
};

const UNIT_WORD =
	"(?:ms|milliseconds?|seconds?|minutes?|hours?|days?|weeks?|months?|years?)";

type Annotation = {
	label: string;
	name: string;
	value: number;
	source: string;
};

// Sums of products of number literals and named durations - "2 * DAY_MS", "180",
// "DELETED_BOX_RETENTION_DAYS * DAY_MS" - which is how every window in convex/ is
// written. A call, anything with parentheses, a name nothing declared: undefined,
// so the caller fails loudly rather than reporting a window it cannot read.
// Spelled out rather than handed to `Function`: this walks source that has no
// business being executed, and the grammar it needs is this small.
//
// Names are resolved, never assumed. `packages/web/convex/time.ts` exists because eighteen
// sites had open-coded this arithmetic, so a test that could only read the
// open-coded form would be one that punishes the de-duplication - and hardcoding
// "a day is 86400000" here would put the nineteenth copy in the checker.
function evaluateNumber(
	expression: string,
	names: Map<string, number>
): number | undefined {
	let total = 0;
	for (const term of expression.split("+")) {
		let product = 1;
		for (const factor of term.split("*")) {
			const token = factor.trim();
			const named = names.get(token);
			if (named !== undefined) {
				product *= named;
				continue;
			}
			// Only now strip separators: 60_000 is a literal, DAY_MS is not.
			const literal = token.replace(/_/g, "");
			if (!/^\d+(?:\.\d+)?$/.test(literal)) return undefined;
			product *= Number(literal);
		}
		total += product;
	}
	return total;
}

// Every `const NAME = <arithmetic>;` a source declares, in declaration order, so
// a window written in terms of one declared above it resolves. Anything whose
// value this cannot read is skipped rather than guessed at - it then reads as an
// unknown name to whatever refers to it, which is the loud failure.
const CONSTANT = /^\s*(?:export\s+)?const ([A-Za-z_]\w*)\s*=\s*([^;]+);/gm;

function resolveConstants(
	source: string,
	base: Map<string, number>
): Map<string, number> {
	const names = new Map(base);
	for (const [, name = "", expression = ""] of source.matchAll(CONSTANT)) {
		const value = evaluateNumber(expression, names);
		if (value !== undefined) names.set(name, value);
	}
	return names;
}

// The shared durations every window is written in terms of.
const SHARED_DURATIONS = resolveConstants(
	readRepoFile(`${CONVEX_DIR}/time.ts`),
	new Map()
);

function convexFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "_generated") continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) found.push(...convexFiles(path));
		else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
			found.push(path);
	}
	return found;
}

// Every `// window: <label>` in convex/, with the constant it sits on. The
// annotation has to be the line directly above an exported constant whose value
// this can evaluate; anything else throws, because an annotation this cannot read
// is one whose row would silently stop being checked.
function readAnnotations(): Annotation[] {
	const annotations: Annotation[] = [];

	for (const file of convexFiles(join(repoRoot, CONVEX_DIR))) {
		const where = relative(repoRoot, file).replace(/\\/g, "/");
		const source = readFileSync(file, "utf8");
		const lines = source.split(/\r?\n/);
		// A window may be stated in terms of a constant its own file declares
		// (DELETED_BOX_RETENTION_MS is DELETED_BOX_RETENTION_DAYS * DAY_MS), so the
		// file's own names sit on top of the shared durations.
		const names = resolveConstants(source, SHARED_DURATIONS);

		for (const [index, line] of lines.entries()) {
			const label = /^\s*\/\/ window: (.+?)\s*$/.exec(line)?.[1];
			if (!label) continue;

			// Multi-line declarations exist in convex/, so read to the statement end
			// rather than assuming the value fits on the declaring line.
			const declaration: string[] = [];
			for (const next of lines.slice(index + 1, index + 6)) {
				declaration.push(next);
				if (next.includes(";")) break;
			}

			const match = /^\s*export const ([A-Z][A-Z0-9_]*)\s*=\s*([^;]+);/.exec(
				declaration.join("\n")
			);
			if (!match) {
				throw new Error(
					`${where}:${index + 1}: "// window: ${label}" must sit directly above an exported constant.`
				);
			}

			const [, name = "", expression = ""] = match;
			const value = evaluateNumber(expression, names);
			if (value === undefined) {
				throw new Error(
					`${where}:${index + 2}: ${name} is annotated as a fixed window, so its value must be arithmetic over literals and declared durations, not "${expression.trim()}".`
				);
			}

			annotations.push({ label, name, value, source: `${where}:${index + 2}` });
		}
	}

	return annotations;
}

function readRows(): { behavior: string; window: string }[] {
	const doc = readRepoFile(DOC);
	const start = doc.indexOf(HEADING);
	if (start < 0) throw new Error(`${DOC} has no "${HEADING}" section.`);

	const rest = doc.slice(start + HEADING.length);
	const finish = rest.indexOf("\n## ");
	const section = finish < 0 ? rest : rest.slice(0, finish);

	return section
		.split("\n")
		.filter((line) => line.trimStart().startsWith("|"))
		.map((line) =>
			line
				.split("|")
				.slice(1, -1)
				.map((cell) => cell.trim())
		)
		.filter(
			(cells) =>
				cells.length === 2 &&
				cells[0] !== "Behavior" &&
				!/^-+$/.test(cells[0] ?? "")
		)
		.map((cells) => ({ behavior: cells[0] ?? "", window: cells[1] ?? "" }));
}

// How the doc is allowed to write this value. Permissive about the prose around
// it ("2 per 24 hours", "6 calendar years after the box ends") and strict about
// the pairing: the number has to be next to a unit the value really has.
function acceptedBy(name: string, value: number): RegExp[] {
	const suffix = name.slice(name.lastIndexOf("_") + 1);
	const scale = SCALES[suffix];

	// A count with no unit - "3 probes", "2 per 24 hours". It must not be read out
	// of a duration in the same cell, or SUSTAINED_FAILURES = 30 would be
	// "satisfied" by the "(~30 minutes)" that sits beside it.
	if (!scale) return [new RegExp(`\\b${value}\\b(?!\\s*${UNIT_WORD})`)];

	return scale
		.filter(([, size]) => value % size === 0)
		.map(
			([unit, size]) =>
				// One optional word between number and unit carries "6 calendar years"
				// without letting the number float away from what it measures.
				new RegExp(`\\b${value / size}\\s+(?:\\w+\\s+)?${unit}s?\\b`, "i")
		);
}

describe("fixed windows", () => {
	const annotations = readAnnotations();
	const rows = readRows();

	test("reads annotations and rows at all", () => {
		expect(annotations.length).toBeGreaterThanOrEqual(MINIMUM);
		expect(rows.length).toBeGreaterThanOrEqual(MINIMUM);
	});

	test("every annotated constant has a row", () => {
		const behaviors = new Set(rows.map((row) => row.behavior));
		expect(
			annotations
				.filter((annotation) => !behaviors.has(annotation.label))
				.map((annotation) => `${annotation.source}: ${annotation.label}`)
		).toEqual([]);
	});

	// The direction that is easy to forget. A window removed from the code leaves
	// a row that reads as current policy forever.
	test("every row is backed by an annotated constant", () => {
		const labels = new Set(annotations.map((annotation) => annotation.label));
		expect(rows.filter((row) => !labels.has(row.behavior))).toEqual([]);
	});

	test.each(
		annotations.map((annotation) => [annotation.name, annotation] as const)
	)("%s is stated by its row", (_name, annotation) => {
		const row = rows.find((entry) => entry.behavior === annotation.label);
		// The previous test owns the missing-row failure; skipping here keeps one
		// removed constant from failing every case at once.
		if (!row) return;

		const accepted = acceptedBy(annotation.name, annotation.value);
		expect(
			accepted.length,
			`${annotation.name} = ${annotation.value} has no whole-unit rendering to check "${row.window}" against.`
		).toBeGreaterThan(0);
		expect(
			accepted.some((pattern) => pattern.test(row.window)),
			`"${row.behavior} | ${row.window}" does not state ${annotation.name} = ${annotation.value} (${annotation.source}). Expected one of: ${accepted.map((pattern) => pattern.source).join(", ")}`
		).toBe(true);
	});
});
