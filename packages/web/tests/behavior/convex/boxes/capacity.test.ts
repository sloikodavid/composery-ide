import { describe, expect, test } from "vitest";
import {
	CAPACITY_BOX_STATUSES,
	readCapacityUsage,
	capacityAvailability,
	capacityBlockMessage,
	largestSnapshotSlotsPerBox,
	reservedSnapshotCommitments,
	RESERVED_SNAPSHOT_SLOTS,
	snapshotSlotsForPlan
} from "@/convex/boxes/capacity";
import { vBoxStatus } from "@/convex/schema";

import {
	seedBox,
	seedSettings,
	seedUser,
	testConvex,
	type Harness
} from "../../../support/convex.ts";
import { BOX_PLANS } from "@/convex/model/box/plan";

describe("box capacity", () => {
	// These lists are hand-written subsets of the status union, so the type
	// checker cannot notice a missing one - a new status would silently stop
	// occupying capacity and the fleet would be over-committed by exactly the
	// boxes in it. Pin the rule instead: every status that is not "deleted"
	// holds a server.
	test("counts every live status against capacity", () => {
		const live = vBoxStatus.members
			.map((member) => member.value)
			.filter((status) => status !== "deleted");

		expect([...CAPACITY_BOX_STATUSES].sort()).toEqual(live.sort());
	});

	test("fails closed until both Hetzner allocations are configured", () => {
		expect(
			capacityAvailability({
				activeCheckoutCount: 0,
				checkoutEnabled: true,
				certificateWeeklyLimit: 1000,
				issuedCertificatesThisWeek: 0,
				hetznerServerLimit: null,
				hetznerSnapshotLimit: null,
				liveBoxCount: 0,
				snapshotCommitments: 0,
				snapshotSlotsPerBox: 10
			})
		).toMatchObject({
			availableNewBoxes: 0,
			blockReason: "limits_not_configured",
			checkoutAvailable: false
		});
	});

	test("keeps a manual pause separate from calculated capacity", () => {
		expect(
			capacityAvailability({
				activeCheckoutCount: 1,
				checkoutEnabled: false,
				certificateWeeklyLimit: 1000,
				issuedCertificatesThisWeek: 0,
				hetznerServerLimit: 10,
				hetznerSnapshotLimit: 100,
				liveBoxCount: 2,
				snapshotCommitments: 30,
				snapshotSlotsPerBox: 10
			})
		).toMatchObject({
			availableNewBoxes: 7,
			blockReason: "manual_pause",
			checkoutAvailable: false,
			serverCommitments: 3
		});
	});

	test("still exposes an exhausted allocation while checkout is manually paused", () => {
		expect(
			capacityAvailability({
				activeCheckoutCount: 1,
				checkoutEnabled: false,
				certificateWeeklyLimit: 1000,
				issuedCertificatesThisWeek: 0,
				hetznerServerLimit: 3,
				hetznerSnapshotLimit: 100,
				liveBoxCount: 2,
				snapshotCommitments: 30,
				snapshotSlotsPerBox: 10
			})
		).toMatchObject({
			blockReason: "manual_pause",
			limitBlockReason: "server_limit"
		});
	});

	test("admits only the smaller of remaining server and snapshot capacity", () => {
		expect(
			capacityAvailability({
				activeCheckoutCount: 2,
				checkoutEnabled: true,
				certificateWeeklyLimit: 1000,
				issuedCertificatesThisWeek: 0,
				hetznerServerLimit: 10,
				hetznerSnapshotLimit: 65,
				liveBoxCount: 3,
				snapshotCommitments: 50,
				snapshotSlotsPerBox: 10
			})
		).toMatchObject({
			availableNewBoxes: 1,
			blockReason: null,
			checkoutAvailable: true
		});
	});

	test("blocks when either complete package no longer fits", () => {
		const common = {
			activeCheckoutCount: 1,
			checkoutEnabled: true,
			certificateWeeklyLimit: 1000,
			issuedCertificatesThisWeek: 0,
			liveBoxCount: 4,
			snapshotSlotsPerBox: 10
		};
		expect(
			capacityAvailability({
				...common,
				hetznerServerLimit: 5,
				hetznerSnapshotLimit: 100,
				snapshotCommitments: 50
			}).blockReason
		).toBe("server_limit");
		expect(
			capacityAvailability({
				...common,
				hetznerServerLimit: 10,
				hetznerSnapshotLimit: 59,
				snapshotCommitments: 50
			}).blockReason
		).toBe("snapshot_limit");
	});

	// A box commits the snapshot allowance its plan sells, and only that. How the
	// owner splits it between automatic and manual moves slots between columns and
	// never changes the total, so the fleet's commitment cannot be moved by a
	// slider - which is exactly why a plan sells a total rather than two caps.
	// What a box costs the provider allocation is what its plan sells plus the
	// slots this deployment keeps for itself. Admission has to commit both, or a
	// fleet sized exactly to the sold allowance runs out of provider images the
	// first time boxes start taking rollback snapshots.
	test("reserves the allowance a plan sells plus the slots we keep", () => {
		expect(snapshotSlotsForPlan("air")).toBe(
			BOX_PLANS.air.snapshotCap + RESERVED_SNAPSHOT_SLOTS
		);
		expect(snapshotSlotsForPlan("pro")).toBe(
			BOX_PLANS.pro.snapshotCap + RESERVED_SNAPSHOT_SLOTS
		);
		// Admission happens before a plan is chosen, so it assumes the largest.
		expect(largestSnapshotSlotsPerBox()).toBe(
			Math.max(BOX_PLANS.air.snapshotCap, BOX_PLANS.pro.snapshotCap) +
				RESERVED_SNAPSHOT_SLOTS
		);
	});

	test("reserves each box and checkout against its own plan", () => {
		expect(
			reservedSnapshotCommitments({
				activeCheckoutPlans: ["pro"],
				liveBoxes: [
					{ id: "box-a", plan: "pro" },
					{ id: "box-b", plan: "air" }
				],
				snapshotRows: [
					{ boxId: "box-a", imageId: 1, status: "complete" },
					{ boxId: "box-a", status: "pending" }
				]
			})
			// box-a holds 2 of its Pro slots and reserves the rest; box-b reserves its
			// whole Air entitlement; the active checkout reserves a full Pro one.
		).toBe(
			snapshotSlotsForPlan("pro") +
				snapshotSlotsForPlan("air") +
				snapshotSlotsForPlan("pro")
		);
	});

	test("counts over-cap and deleting provider images until they are gone", () => {
		expect(
			reservedSnapshotCommitments({
				activeCheckoutPlans: [],
				liveBoxes: [{ id: "box-a", plan: "air" }],
				snapshotRows: [
					{ boxId: "box-a", imageId: 1, status: "complete" },
					{ boxId: "box-a", imageId: 2, status: "complete" },
					{ boxId: "box-a", imageId: 3, status: "complete" },
					{ boxId: "deleted-box", imageId: 4, status: "deleting" },
					{ boxId: "box-a", status: "failed" }
				]
			})
			// box-a holds 3 active against its Air entitlement and reserves the rest;
			// the deleting image of a gone box still holds a provider slot of its own.
		).toBe(snapshotSlotsForPlan("air") + 1);
	});

	// A box downgraded while holding manual snapshots keeps them until retention
	// expires, so it can legitimately hold more than its plan now entitles it to.
	// The arithmetic must stay non-negative rather than crediting quota back.
	test("never credits quota back for a box holding more than its plan allows", () => {
		expect(
			reservedSnapshotCommitments({
				activeCheckoutPlans: [],
				liveBoxes: [{ id: "box-a", plan: "air" }],
				snapshotRows: Array.from({ length: 9 }, (_, index) => ({
					boxId: "box-a",
					imageId: index + 1,
					status: "complete" as const
				}))
			})
		).toBe(9);
	});
});

// The sentence a blocked visitor reads on the pricing page. It is the only
// public account of why they cannot buy, so a wrong or empty one turns a
// deliberate, explainable pause into a page that appears broken.
describe("what a blocked visitor is told", () => {
	test.each([
		["manual_pause", "temporarily paused"],
		["limits_not_configured", "infrastructure capacity is configured"],
		["server_limit", "server capacity is fully committed"],
		["snapshot_limit", "snapshot capacity is fully committed"]
	] as const)("explains %s in its own words", (reason, fragment) => {
		expect(capacityBlockMessage(reason)).toContain(fragment);
	});

	test("says nothing at all when checkout is open", () => {
		expect(capacityBlockMessage(null)).toBeNull();
	});

	test("gives each reason a distinct sentence", () => {
		const messages = (
			[
				"manual_pause",
				"limits_not_configured",
				"server_limit",
				"snapshot_limit"
			] as const
		).map(capacityBlockMessage);

		expect(new Set(messages).size).toBe(messages.length);
	});
});

// "Configured" means both allocations, not either. Reading it as `||` would let
// one unset limit be treated as room, which is the direction that oversells the
// fleet rather than the one that refuses a sale.
describe("a half-configured allocation", () => {
	test.each([
		["server", { hetznerServerLimit: null, hetznerSnapshotLimit: 100 }],
		["snapshot", { hetznerServerLimit: 10, hetznerSnapshotLimit: null }]
	] as const)(
		"refuses checkout with only the %s limit missing",
		(_name, limits) => {
			expect(
				capacityAvailability({
					activeCheckoutCount: 0,
					checkoutEnabled: true,
					certificateWeeklyLimit: 1000,
					issuedCertificatesThisWeek: 0,
					liveBoxCount: 0,
					snapshotCommitments: 0,
					snapshotSlotsPerBox: 3,
					...limits
				})
			).toMatchObject({
				availableNewBoxes: 0,
				blockReason: "limits_not_configured",
				checkoutAvailable: false,
				limitBlockReason: null
			});
		}
	);
});

// The boundary is "one more complete box still fits", so the last free slot has
// to be sellable. Both comparisons had a passing test either side of the edge
// and none on it.
describe("the last remaining slot", () => {
	test("still sells the final server", () => {
		expect(
			capacityAvailability({
				activeCheckoutCount: 0,
				checkoutEnabled: true,
				certificateWeeklyLimit: 1000,
				issuedCertificatesThisWeek: 0,
				hetznerServerLimit: 10,
				hetznerSnapshotLimit: 1000,
				liveBoxCount: 9,
				snapshotCommitments: 0,
				snapshotSlotsPerBox: 3
			})
		).toMatchObject({ availableNewBoxes: 1, checkoutAvailable: true });
	});

	test("still sells a box whose snapshots exactly fill the remainder", () => {
		expect(
			capacityAvailability({
				activeCheckoutCount: 0,
				checkoutEnabled: true,
				certificateWeeklyLimit: 1000,
				issuedCertificatesThisWeek: 0,
				hetznerServerLimit: 10,
				hetznerSnapshotLimit: 100,
				liveBoxCount: 0,
				snapshotCommitments: 97,
				snapshotSlotsPerBox: 3
			})
		).toMatchObject({ availableNewBoxes: 1, checkoutAvailable: true });
	});

	test("blocks on servers once the last one is taken", () => {
		expect(
			capacityAvailability({
				activeCheckoutCount: 0,
				checkoutEnabled: true,
				certificateWeeklyLimit: 1000,
				issuedCertificatesThisWeek: 0,
				hetznerServerLimit: 10,
				hetznerSnapshotLimit: 1000,
				liveBoxCount: 10,
				snapshotCommitments: 0,
				snapshotSlotsPerBox: 3
			})
		).toMatchObject({ limitBlockReason: "server_limit" });
	});

	test("blocks on snapshots one slot short of a whole package", () => {
		expect(
			capacityAvailability({
				activeCheckoutCount: 0,
				checkoutEnabled: true,
				certificateWeeklyLimit: 1000,
				issuedCertificatesThisWeek: 0,
				hetznerServerLimit: 10,
				hetznerSnapshotLimit: 100,
				liveBoxCount: 0,
				snapshotCommitments: 98,
				snapshotSlotsPerBox: 3
			})
		).toMatchObject({ limitBlockReason: "snapshot_limit" });
	});
});

// A snapshot row commits a provider slot for one of two reasons, and they are
// genuinely independent: it is going to exist, or it already does.
describe("what a snapshot row commits", () => {
	const rows = (
		status: "pending" | "complete" | "failed",
		imageId?: number
	) => [{ boxId: "box", status, imageId }];

	test("counts a pending capture that has no provider image yet", () => {
		expect(
			reservedSnapshotCommitments({
				activeCheckoutPlans: [],
				liveBoxes: [],
				snapshotRows: rows("pending")
			})
		).toBe(1);
	});

	test("counts a failed row that still holds a provider image", () => {
		expect(
			reservedSnapshotCommitments({
				activeCheckoutPlans: [],
				liveBoxes: [],
				snapshotRows: rows("failed", 42)
			})
		).toBe(1);
	});

	// An inactive row is not one of the box's snapshots, so it must not count
	// against the box's own entitlement - only against the provider image it
	// still holds, which the case above covers.
	test("does not spend a box's entitlement on an inactive row", () => {
		expect(
			reservedSnapshotCommitments({
				activeCheckoutPlans: [],
				liveBoxes: [{ id: "box", plan: "pro" }],
				snapshotRows: [
					{ boxId: "box", status: "failed", imageId: undefined },
					{ boxId: "box", status: "complete", imageId: 1 }
				]
			})
		).toBe(snapshotSlotsForPlan("pro"));
	});

	test("counts nothing for a failed row whose image never existed", () => {
		expect(
			reservedSnapshotCommitments({
				activeCheckoutPlans: [],
				liveBoxes: [],
				snapshotRows: rows("failed")
			})
		).toBe(0);
	});
});

// Reading the fleet's commitments out of the database. The arithmetic above is
// pure and was covered; what was not is which rows are fed into it - and an
// intent counted twice is a slot the fleet reserves and never sells.
describe("reading capacity from the database", () => {
	async function intent(
		t: Harness,
		slug: string,
		overrides: { status?: "active" | "released"; boxId?: string } = {}
	) {
		await t.run(
			async (ctx) =>
				await ctx.db.insert("box_checkout_intents", {
					user_id: "user_buyer",
					slug,
					plan: "pro",
					status: overrides.status ?? "active",
					box_id: overrides.boxId as never,
					created_at: 1,
					updated_at: 1
				})
		);
	}

	const usage = async (t: Harness) =>
		await t.run(async (ctx) =>
			readCapacityUsage(ctx, {
				checkoutEnabled: true,
				certificateWeeklyLimit: 1000,
				hetznerServerLimit: 100,
				hetznerSnapshotLimit: 1000
			})
		);

	test("counts a live box and an outstanding checkout as separate commitments", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		await seedBox(t, { user_id: owner.clerkUserId, slug: "live" });
		await intent(t, "buying");

		expect(await usage(t)).toMatchObject({
			liveBoxCount: 1,
			activeCheckoutCount: 1,
			serverCommitments: 2
		});
	});

	// An intent that has already become a box is counted once, as the box. It
	// stays `active` until the workflow finishes, so without this the fleet
	// reserves a second server and a second snapshot package for a box it is
	// already holding one for.
	test("counts a converted checkout once, as the box it became", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "live"
		});
		await intent(t, "live", { boxId });

		expect(await usage(t)).toMatchObject({
			liveBoxCount: 1,
			activeCheckoutCount: 0,
			serverCommitments: 1
		});
	});

	test("ignores a checkout that is no longer active", async () => {
		const t = testConvex();
		await seedSettings(t);
		await intent(t, "abandoned", { status: "released" });

		expect(await usage(t)).toMatchObject({
			activeCheckoutCount: 0,
			serverCommitments: 0
		});
	});

	// The rows that already exist, read from the table rather than assumed. A box
	// that has filled some of its entitlement does not reserve those slots twice,
	// and a row belonging to no live box still holds the provider image it made.
	test("counts a box's existing snapshots inside its own entitlement", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "live",
			plan: "pro"
		});
		await t.run(async (ctx) => {
			await ctx.db.insert("box_snapshots", {
				box_id: boxId,
				class: "manual",
				status: "complete",
				hetzner_image_id: 1,
				created_at: 1
			});
		});

		expect(await usage(t)).toMatchObject({
			snapshotCommitments: snapshotSlotsForPlan("pro")
		});
	});

	test("keeps counting a snapshot whose box is already gone", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "gone",
			status: "deleted"
		});
		await t.run(async (ctx) => {
			await ctx.db.insert("box_snapshots", {
				box_id: boxId,
				class: "manual",
				status: "complete",
				hetzner_image_id: 7,
				created_at: 1
			});
		});

		expect(await usage(t)).toMatchObject({
			liveBoxCount: 0,
			snapshotCommitments: 1
		});
	});

	// A deleted box holds no Hetzner server, so its tombstone must not keep
	// reserving one - that is a slot the fleet can never sell again.
	test("stops counting a box once it is deleted", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "gone",
			status: "deleted"
		});

		expect(await usage(t)).toMatchObject({
			liveBoxCount: 0,
			serverCommitments: 0
		});
	});
});
