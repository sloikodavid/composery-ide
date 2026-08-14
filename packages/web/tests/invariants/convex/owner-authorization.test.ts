import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// Every owner-facing endpoint is checked against somebody who does not own the
// box.
//
// `convex/owner/boxes.ts` is the boundary between two paying customers. Each
// endpoint resolves its box by (owner, slug) rather than by id, so the ownership
// check is the lookup itself rather than a separate guard - easy to get right,
// and easy to regress in one line. Behind it are stop, reset, rename and delete.
//
// The behaviour is tested in `tests/behavior/convex/owner/boxes.test.ts`, whose
// `ENDPOINTS` table drives every one of them as a signed-out caller and as a
// different signed-in customer, and asserts that a write refuses without
// confirming the box exists while a read answers with nothing at all. What that
// cannot do is notice an endpoint added afterwards - it would simply not be in
// the table, and every case there would still pass.
//
// The two lists cannot be derived from one another (Convex declarations on one
// side, call shapes with arguments on the other), so this pins the pair.
// ---------------------------------------------------------------------------

const read = (path: string) =>
	readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

function publicEndpoints() {
	const source = read("../../../convex/owner/boxes.ts");
	return [
		...source.matchAll(/export const (\w+) = (query|mutation|action)\(/g)
	].map((match) => match[1] as string);
}

function coveredEndpoints() {
	const source = read("../../behavior/convex/owner/boxes.test.ts");
	const table = /const ENDPOINTS = \{([\s\S]*?)\n\t\} as const;/.exec(source);
	return [...(table?.[1] ?? "").matchAll(/^\t\t(\w+):/gm)].map(
		(match) => match[1] as string
	);
}

describe("every owner-facing endpoint is checked against a non-owner", () => {
	// A green run has to mean the lists matched, not that a regex stopped
	// finding either of them.
	test("both lists are still being read", () => {
		expect(publicEndpoints().length).toBeGreaterThan(10);
		expect(coveredEndpoints().length).toBeGreaterThan(10);
	});

	test("the ownership table names every one of them", () => {
		expect([...coveredEndpoints()].sort()).toEqual(
			[...publicEndpoints()].sort()
		);
	});
});
