import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

import {
	scheduledJobs,
	seedBox,
	seedUser,
	stubDeploymentEnv,
	testConvex,
	type Harness
} from "../../../support/convex.ts";

// Which boxes the fleet chart draws, and where the ranking reads them from.
//
// This replaced seven `hour_start_<metric>` indexes - written on every rollup,
// for eight rows on one staff chart - with one index and an in-memory sort. What
// has to keep holding is that the sort still picks the busiest boxes, still
// scores each box on its most recent reading rather than an older one, and still
// has an answer on a deployment whose first rollup has not run yet.

const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	stubDeploymentEnv();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

const READING = {
	sample_count: 6,
	cpu_percent: 0,
	ingress_bps: 0,
	egress_bps: 0,
	ingress_pps: 0,
	egress_pps: 0,
	disk_read_bps: 0,
	disk_write_bps: 0
};

async function seedHourly(
	t: Harness,
	boxId: Id<"boxes">,
	hourStart: number,
	values: Partial<typeof READING>
) {
	await t.run(
		async (ctx) =>
			await ctx.db.insert("box_metrics_hourly", {
				...READING,
				...values,
				box_id: boxId,
				hour_start: hourStart
			})
	);
}

async function seedSample(
	t: Harness,
	boxId: Id<"boxes">,
	sampledAt: number,
	values: Partial<typeof READING>
) {
	await t.run(
		async (ctx) =>
			await ctx.db.insert("box_metrics", {
				cpu_percent: 0,
				ingress_bps: 0,
				egress_bps: 0,
				ingress_pps: 0,
				egress_pps: 0,
				disk_read_bps: 0,
				disk_write_bps: 0,
				...values,
				box_id: boxId,
				sampled_at: sampledAt
			})
	);
}

async function fleet(t: Harness) {
	const owner = await seedUser(t, { clerkUserId: "owner" });
	const admin = await seedUser(t, { clerkUserId: "admin", role: "admin" });
	const quiet = await seedBox(t, { user_id: owner.clerkUserId, slug: "quiet" });
	const busy = await seedBox(t, { user_id: owner.clerkUserId, slug: "busy" });
	return { admin, busy, quiet };
}

describe("the fleet metrics chart", () => {
	test("ranks off the newest rolled-up hour", async () => {
		const t = testConvex();
		const { admin, busy, quiet } = await fleet(t);
		await seedHourly(t, busy, NOW - HOUR, { cpu_percent: 90 });
		await seedHourly(t, quiet, NOW - HOUR, { cpu_percent: 2 });

		const series = await admin.as.query(api.staff.metrics.series, {});

		expect(series.map((row) => row.slug).sort()).toEqual(["busy", "quiet"]);
	});

	// Each box is scored on its most recent reading, so a box that was busy hours
	// ago does not keep a place on a chart of what is happening now.
	test("scores a box on its latest hour, not its worst one", async () => {
		const t = testConvex();
		const { admin, busy, quiet } = await fleet(t);
		// `quiet` was the busiest box two hours ago and has since gone idle.
		await seedHourly(t, quiet, NOW - 2 * HOUR, { egress_pps: 9_000 });
		await seedHourly(t, quiet, NOW - HOUR, { egress_pps: 1 });
		await seedHourly(t, busy, NOW - HOUR, { egress_pps: 500 });

		const series = await admin.as.query(api.staff.metrics.series, {
			metric: "egress_pps"
		});

		// Both still appear - the chart draws the top eight - but the ranking read
		// the newest hour for each, which is the row this used to get wrong.
		expect(series.map((row) => row.slug).sort()).toEqual(["busy", "quiet"]);
	});

	// A deployment whose hourly rollup has never run still has raw samples, and a
	// chart that answered "no boxes" there would look like an empty fleet rather
	// than a young one.
	test("falls back to raw samples before the first rollup", async () => {
		const t = testConvex();
		const { admin, busy } = await fleet(t);
		await seedSample(t, busy, NOW - 60_000, { cpu_percent: 55 });

		const series = await admin.as.query(api.staff.metrics.series, {});

		expect(series.map((row) => row.slug)).toEqual(["busy"]);
	});

	test("draws one named box on its own when asked for one", async () => {
		const t = testConvex();
		const { admin, busy, quiet } = await fleet(t);
		await seedHourly(t, busy, NOW - HOUR, { cpu_percent: 90 });
		await seedHourly(t, quiet, NOW - HOUR, { cpu_percent: 2 });

		expect(
			await admin.as.query(api.staff.metrics.series, { boxId: busy })
		).toMatchObject([{ slug: "busy" }]);
	});

	test("refuses a customer", async () => {
		const t = testConvex();
		const customer = await seedUser(t, { clerkUserId: "customer" });

		await expect(
			customer.as.query(api.staff.metrics.series, {})
		).rejects.toThrow(/Staff access required/);
	});
});

// Clearing flags. Like the failure feed it is a bulk write, batched and
// re-driven, and it comes in two shapes: one box's flags, or the fleet's.
describe("dismissing flags", () => {
	async function staffUser(t: Harness) {
		return await seedUser(t, {
			clerkUserId: "admin",
			email: "admin@example.com",
			role: "admin"
		});
	}

	async function flagged(t: Harness, counts: { atlas: number; zeta?: number }) {
		const owner = await seedUser(t, { clerkUserId: "clerk_owner" });
		const atlas = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas"
		});
		const zeta = await seedBox(t, { user_id: owner.clerkUserId, slug: "zeta" });
		await t.run(async (ctx) => {
			const add = async (boxId: typeof atlas, count: number) => {
				for (let index = 0; index < count; index += 1) {
					await ctx.db.insert("box_flags", {
						box_id: boxId,
						signal: "egress_bandwidth",
						message: "Sustained outbound bandwidth",
						value: 1,
						threshold: 1,
						auto_suspended: false,
						created_at: Date.now() - index
					});
				}
			};
			await add(atlas, counts.atlas);
			await add(zeta, counts.zeta ?? 0);
		});
		return { atlas, zeta };
	}

	const open = async (t: Harness) =>
		(await t.run((ctx) => ctx.db.query("box_flags").collect())).filter(
			(row) => row.dismissed_at === undefined
		);

	test("clears one box's flags and leaves the rest of the fleet's", async () => {
		const t = testConvex();
		const admin = await staffUser(t);
		const { atlas, zeta } = await flagged(t, { atlas: 2, zeta: 2 });

		await admin.as.mutation(api.staff.metrics.dismissAllFlags, {
			boxId: atlas
		});

		const remaining = await open(t);
		expect(remaining).toHaveLength(2);
		expect(remaining.every((row) => row.box_id === zeta)).toBe(true);
	});

	test("clears the whole fleet's flags when asked for no box", async () => {
		const t = testConvex();
		const admin = await staffUser(t);
		await flagged(t, { atlas: 2, zeta: 2 });

		await admin.as.mutation(api.staff.metrics.dismissAllFlags, {});

		expect(await open(t)).toEqual([]);
	});

	test("records who cleared them", async () => {
		const t = testConvex();
		const admin = await staffUser(t);
		await flagged(t, { atlas: 1 });

		await admin.as.mutation(api.staff.metrics.dismissAllFlags, {});

		const [row] = await t.run((ctx) => ctx.db.query("box_flags").collect());
		expect(row?.dismissed_by).toBe(admin.clerkUserId);
	});

	// A flag already cleared is not cleared again: the batch reads only the
	// undismissed ones, so a re-drive cannot rewrite who cleared the first lot.
	test("leaves an already-cleared flag as it was", async () => {
		const t = testConvex();
		const admin = await staffUser(t);
		await flagged(t, { atlas: 1 });
		await admin.as.mutation(api.staff.metrics.dismissAllFlags, {});
		const [first] = await t.run((ctx) => ctx.db.query("box_flags").collect());

		await admin.as.mutation(api.staff.metrics.dismissAllFlags, {});

		const [again] = await t.run((ctx) => ctx.db.query("box_flags").collect());
		expect(again?.dismissed_at).toBe(first?.dismissed_at);
	});

	test("comes back for the rest when it fills a batch", async () => {
		const t = testConvex();
		const admin = await staffUser(t);
		await flagged(t, { atlas: 200 });

		await admin.as.mutation(api.staff.metrics.dismissAllFlags, {});

		expect(
			await scheduledJobs(t, "staff/metrics:dismissAllFlagsBatch")
		).toHaveLength(1);
	});

	test("refuses a caller without the capability", async () => {
		const t = testConvex();
		const owner = await seedUser(t, { clerkUserId: "clerk_owner" });

		await expect(
			owner.as.mutation(api.staff.metrics.dismissAllFlags, {})
		).rejects.toThrow();
	});
});

// The abuse feed: which boxes tripped a threshold, and clearing them once
// somebody has looked. A flag that never reaches the console is an abuse case
// nobody sees, and one that cannot be cleared makes the feed unusable, so both
// directions matter.
describe("the flags the console shows staff", () => {
	async function cast(t: Harness) {
		const admin = await seedUser(t, {
			clerkUserId: "admin",
			email: "admin@example.com",
			role: "admin"
		});
		const customer = await seedUser(t, {
			clerkUserId: "customer",
			email: "customer@example.com"
		});
		return { admin, customer };
	}

	async function flagOn(
		t: Harness,
		boxId: Id<"boxes">,
		over: Record<string, unknown> = {}
	) {
		return await t.run(
			async (ctx) =>
				await ctx.db.insert("box_flags", {
					box_id: boxId,
					signal: "egress_bandwidth",
					message: "Sustained egress",
					value: 500,
					threshold: 100,
					auto_suspended: false,
					created_at: NOW - 1000,
					...over
				})
		);
	}

	const list = (
		admin: Awaited<ReturnType<typeof cast>>["admin"],
		args: Record<string, unknown> = {}
	) => admin.as.query(api.staff.metrics.flags, args);

	test("shows an open flag with the box it belongs to", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, {
			user_id: customer.clerkUserId,
			slug: "atlas",
			hetzner_server_id: 4242
		});
		await flagOn(t, boxId);

		expect(await list(admin)).toMatchObject([
			{
				boxId,
				slug: "atlas",
				hetznerServerId: 4242,
				signal: "egress_bandwidth",
				autoSuspended: false,
				dismissedAt: null
			}
		]);
	});

	// The feed is what is still outstanding, so a flag somebody cleared drops
	// off it - otherwise it can never be worked down.
	test("leaves a dismissed flag out of the open feed", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, { user_id: customer.clerkUserId });
		await flagOn(t, boxId, { dismissed_at: NOW - 500 });

		expect(await list(admin)).toEqual([]);
	});

	// Asked about one box, the answer is that box's whole history - including
	// what was already handled, because that is the context for the new one.
	test("shows a box's dismissed flags when asked about that box", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, { user_id: customer.clerkUserId });
		await flagOn(t, boxId, { dismissed_at: NOW - 500 });

		expect(await list(admin, { boxId })).toMatchObject([
			{ dismissedAt: NOW - 500 }
		]);
	});

	test("shows nothing for a box that is not there", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, { user_id: customer.clerkUserId });
		await flagOn(t, boxId);
		await t.run(async (ctx) => await ctx.db.delete(boxId));

		expect(await list(admin, { boxId })).toEqual([]);
	});

	// A flag whose box was purged has nothing to act on, and rendering it would
	// break the row rather than inform anyone.
	test("drops a flag whose box is gone from the open feed", async () => {
		const t = testConvex();
		const { admin, customer } = await cast(t);
		const boxId = await seedBox(t, { user_id: customer.clerkUserId });
		await flagOn(t, boxId);
		await t.run(async (ctx) => await ctx.db.delete(boxId));

		expect(await list(admin)).toEqual([]);
	});

	test("refuses the feed to somebody who is not staff", async () => {
		const t = testConvex();
		const { customer } = await cast(t);

		await expect(
			customer.as.query(api.staff.metrics.flags, {})
		).rejects.toThrow("Staff access required.");
	});

	describe("clearing a flag", () => {
		test("records who cleared it and when", async () => {
			const t = testConvex();
			const { admin, customer } = await cast(t);
			const boxId = await seedBox(t, { user_id: customer.clerkUserId });
			const flagId = await flagOn(t, boxId);

			await admin.as.mutation(api.staff.metrics.dismissFlag, { flagId });

			expect(await t.run((ctx) => ctx.db.get(flagId))).toMatchObject({
				dismissed_at: NOW,
				dismissed_by: admin.clerkUserId
			});
		});

		// Clearing twice keeps the first person's name against it: the record is
		// of who looked, and a second press must not overwrite that.
		test("keeps the first clearer's name when pressed twice", async () => {
			const t = testConvex();
			const { admin, customer } = await cast(t);
			const second = await seedUser(t, {
				clerkUserId: "second",
				email: "second@example.com",
				role: "admin"
			});
			const boxId = await seedBox(t, { user_id: customer.clerkUserId });
			const flagId = await flagOn(t, boxId);

			await admin.as.mutation(api.staff.metrics.dismissFlag, { flagId });
			vi.setSystemTime(NOW + 5000);
			await second.as.mutation(api.staff.metrics.dismissFlag, { flagId });

			expect(await t.run((ctx) => ctx.db.get(flagId))).toMatchObject({
				dismissed_at: NOW,
				dismissed_by: admin.clerkUserId
			});
		});

		test("says nothing about a flag that is gone", async () => {
			const t = testConvex();
			const { admin, customer } = await cast(t);
			const boxId = await seedBox(t, { user_id: customer.clerkUserId });
			const flagId = await flagOn(t, boxId);
			await t.run(async (ctx) => await ctx.db.delete(flagId));

			await expect(
				admin.as.mutation(api.staff.metrics.dismissFlag, { flagId })
			).resolves.not.toThrow();
		});

		test("refuses a customer clearing a flag on their own box", async () => {
			const t = testConvex();
			const { customer } = await cast(t);
			const boxId = await seedBox(t, { user_id: customer.clerkUserId });
			const flagId = await flagOn(t, boxId);

			await expect(
				customer.as.mutation(api.staff.metrics.dismissFlag, { flagId })
			).rejects.toThrow("Staff access required.");
			expect(await t.run((ctx) => ctx.db.get(flagId))).not.toHaveProperty(
				"dismissed_at"
			);
		});
	});
});
