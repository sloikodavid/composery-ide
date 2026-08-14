import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// Every workflow callback that reads its box refuses one that is gone.
//
// `convex/boxes/operation/record.ts` is where a workflow records what a step did. A
// workflow holds its boxId across steps that talk to Hetzner and Cloudflare and
// take minutes, so the row really can be removed underneath it by a staff purge
// or a finished delete - and the mutation that comes back would then patch a
// document that is not there.
//
// The behaviour of the guard is tested in
// `tests/behavior/convex/boxes/operation/record.test.ts`, which drives every one of these
// against a deleted box. What that cannot do is notice a callback added
// afterwards without the check: it would simply not be in the table, and every
// case there would still pass. This is that missing rung - it reads the module
// rather than running it, because "no callback anywhere lacks this" is a fact
// about the file rather than about any one call.
// ---------------------------------------------------------------------------

const source = readFileSync(
	fileURLToPath(
		new URL("../../../convex/boxes/operation/record.ts", import.meta.url)
	),
	"utf8"
);

// Each `export const <name> = internalMutation({ ... })` up to the next export.
function mutations() {
	const starts = [...source.matchAll(/export const (\w+) = internalMutation/g)];
	return starts.map((match, index) => {
		const from = match.index ?? 0;
		const to = starts[index + 1]?.index ?? source.length;
		return { body: source.slice(from, to), name: match[1] as string };
	});
}

// The ones this rule is about: a callback that looks its box up before writing
// to it. A mutation that patches by id without reading first is a different
// shape and Convex's own error is the only one available to it.
const readsItsBox = mutations().filter((mutation) =>
	mutation.body.includes("ctx.db.get(args.boxId)")
);

describe("workflow callbacks that read their box", () => {
	// A green run has to mean the rule held, not that the pattern stopped
	// matching anything.
	test("there are callbacks to check", () => {
		expect(readsItsBox.length).toBeGreaterThan(10);
	});

	test("each one refuses a box that is gone", () => {
		const unguarded = readsItsBox
			.filter(
				(mutation) =>
					!mutation.body.includes('throw new ConvexError("Box not found.")')
			)
			.map((mutation) => mutation.name);

		expect(unguarded).toEqual([]);
	});
});
