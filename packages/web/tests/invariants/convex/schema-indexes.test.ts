import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vitest";

// Two shapes of index that cost writes and buy nothing.
//
// A Convex index is maintained on every insert and every patch of its table, so
// one that answers no query is pure write amplification, and one whose fields
// are a prefix of another index's fields is answered by that longer index -
// `withIndex("box_id_created_at", q => q.eq("box_id", id))` reads exactly the
// rows `withIndex("box_id", ...)` would. Both are invisible: nothing fails, the
// table just costs more to write for ever.
//
// Read out of the schema rather than listed, because the failure is one people
// add by copying a neighbouring line. This caught three indexes nothing queried
// (`box_operations.idempotency_key`, `box_events.type`, three on
// `box_snapshots`) and a dozen prefixes.
//
// The prefix rule is absolute, and the way to satisfy it is to lengthen the
// short index rather than keep both: where a caller relied on the short index's
// implicit `_creationTime` ordering, `<fields>_created_at` says so explicitly
// and sorts identically. An index that is genuinely needed at two different
// sort orders is not a prefix pair - its extra fields differ.

const CONVEX = resolve(import.meta.dirname, "../../../convex");

type Index = { fields: string[]; name: string };

function indexesByTable(): Map<string, Index[]> {
	const schema = readFileSync(join(CONVEX, "schema.ts"), "utf8");
	const tables = new Map<string, Index[]>();
	const starts = [...schema.matchAll(/(\w+)\s*:\s*defineTable\(\{/g)];

	for (const [position, start] of starts.entries()) {
		const block = schema.slice(
			start.index,
			starts[position + 1]?.index ?? schema.length
		);
		tables.set(
			start[1] as string,
			[...block.matchAll(/\.index\(\s*"(\w+)",\s*\[([^\]]*)\]/g)].map(
				(match) => ({
					name: match[1] as string,
					fields: (match[2] as string)
						.split(",")
						.map((field) => field.replaceAll(/["\s]/g, ""))
						.filter(Boolean)
				})
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
		return entry.endsWith(".ts") ? [path] : [];
	});
}

// `withIndex` names reached from `.query("<table>")`, and separately the ones
// reached from a `.query(someVariable)` loop, which could be any table.
// Accepting those against every table is what keeps this from reporting the
// deliberately shared sweep in box/auth.ts as dead.
function queriedIndexNames(): {
	anyTable: Set<string>;
	byTable: Map<string, Set<string>>;
} {
	const byTable = new Map<string, Set<string>>();
	const anyTable = new Set<string>();

	for (const file of sourceFiles(CONVEX)) {
		const source = readFileSync(file, "utf8");
		const starts = [...source.matchAll(/\.query\(\s*("?\w+"?)\s*\)/g)];
		for (const [position, start] of starts.entries()) {
			const chain = source.slice(
				start.index,
				starts[position + 1]?.index ?? source.length
			);
			const literal = (start[1] as string).startsWith('"');
			const table = (start[1] as string).replaceAll('"', "");
			const target = literal
				? (byTable.get(table) ?? new Set<string>())
				: anyTable;
			if (literal) byTable.set(table, target);
			for (const use of chain.matchAll(/withIndex\(\s*"(\w+)"/g)) {
				target.add(use[1] as string);
			}
		}
	}
	return { anyTable, byTable };
}

const tables = indexesByTable();
const { anyTable, byTable } = queriedIndexNames();
const declared = [...tables].flatMap(([table, indexes]) =>
	indexes.map((index) => ({ ...index, table }))
);

describe("schema indexes", () => {
	test("the schema and the call sites were both actually read", () => {
		// Without these, an empty parse would report every rule below as passing.
		// Anchored on `slug_status`, which encodes the slug-reservation rule and so
		// is the least likely index in the schema to be renamed out from under this.
		expect(declared.length).toBeGreaterThan(40);
		expect(tables.get("boxes")?.map((index) => index.name)).toContain(
			"slug_status"
		);
		expect(byTable.get("boxes")).toContain("slug_status");
		// Reached through `.query(table)` in box/auth.ts, so it only resolves if
		// the dynamic-table arm below ran.
		expect(anyTable).toContain("expires_at");
	});

	test.each(declared.map((index) => [`${index.table}.${index.name}`, index]))(
		"%s answers at least one query",
		(_label, index) => {
			expect(
				byTable.get(index.table)?.has(index.name) || anyTable.has(index.name)
			).toBe(true);
		}
	);

	test("no index is a prefix of another on the same table", () => {
		const redundant: string[] = [];
		for (const [table, indexes] of tables) {
			for (const short of indexes) {
				for (const long of indexes) {
					if (short.name === long.name) continue;
					if (short.fields.length >= long.fields.length) continue;
					if (short.fields.every((field, at) => field === long.fields[at])) {
						redundant.push(`${table}: "${short.name}" ⊂ "${long.name}"`);
					}
				}
			}
		}
		expect(redundant).toEqual([]);
	});
});
