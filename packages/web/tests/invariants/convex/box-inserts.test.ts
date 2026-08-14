import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// A box row is inserted in one place, and that place raises the total.
//
// `convex/boxes/counts.ts` writes the row and increments `box_counts` in the
// same transaction, which is the only reason the figure the home page publishes
// is true. Nothing else can hold that: TypeScript cannot say "writing this table
// obliges you to patch that row", and Convex has no trigger.
//
// The failure being prevented is silent both ways. A second insert site - a new
// comp path, an import, a migration, a fixture promoted into production code -
// creates boxes the total never counts, and nothing looks wrong: the number
// simply reads low, forever. It cannot be repaired by counting the table later
// either, because `purgeBox` deletes the rows a recount would have read.
//
// This is the last rung of the duplication ladder (docs/developing/testing.md).
// The duplication it pins - a row's existence in one table, a tally of it in
// another - cannot be removed, because the table it counts does not keep its
// history.
//
// Scoped to `convex/`, so the harness's own `seedBox` is untouched: a fixture
// inserted by a test is not a box this deployment created, and a test that had
// to go through the counter could not seed a starting state without moving the
// number it then asserts on.
// ---------------------------------------------------------------------------

const BOX_INSERT = /\.insert\(\s*"boxes"/g;
const COUNTER = "convex/boxes/counts.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));

function read(file: string) {
	return readFileSync(new URL(file, `file:///${root}/`), "utf8");
}

// Tracked files that still exist, for the reason `audience-directories.test.ts`
// gives: the rule is about what gets committed, and a working copy mid-rename
// should not read as a violation.
const convexFiles = execFileSync("git", ["ls-files", "convex"], {
	cwd: root,
	encoding: "utf8"
})
	.split("\n")
	.filter((file) => file.endsWith(".ts") && !file.includes("_generated"))
	.filter((file) => existsSync(new URL(file, `file:///${root}/`)));

function boxInsertsIn(file: string) {
	return [...read(file).matchAll(BOX_INSERT)].length;
}

describe("every box row is created through the counter", () => {
	// A green run has to mean the pattern still matches the one call it is meant
	// to find. Without this, renaming the counter's file or rewriting its insert
	// leaves a suite that passes because it now searches for nothing.
	test("the counter still inserts a box", () => {
		expect(convexFiles).toContain(COUNTER);
		expect(boxInsertsIn(COUNTER)).toBe(1);
	});

	test("nothing else under convex inserts one", () => {
		const offenders = convexFiles
			.filter((file) => file !== COUNTER)
			.filter((file) => boxInsertsIn(file) > 0);

		expect(offenders).toEqual([]);
	});

	// The counter is only reached by being called, so the two paths that create a
	// box are named here as well. A call site that stops importing it would pass
	// the test above by inserting nothing at all - and by creating no boxes, which
	// is a different bug this cannot see, but the import is the cheap half.
	test("both creation paths call it", () => {
		for (const file of [
			"convex/checkout/checkoutConversion.ts",
			"convex/staff/boxes.ts"
		]) {
			expect(convexFiles).toContain(file);
			expect(read(file)).toContain("insertBox");
		}
	});
});
