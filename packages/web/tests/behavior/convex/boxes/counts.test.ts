import { describe, expect, test } from "vitest";
import { api, internal } from "@/convex/_generated/api";
import { insertBox, readBoxesCreated } from "@/convex/boxes/counts";

import { testConvex, type Harness } from "../../../support/convex.ts";

function created(t: Harness) {
	return t.run(async (ctx) => await readBoxesCreated(ctx));
}

function makeBox(t: Harness, slug: string, box: { deleted?: boolean } = {}) {
	return t.run(
		async (ctx) =>
			await insertBox(ctx, {
				user_id: "clerk_user",
				slug,
				plan: "air",
				manual_snapshot_cap: 0,
				status: box.deleted ? "deleted" : "running",
				created_at: 1,
				updated_at: 1,
				...(box.deleted ? { deleted_at: 1, purge_at: 1 } : {})
			})
	);
}

describe("boxes created", () => {
	test("a deployment that has created nothing reports zero", async () => {
		expect(await created(testConvex())).toBe(0);
	});

	test("every box created raises the total", async () => {
		const t = testConvex();

		await makeBox(t, "one");
		expect(await created(t)).toBe(1);

		await makeBox(t, "two");
		await makeBox(t, "three");
		expect(await created(t)).toBe(3);
	});

	// The reason the total is a row of its own rather than a count of `boxes`.
	// Purge removes the box row outright once a deleted box passes its retention
	// window, so a figure derived from that table falls every time the
	// sweep runs - and the boxes it forgets cannot be counted again.
	test("purging a box does not lower the total", async () => {
		const t = testConvex();

		await makeBox(t, "kept");
		const purged = await makeBox(t, "purged", { deleted: true });
		expect(await created(t)).toBe(2);

		await t.mutation(internal.boxes.cleanup.purgeBox, { boxId: purged });

		// The row really went, so the count above is being kept by the counter
		// rather than by a purge that quietly did nothing.
		expect(await t.run(async (ctx) => await ctx.db.get(purged))).toBeNull();
		expect(await created(t)).toBe(2);
	});

	// One row, by construction, however many boxes pass through it.
	test("the count is held on a single row", async () => {
		const t = testConvex();

		await makeBox(t, "one");
		await makeBox(t, "two");

		const rows = await t.run(
			async (ctx) => await ctx.db.query("box_counts").collect()
		);
		expect(rows).toHaveLength(1);
	});

	test("a stranger can read the total", async () => {
		const t = testConvex();
		await makeBox(t, "one");

		expect(await t.query(api.site.stats.boxesCreated, {})).toBe(1);
	});
});
