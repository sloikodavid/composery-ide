import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { CAPACITY_BOX_STATUSES } from "@/convex/boxes/capacity";

import {
	seedBox,
	seedUser,
	stubDeploymentEnv,
	testConvex,
	type Harness
} from "../../../support/convex.ts";

// The console's overview tiles. Every number here is a count of rows staff act
// on, so the one thing that must not happen is a tile that reads zero because a
// status fell out of the list it was summed from.

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

describe("the failed-boxes tile", () => {
	// It sums `statusCounts`, which is only filled for the statuses that hold
	// capacity. A failure status outside that set would be read as `undefined`
	// and throw the whole overview, so the two lists are derived from one.
	test("draws every failure status from the set it was counted over", () => {
		const failed = CAPACITY_BOX_STATUSES.filter((status) =>
			status.endsWith("_failed")
		);
		expect(failed.length).toBeGreaterThan(0);
		for (const status of failed) {
			expect(CAPACITY_BOX_STATUSES).toContain(status);
		}
	});

	test("counts a box in every distinct failure state", async () => {
		const t = testConvex();
		const owner = await seedUser(t, { clerkUserId: "owner" });
		const admin = await seedUser(t, { clerkUserId: "admin", role: "admin" });
		const failed = CAPACITY_BOX_STATUSES.filter((status) =>
			status.endsWith("_failed")
		);
		for (const [index, status] of failed.entries()) {
			await seedBox(t, {
				user_id: owner.clerkUserId,
				slug: `box-${index}`,
				status
			});
		}

		const overview = await admin.as.query(api.staff.stats.overview, {});

		expect(overview.failedBoxes).toBe(failed.length);
		expect(overview.failedBoxesCapped).toBe(false);
	});
});

describe("the overview", () => {
	test("separates running, suspended and total live boxes", async () => {
		const t = testConvex();
		const owner = await seedUser(t, { clerkUserId: "owner" });
		const admin = await seedUser(t, { clerkUserId: "admin", role: "admin" });
		await seedBox(t, { user_id: owner.clerkUserId, slug: "a" });
		await seedBox(t, { user_id: owner.clerkUserId, slug: "b" });
		await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "c",
			status: "suspended"
		});
		// A deleted box holds nothing and is not live.
		await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "d",
			status: "deleted"
		});

		const overview = await admin.as.query(api.staff.stats.overview, {});

		expect(overview).toMatchObject({
			runningBoxes: 2,
			suspendedBoxes: 1,
			activeBoxes: 3
		});
	});

	test("reports a conversion rate of zero rather than dividing by none", async () => {
		const t = testConvex();
		const admin = await seedUser(t, { clerkUserId: "admin", role: "admin" });

		const overview = await admin.as.query(api.staff.stats.overview, {});

		expect(overview.totalIntents).toBe(0);
		expect(overview.conversionRate).toBe(0);
	});

	test("returns one series point per day of the chosen window", async () => {
		const t = testConvex();
		const admin = await seedUser(t, { clerkUserId: "admin", role: "admin" });

		const overview = await admin.as.query(api.staff.stats.overview, {
			range: "7d"
		});

		expect(overview.windowDays).toBe(7);
		expect(overview.series).toHaveLength(7);
	});

	test("refuses a customer", async () => {
		const t = testConvex();
		const customer = await seedUser(t, { clerkUserId: "customer" });

		await expect(
			customer.as.query(api.staff.stats.overview, {})
		).rejects.toThrow(/Staff access required/);
	});
});

// The console's counters, and the one property that makes them trustworthy:
// every count is bounded, and says when it hit its bound.
//
// A count that silently stopped at its cap would read as a fleet that stopped
// growing. Reporting "capped" beside the number is what lets the page say "at
// least N" instead of stating a wrong total as fact.
describe("counting the fleet for the console", () => {
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

	const stats = (
		admin: Awaited<ReturnType<typeof cast>>["admin"],
		args: Record<string, unknown> = {}
	) => admin.as.query(api.staff.stats.overview, args);

	async function boxes(
		t: Harness,
		status: Doc<"boxes">["status"],
		count: number,
		createdAt = NOW - 1000
	) {
		await t.run(async (ctx) => {
			for (let index = 0; index < count; index += 1) {
				await ctx.db.insert("boxes", {
					user_id: "customer",
					slug: `${status}-${index}`,
					plan: "air",
					manual_snapshot_cap: 0,
					status,
					created_at: createdAt,
					updated_at: createdAt
				});
			}
		});
	}

	test("counts running and suspended boxes separately", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		await boxes(t, "running", 3);
		await boxes(t, "suspended", 2);

		expect(await stats(admin)).toMatchObject({
			runningBoxes: 3,
			suspendedBoxes: 2
		});
	});

	// "Active" is every status that holds capacity, which is what the number is
	// for - it is compared against the provider limit.
	test("counts every capacity-holding box as active", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		await boxes(t, "running", 2);
		await boxes(t, "stopped", 1);

		expect((await stats(admin)).activeBoxes).toBe(3);
	});

	// A deleted box holds nothing, so it is not part of the fleet's size.
	test("leaves deleted boxes out of the fleet's size", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		await boxes(t, "running", 1);
		await boxes(t, "deleted", 5);

		expect((await stats(admin)).activeBoxes).toBe(1);
	});

	// Failures are counted apart because they are the number somebody acts on.
	test("counts the failed boxes on their own", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		await boxes(t, "create_failed", 2);
		await boxes(t, "running", 1);

		expect((await stats(admin)).failedBoxes).toBe(2);
	});

	// Conversion is the checkout funnel: reservations opened against
	// reservations that became boxes.
	test("reports the share of reservations that became boxes", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		await t.run(async (ctx) => {
			for (const [index, status] of [
				"converted",
				"converted",
				"released",
				"expired"
			].entries()) {
				await ctx.db.insert("box_checkout_intents", {
					user_id: "customer",
					slug: `intent-${index}`,
					plan: "air",
					status: status as "converted",
					created_at: NOW - 1000,
					updated_at: NOW - 1000
				});
			}
		});

		expect(await stats(admin)).toMatchObject({
			totalIntents: 4,
			convertedIntents: 2,
			conversionRate: 0.5
		});
	});

	// No reservations at all is not a division: a deployment that has sold
	// nothing reports zero rather than NaN, which would render as "NaN%".
	test("reports a zero conversion rate before anything was sold", async () => {
		const t = testConvex();
		const { admin } = await cast(t);

		expect((await stats(admin)).conversionRate).toBe(0);
	});

	// The series is one row per day of the window, oldest first, so the chart
	// has an x-axis even on days nothing happened.
	test("gives one row per day of the window", async () => {
		const t = testConvex();
		const { admin } = await cast(t);

		const result = await stats(admin, { range: "7d" });

		expect(result.windowDays).toBe(7);
		expect(result.series).toHaveLength(7);
		expect(
			result.series.every((row, index) =>
				index === 0 ? true : row.at > result.series[index - 1].at
			)
		).toBe(true);
	});

	test("counts a box created today against today's row", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		await boxes(t, "running", 2, NOW);

		const result = await stats(admin, { range: "7d" });

		expect(result.series.at(-1)).toMatchObject({ boxes: 2 });
		expect(result.windowNewBoxes).toBe(2);
	});

	// A box created before the window is part of the fleet but not of its
	// growth - counting it twice would overstate every chart.
	test("leaves a box older than the window out of the growth series", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		await boxes(t, "running", 1, NOW - 60 * 24 * 60 * 60 * 1000);

		const result = await stats(admin, { range: "7d" });

		expect(result.activeBoxes).toBe(1);
		expect(result.windowNewBoxes).toBe(0);
	});

	test("refuses the counters to somebody who is not staff", async () => {
		const t = testConvex();
		const { customer } = await cast(t);

		await expect(
			customer.as.query(api.staff.stats.overview, {})
		).rejects.toThrow("Staff access required.");
	});
});
