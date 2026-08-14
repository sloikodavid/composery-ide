import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import schema from "@/convex/schema";

import {
	scheduledJobs,
	seedBox,
	stubDeploymentEnv,
	testConvex,
	type Harness
} from "../../../support/convex.ts";

// A purged box must leave nothing behind that still points at it.
//
// Purging cannot derive one generic action from `box_id`: most rows are deleted,
// billing evidence is unlinked and retained, and snapshots hand off to provider
// cleanup - and Convex needs a literal table name at each query boundary, so the
// policy list inside `purgeBox` genuinely has to be written out. What must not
// happen is a table being added to the schema and quietly missed by it, leaving
// a box's rows in the database for ever.
//
// The set of tables to check is read from the schema, so a new box-keyed table
// is covered the day it exists. This used to be a grep for `.query("<table>")`
// in `purgeBox`'s source, which proved only that the name appeared - not that
// the rows went - and which broke outright the moment anything instrumented the
// file it was reading. Running the mutation answers the real question.

const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	stubDeploymentEnv();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

const tables = schema.tables as Record<
	string,
	{ validator?: { fields?: Record<string, unknown> } }
>;

const BOX_KEYED_TABLES = Object.keys(tables).filter((name) =>
	Boolean(tables[name]?.validator?.fields?.box_id)
);

// One plausible row per box-keyed table. Written out because each table's other
// required fields are its own; the *set* of tables is still derived, and the
// test below fails if this list stops covering it.
function rowFor(
	table: string,
	boxId: Id<"boxes">
): Record<string, unknown> | null {
	const metrics = {
		box_id: boxId,
		cpu_percent: 1,
		ingress_bps: 1,
		egress_bps: 1,
		ingress_pps: 1,
		egress_pps: 1,
		disk_read_bps: 1,
		disk_write_bps: 1
	};
	switch (table) {
		case "box_auth_codes":
			return {
				box_id: boxId,
				code_hash: "hash",
				code_challenge: "challenge",
				redirect_uri: "https://box.test/ide/",
				type: "password",
				expires_at: NOW + 1000,
				created_at: NOW
			};
		case "box_auth_grants":
			return {
				box_id: boxId,
				token_hash: "hash",
				expires_at: NOW + 1000,
				created_at: NOW
			};
		case "box_operations":
			return {
				box_id: boxId,
				type: "create",
				status: "succeeded",
				idempotency_key: "key",
				trigger: "owner",
				created_at: NOW,
				updated_at: NOW
			};
		case "box_events":
			return {
				box_id: boxId,
				user_id: "owner",
				type: "box.create_started",
				created_at: NOW
			};
		case "box_metrics":
			return { ...metrics, sampled_at: NOW };
		case "box_metrics_hourly":
			return { ...metrics, hour_start: NOW, sample_count: 1 };
		case "box_flags":
			return {
				box_id: boxId,
				signal: "egress_bandwidth",
				value: 1,
				threshold: 1,
				message: "flagged",
				auto_suspended: false,
				created_at: NOW
			};
		case "box_usage":
			return {
				box_id: boxId,
				signal: "disk",
				used_bytes: 1,
				allowance_bytes: 2,
				sampled_at: NOW
			};
		case "box_health":
			return {
				box_id: boxId,
				consecutive_failures: 0,
				updated_at: NOW
			};
		case "box_checkout_intents":
			return {
				box_id: boxId,
				user_id: "owner",
				slug: "purged",
				plan: "air",
				status: "converted",
				created_at: NOW,
				updated_at: NOW
			};
		case "box_snapshots":
			return {
				box_id: boxId,
				class: "manual",
				status: "complete",
				created_at: NOW
			};
		default:
			return null;
	}
}

async function rowsPointingAt(t: Harness, boxId: Id<"boxes">) {
	return await t.run(async (ctx) => {
		const found: string[] = [];
		for (const table of BOX_KEYED_TABLES) {
			const rows = await ctx.db
				.query(table as "box_events")
				.collect()
				.catch(() => [] as Doc<"box_events">[]);
			if (rows.some((row) => (row as { box_id?: string }).box_id === boxId)) {
				found.push(table);
			}
		}
		return found.sort();
	});
}

describe("purging a box", () => {
	test("has a row shape for every box-keyed table the schema declares", () => {
		expect(BOX_KEYED_TABLES.length).toBeGreaterThan(5);
		expect(
			BOX_KEYED_TABLES.filter(
				(table) => rowFor(table, "x" as Id<"boxes">) === null
			)
		).toEqual([]);
	});

	// The whole point: after the purge settles, nothing anywhere still names the
	// box. A table `purgeBox` forgot shows up here as a table name in the list.
	test("leaves no row in any box-keyed table still naming it", async () => {
		const t = testConvex();
		const boxId = await seedBox(t, {
			user_id: "owner",
			status: "deleted",
			purge_at: NOW - 1000
		});
		await t.run(async (ctx) => {
			for (const table of BOX_KEYED_TABLES) {
				const row = rowFor(table, boxId);
				if (row) await ctx.db.insert(table as "box_events", row as never);
			}
		});
		expect(await rowsPointingAt(t, boxId)).toEqual(
			[...BOX_KEYED_TABLES].sort()
		);

		// Snapshots hand off to provider cleanup and re-drive the purge, so it
		// takes more than one pass to settle.
		for (let pass = 0; pass < 5; pass += 1) {
			await t.mutation(internal.boxes.cleanup.purgeBox, { boxId });
			await t.run(async (ctx) => {
				for (const snapshot of await ctx.db.query("box_snapshots").collect()) {
					await ctx.db.delete(snapshot._id);
				}
			});
		}

		expect(await rowsPointingAt(t, boxId)).toEqual([]);
	});

	// Billing evidence outlives the box it was sold for, so its row is unlinked
	// rather than deleted - which is why the assertion above is "nothing points
	// at the box" and not "nothing is left".
	test("keeps the checkout record, unlinked, rather than deleting it", async () => {
		const t = testConvex();
		const boxId = await seedBox(t, {
			user_id: "owner",
			status: "deleted",
			purge_at: NOW - 1000
		});
		await t.run(
			async (ctx) =>
				await ctx.db.insert(
					"box_checkout_intents",
					rowFor("box_checkout_intents", boxId) as never
				)
		);

		await t.mutation(internal.boxes.cleanup.purgeBox, { boxId });

		const intents = await t.run(
			async (ctx) => await ctx.db.query("box_checkout_intents").collect()
		);
		expect(intents).toHaveLength(1);
		expect(intents[0].box_id).toBeUndefined();
		// The slug goes with the link, so a purged box's name is free again.
		expect(intents[0].slug).not.toBe("purged");
	});

	test("hands each snapshot to provider cleanup rather than dropping the row", async () => {
		const t = testConvex();
		const boxId = await seedBox(t, {
			user_id: "owner",
			status: "deleted",
			purge_at: NOW - 1000
		});
		await t.run(
			async (ctx) =>
				await ctx.db.insert(
					"box_snapshots",
					rowFor("box_snapshots", boxId) as never
				)
		);

		await t.mutation(internal.boxes.cleanup.purgeBox, { boxId });

		expect(await scheduledJobs(t, "boxes/snapshots:runDelete")).toHaveLength(1);
	});

	// Only a box that is deleted and past its retention may be purged, so a live
	// box handed to the same mutation keeps everything.
	test("refuses a box that is not deleted, or not yet due", async () => {
		const t = testConvex();
		const live = await seedBox(t, { user_id: "owner", slug: "live" });
		const early = await seedBox(t, {
			user_id: "owner",
			slug: "early",
			status: "deleted",
			purge_at: NOW + 1000
		});
		for (const boxId of [live, early]) {
			await t.run(
				async (ctx) =>
					await ctx.db.insert(
						"box_events",
						rowFor("box_events", boxId) as never
					)
			);
		}

		await t.mutation(internal.boxes.cleanup.purgeBox, { boxId: live });
		await t.mutation(internal.boxes.cleanup.purgeBox, { boxId: early });

		expect(await rowsPointingAt(t, live)).toEqual(["box_events"]);
		expect(await rowsPointingAt(t, early)).toEqual(["box_events"]);
	});
});
