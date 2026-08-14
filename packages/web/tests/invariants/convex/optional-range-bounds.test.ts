import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, test } from "vitest";

// Every index range over an optional numeric field is bounded from below.
//
// Convex orders a missing field below every number, so `lte("purge_at", now)`
// on an optional `purge_at` also selects every row that never received one. That
// has shipped twice. The first was `purge_at` itself: a live account was found
// carrying a purge_at only the retry path writes, meaning the sweep had already
// selected it. The second was `expires_at` in the snapshot sweep, whose next
// move is deleting the Hetzner image - found by a behaviour test written months
// later, because the guard against the first was hardcoded to the field name it
// was written for and could not see a second instance.
//
// So this replaces that guard rather than sitting beside it, and it reads the
// field list out of the schema instead of restating it: a new optional numeric
// field is covered the day it is declared.
//
// Per table, not per field name. `expires_at` is optional on `box_snapshots` and
// required on two other tables, so matching on the name alone reports the safe
// queries as broken - and a check that cries wolf is one people learn to skip,
// which is worse than not having it.
//
// Why an invariant and not a behaviour test: the failure is a query that returns
// too much, and provoking it needs a row with the field absent in whichever
// table a future sweep happens to touch. A behaviour test proves one instance -
// and `tests/behavior/convex/boxes/snapshots.test.ts` does, deliberately - while
// the class lives in how the query is built, which is what this reads. The two
// are not substitutes; the instance proves the fix, this stops the next one.

const CONVEX = resolve(import.meta.dirname, "../../../convex");
const read = (path: string) => readFileSync(path, "utf8");

// Brace-matched `<table>: defineTable({ ... })` blocks, so a field is attributed
// to the table that declares it.
function optionalNumericFieldsByTable(): Map<string, Set<string>> {
	const schema = read(join(CONVEX, "schema.ts"));
	const tables = new Map<string, Set<string>>();

	for (const match of schema.matchAll(/(\w+)\s*:\s*defineTable\(\{/g)) {
		const open = schema.indexOf("{", match.index);
		let depth = 0;
		let close = open;
		for (let i = open; i < schema.length; i++) {
			if (schema[i] === "{") depth++;
			else if (schema[i] === "}" && --depth === 0) {
				close = i;
				break;
			}
		}
		const body = schema.slice(open, close);
		tables.set(
			match[1] as string,
			new Set(
				[
					...body.matchAll(
						/(\w+)\s*:\s*v\.optional\(\s*v\.(?:number|int64)\(\)/g
					)
				].map((field) => field[1] as string)
			)
		);
	}
	return tables;
}

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			return entry === "_generated" ? [] : sourceFiles(path);
		}
		return entry.endsWith(".ts") && !entry.endsWith(".test.ts") ? [path] : [];
	});
}

const byTable = optionalNumericFieldsByTable();

describe("index ranges over optional fields", () => {
	test("the schema yields tables with optional numeric fields to check", () => {
		// Without this the sweep below passes by finding nothing to look at - the
		// inert shape that reports success forever.
		expect(byTable.size).toBeGreaterThan(0);
		expect(byTable.get("box_snapshots")).toContain("expires_at");
		expect([...byTable.values()].some((fields) => fields.has("purge_at"))).toBe(
			true
		);
	});

	test("every upper bound on an optional field carries a lower bound", () => {
		const offenders: string[] = [];

		for (const file of sourceFiles(CONVEX)) {
			const source = read(file);
			// A query chain starts at `.query("table")` and runs until the next one.
			// The range builder lives inside it, which is what ties a bound to the
			// table whose schema decides whether the field can be absent.
			const starts = [...source.matchAll(/\.query\(\s*"(\w+)"/g)];
			for (const [index, start] of starts.entries()) {
				const fields = byTable.get(start[1] as string);
				if (!fields?.size) continue;
				const chain = source.slice(
					start.index,
					starts[index + 1]?.index ?? source.length
				);

				for (const bound of chain.matchAll(/\.lte?\(\s*"(\w+)"/g)) {
					const field = bound[1] as string;
					if (!fields.has(field)) continue;
					// `gt` and `gte` both bound it: for a timestamp the difference at
					// zero is immaterial, and both call sites in this repo predate any
					// rule about which to prefer.
					const preceding = chain.slice(0, bound.index);
					if (!new RegExp(`\\.gte?\\(\\s*"${field}"`).test(preceding)) {
						offenders.push(
							`${relative(CONVEX, file).split("\\").join("/")}: ${start[1]}.${field}`
						);
					}
				}
			}
		}

		expect(offenders).toEqual([]);
	});
});
