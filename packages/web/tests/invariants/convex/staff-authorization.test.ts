import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// Every publicly reachable staff endpoint is checked against a caller who is
// not staff.
//
// `convex/staff/boxes.ts` is the console's own surface: reset somebody else's
// box, change its slug, suspend it, restore a snapshot, grant a free one. The
// box id is the only other argument any of them takes, so the capability check
// at the top of each handler is the whole of the authorization - there is no
// second gate behind it, and a handler written without that line is reachable by
// anyone signed in.
//
// The behaviour is tested in `tests/behavior/convex/staff/boxes.test.ts`, which
// drives every entry in its `ENDPOINTS` table as a signed-out caller, an
// ordinary user, and the box's own owner. What that cannot do is notice an
// endpoint added afterwards: it would simply not be in the table, and every case
// there would still pass. This is that missing rung.
//
// The two lists cannot be derived from one another - one is Convex function
// declarations, the other is a table of call shapes including each endpoint's
// arguments - so they exist twice and this pins the pair.
// ---------------------------------------------------------------------------

const read = (path: string) =>
	readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

// `export const suspend = action({` -> "suspend". Deliberately not
// `internalMutation`/`internalQuery`/`internalAction`: those are unreachable
// from a client and carry no capability check of their own.
function publicEndpoints() {
	const source = read("../../../convex/staff/boxes.ts");
	return [
		...source.matchAll(/export const (\w+) = (query|mutation|action)\(/g)
	].map((match) => match[1] as string);
}

// The keys of the `ENDPOINTS` table in the behaviour test.
function coveredEndpoints() {
	const source = read("../../behavior/convex/staff/boxes.test.ts");
	const table = /const ENDPOINTS = \{([\s\S]*?)\n\t\} as const;/.exec(source);
	return [...(table?.[1] ?? "").matchAll(/^\t\t(\w+):/gm)].map(
		(match) => match[1] as string
	);
}

describe("every staff endpoint is checked against a non-staff caller", () => {
	// A green run has to mean the lists matched, not that a regex stopped
	// finding either of them.
	test("both lists are still being read", () => {
		expect(publicEndpoints().length).toBeGreaterThan(10);
		expect(coveredEndpoints().length).toBeGreaterThan(10);
	});

	test("the authorization table names every one of them", () => {
		expect([...coveredEndpoints()].sort()).toEqual(
			[...publicEndpoints()].sort()
		);
	});
});
