import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import {
	DEFAULT_SNAPSHOT_POLICY,
	SNAPSHOT_INCOMPLETE_RETENTION_MS
} from "@/convex/boxes/snapshotPolicy";
import {
	type BoxPlan,
	BOX_PLANS,
	resolveSnapshotSplit
} from "@/convex/model/box/plan";

// The manual half of a Box Pro box's allowance, at the split a new one is
// created with. Read rather than written down, so changing the plan's default
// moves these tests with it instead of leaving them asserting a stale number.
const PRO_MANUAL_CAP = resolveSnapshotSplit(
	"pro",
	BOX_PLANS.pro.snapshotManualDefault
).manual;
const PRO_AUTOMATIC_CAP = resolveSnapshotSplit(
	"pro",
	BOX_PLANS.pro.snapshotManualDefault
).automatic;

import {
	boxEvents,
	boxOperations,
	readBox,
	readOperation,
	scheduledArgs,
	scheduledJobs,
	seedBox,
	seedSettings,
	seedUser,
	stubDeploymentEnv,
	testConvex,
	type Caller,
	type Harness
} from "../../../support/convex.ts";

// Snapshots are the one thing on a box that both costs money while it exists and
// is the owner's only copy of their files, so both directions are dangerous: an
// uncapped snapshot bills forever, and an over-eager eviction destroys the copy
// someone was relying on. The rule the tests below defend is that manual
// snapshots are refused at the cap and never evicted, while automatic ones roll.
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const NOW = Date.UTC(2026, 6, 7, 8, 9, 10);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	stubDeploymentEnv();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

type SnapshotSeed = {
	class?: Doc<"box_snapshots">["class"];
	createdAt?: number;
	expiresAt?: number;
	imageId?: number;
	status?: Doc<"box_snapshots">["status"];
};

async function seedSnapshot(
	t: Harness,
	boxId: Id<"boxes">,
	seed: SnapshotSeed = {}
) {
	return await t.run(
		async (ctx) =>
			await ctx.db.insert("box_snapshots", {
				box_id: boxId,
				class: seed.class ?? "manual",
				status: seed.status ?? "complete",
				hetzner_image_id: seed.imageId,
				created_at: seed.createdAt ?? NOW - DAY_MS,
				expires_at: seed.expiresAt
			})
	);
}

function snapshotsOf(t: Harness, boxId: Id<"boxes">) {
	return t.run(
		async (ctx) =>
			await ctx.db
				.query("box_snapshots")
				.withIndex("box_id_created_at", (q) => q.eq("box_id", boxId))
				.collect()
	);
}

// Capture-on-demand is a plan capability, so every test about the manual path
// needs a plan that has it. The default seed is deliberately the plan without
// one, which is why this says so rather than relying on it.
async function ownedRunningBox(t: Harness, plan: BoxPlan = "pro") {
	const owner = await seedUser(t, { clerkUserId: "owner" });
	const boxId = await seedBox(t, {
		user_id: owner.clerkUserId,
		plan,
		manual_snapshot_cap: BOX_PLANS[plan].snapshotManualDefault,
		slug: "mine",
		status: "running"
	});
	return { boxId, owner };
}

describe("taking a manual snapshot", () => {
	// The gate that makes on-demand capture a Pro feature. It comes before every
	// other check - a plan that cannot take one is not "at its cap" or "in
	// cooldown", it simply does not have the feature.
	test("refuses a plan without capture-on-demand snapshots", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t, "air");

		await expect(
			owner.as.mutation(api.owner.boxes.createSnapshot, { slug: "mine" })
		).rejects.toThrow(/Box Air takes automatic daily snapshots/);
		expect(await snapshotsOf(t, boxId)).toHaveLength(0);
		expect(await boxOperations(t, boxId)).toEqual([]);
	});

	// Staff are not an exception: a manual snapshot on a plan without them would
	// spend a provider slot that capacity admission never reserved for this box,
	// so the favour would really be a quiet over-subscription of the fleet.
	test("refuses staff the same capture on a plan without it", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t, "air");
		const staff = await seedUser(t, {
			clerkUserId: "staff",
			email: "staff@example.com",
			role: "admin"
		});

		await expect(
			staff.as.mutation(api.staff.boxes.createSnapshot, { boxId })
		).rejects.toThrow(/Box Air takes automatic daily snapshots/);
	});

	test("starts a snapshot operation for a running box", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);

		await owner.as.mutation(api.owner.boxes.createSnapshot, { slug: "mine" });

		expect(await boxOperations(t, boxId)).toMatchObject([
			{ type: "snapshot", status: "pending", trigger: "owner" }
		]);
	});

	// The capture is taken off the running server, so there is nothing to capture
	// from a stopped one.
	test("refuses a snapshot of a box that is not running", async () => {
		const t = testConvex();
		const owner = await seedUser(t, { clerkUserId: "owner" });
		await seedBox(t, {
			user_id: owner.clerkUserId,
			plan: "pro",
			manual_snapshot_cap: BOX_PLANS.pro.snapshotManualDefault,
			slug: "mine",
			status: "stopped"
		});

		await expect(
			owner.as.mutation(api.owner.boxes.createSnapshot, { slug: "mine" })
		).rejects.toThrow(/only available while the box is running/);
	});

	test("refuses a second snapshot while one is still being captured", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		await seedSnapshot(t, boxId, {
			status: "creating",
			createdAt: NOW - DAY_MS
		});

		await expect(
			owner.as.mutation(api.owner.boxes.createSnapshot, { slug: "mine" })
		).rejects.toThrow(/already in progress/);
	});

	test("refuses a snapshot taken inside the manual cooldown", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		await seedSnapshot(t, boxId, {
			createdAt:
				NOW - DEFAULT_SNAPSHOT_POLICY.manualMinIntervalMinutes * MINUTE_MS + 1
		});

		await expect(
			owner.as.mutation(api.owner.boxes.createSnapshot, { slug: "mine" })
		).rejects.toThrow(/moments ago/);
	});

	test("allows a snapshot once the cooldown has passed", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		await seedSnapshot(t, boxId, {
			createdAt:
				NOW - DEFAULT_SNAPSHOT_POLICY.manualMinIntervalMinutes * MINUTE_MS - 1
		});

		await owner.as.mutation(api.owner.boxes.createSnapshot, { slug: "mine" });

		expect(await boxOperations(t, boxId)).toHaveLength(1);
	});

	// Manual snapshots are the owner's own checkpoints. At the cap the answer is
	// "delete one", never "we deleted your oldest one for you".
	test("refuses a manual snapshot at the cap rather than evicting one", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		for (let index = 0; index < PRO_MANUAL_CAP; index += 1) {
			await seedSnapshot(t, boxId, {
				createdAt: NOW - DAY_MS * (index + 2)
			});
		}

		await expect(
			owner.as.mutation(api.owner.boxes.createSnapshot, { slug: "mine" })
		).rejects.toThrow(/snapshot limit/);
		expect(await snapshotsOf(t, boxId)).toHaveLength(PRO_MANUAL_CAP);
	});

	// A box full of automatic snapshots must not block the owner's own.
	test("counts only manual snapshots against the manual cap", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		for (let index = 0; index < PRO_MANUAL_CAP; index += 1) {
			await seedSnapshot(t, boxId, {
				class: "scheduled",
				createdAt: NOW - DAY_MS * (index + 2)
			});
		}

		await owner.as.mutation(api.owner.boxes.createSnapshot, { slug: "mine" });

		expect(await boxOperations(t, boxId)).toHaveLength(1);
	});
});

// The owner moves slots between the two columns. It costs the fleet nothing -
// the total is what the plan sold - so the interesting cases are the ends of the
// range and what happens to snapshots already held on the side being shrunk.
describe("splitting a box's snapshot allowance", () => {
	test("moves slots between automatic and manual without changing the total", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		const cap = BOX_PLANS.pro.snapshotCap;

		await owner.as.mutation(api.owner.boxes.setSnapshotSplit, {
			manualCap: cap,
			slug: "mine"
		});

		const box = await t.run(async (ctx) => await ctx.db.get(boxId));
		expect(resolveSnapshotSplit("pro", box!.manual_snapshot_cap)).toEqual({
			automatic: 0,
			manual: cap
		});
	});

	test("refuses more than the plan sells", async () => {
		const t = testConvex();
		const { owner } = await ownedRunningBox(t);

		await expect(
			owner.as.mutation(api.owner.boxes.setSnapshotSplit, {
				manualCap: BOX_PLANS.pro.snapshotCap + 1,
				slug: "mine"
			})
		).rejects.toThrow(/includes/);
	});

	// A plan without manual snapshots has nothing to split, and saying so is
	// better than silently storing a number that resolves back to zero.
	test("refuses a split on a plan without manual snapshots", async () => {
		const t = testConvex();
		const { owner } = await ownedRunningBox(t, "air");

		await expect(
			owner.as.mutation(api.owner.boxes.setSnapshotSplit, {
				manualCap: 1,
				slug: "mine"
			})
		).rejects.toThrow(/takes its snapshots automatically/);
	});

	// Lowering the manual side below what is already held must not delete
	// anything - those are the owner's own checkpoints. New ones are simply
	// refused until the existing ones expire or are removed, which is the rule a
	// full manual allowance has always followed.
	test("keeps snapshots already held when their side is shrunk", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		for (let index = 0; index < PRO_MANUAL_CAP; index += 1) {
			await seedSnapshot(t, boxId, {
				createdAt: NOW - DAY_MS * (index + 2)
			});
		}

		await owner.as.mutation(api.owner.boxes.setSnapshotSplit, {
			manualCap: 0,
			slug: "mine"
		});

		expect(await snapshotsOf(t, boxId)).toHaveLength(PRO_MANUAL_CAP);
		await expect(
			owner.as.mutation(api.owner.boxes.createSnapshot, { slug: "mine" })
		).rejects.toThrow(/snapshot limit/);
	});

	// Raising the manual side is what unblocks a box that was at its cap.
	test("lets a box at its manual cap take another once the split is raised", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		for (let index = 0; index < PRO_MANUAL_CAP; index += 1) {
			await seedSnapshot(t, boxId, {
				createdAt: NOW - DAY_MS * (index + 2)
			});
		}

		await owner.as.mutation(api.owner.boxes.setSnapshotSplit, {
			manualCap: PRO_MANUAL_CAP + 1,
			slug: "mine"
		});
		await owner.as.mutation(api.owner.boxes.createSnapshot, { slug: "mine" });

		expect(await boxOperations(t, boxId)).toHaveLength(1);
	});
});

describe("opening a snapshot row", () => {
	test("records the new snapshot as pending with a short incomplete expiry", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);

		const { snapshotRowId } = await t.mutation(
			internal.boxes.snapshots.beginSnapshot,
			{ boxId, class: "manual" }
		);

		expect(
			await t.run(async (ctx) => await ctx.db.get(snapshotRowId))
		).toMatchObject({
			status: "pending",
			class: "manual",
			expires_at: NOW + SNAPSHOT_INCOMPLETE_RETENTION_MS
		});
	});

	// Automatic snapshots roll: the cap is a window, so the oldest finished one is
	// dropped to make room rather than the capture being refused.
	test("evicts the oldest automatic snapshot to make room for a new one", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const oldest = await seedSnapshot(t, boxId, {
			class: "scheduled",
			createdAt: NOW - DAY_MS * 10
		});
		for (let index = 1; index < PRO_AUTOMATIC_CAP; index += 1) {
			await seedSnapshot(t, boxId, {
				class: "scheduled",
				createdAt: NOW - DAY_MS * (10 - index)
			});
		}

		await t.mutation(internal.boxes.snapshots.beginSnapshot, {
			boxId,
			class: "scheduled"
		});

		expect(
			await scheduledArgs<{ snapshotRowId: Id<"box_snapshots"> }>(
				t,
				"boxes/snapshots:runDelete"
			)
		).toEqual([{ snapshotRowId: oldest }]);
	});

	// Manual snapshots are never collateral for an automatic capture.
	test("never evicts a manual snapshot to make room for an automatic one", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const manual = await seedSnapshot(t, boxId, {
			class: "manual",
			createdAt: NOW - DAY_MS * 100
		});
		for (let index = 0; index < PRO_AUTOMATIC_CAP; index += 1) {
			await seedSnapshot(t, boxId, {
				class: "scheduled",
				createdAt: NOW - DAY_MS * (10 - index)
			});
		}

		await t.mutation(internal.boxes.snapshots.beginSnapshot, {
			boxId,
			class: "scheduled"
		});

		const evicted = await scheduledArgs<{
			snapshotRowId: Id<"box_snapshots">;
		}>(t, "boxes/snapshots:runDelete");
		expect(evicted.map((job) => job.snapshotRowId)).not.toContain(manual);
	});
});

describe("finishing a capture", () => {
	test("dates a finished automatic snapshot from the policy's retention window", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId, {
			class: "scheduled",
			status: "creating",
			createdAt: NOW
		});

		await t.mutation(internal.boxes.snapshots.completeSnapshot, {
			snapshotRowId,
			sizeBytes: 1234
		});

		expect(
			await t.run(async (ctx) => await ctx.db.get(snapshotRowId))
		).toMatchObject({
			status: "complete",
			size_bytes: 1234,
			expires_at: NOW + DEFAULT_SNAPSHOT_POLICY.automaticRetentionDays * DAY_MS
		});
	});

	// The rule the retention sweep depends on: a stored row with no `expires_at`
	// is a finished snapshot its owner took, and nothing else. The row carries the
	// incomplete-row window until it completes, so this is a field being cleared
	// rather than one never written - which is the part a `patch` can get wrong.
	test("leaves a finished manual snapshot with no expiry at all", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId, {
			class: "manual",
			status: "creating",
			createdAt: NOW,
			expiresAt: NOW + DAY_MS
		});

		await t.mutation(internal.boxes.snapshots.completeSnapshot, {
			snapshotRowId
		});

		const row = await t.run(async (ctx) => await ctx.db.get(snapshotRowId));
		expect(row).toMatchObject({ status: "complete" });
		expect(row?.expires_at).toBeUndefined();
	});

	// A capture whose row was claimed for deletion mid-flight finishes without
	// resurrecting it. Closing the operation is no longer this mutation's job -
	// `defineBoxWorkflow` settles it on any clean return, which is what keeps the
	// same early return from leaving one open.
	test("leaves a snapshot already claimed for deletion alone when the capture finishes", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId, {
			status: "deleting"
		});

		await t.mutation(internal.boxes.snapshots.completeSnapshot, {
			snapshotRowId
		});

		expect(
			await t.run(async (ctx) => await ctx.db.get(snapshotRowId))
		).toMatchObject({ status: "deleting" });
	});

	// The same rule from the other side: a failed capture must not resurrect a row
	// that has already been claimed for deletion.
	test("leaves a snapshot already claimed for deletion alone when the capture fails", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId, {
			status: "deleting"
		});

		await t.mutation(internal.boxes.snapshots.failSnapshot, {
			snapshotRowId,
			error: "hetzner refused"
		});

		expect(
			await t.run(async (ctx) => await ctx.db.get(snapshotRowId))
		).toMatchObject({ status: "deleting" });
	});

	test("records why a capture failed", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId, {
			status: "creating"
		});

		await t.mutation(internal.boxes.snapshots.failSnapshot, {
			snapshotRowId,
			error: "hetzner refused"
		});

		expect(
			await t.run(async (ctx) => await ctx.db.get(snapshotRowId))
		).toMatchObject({
			status: "failed",
			error: "hetzner refused",
			expires_at: NOW + SNAPSHOT_INCOMPLETE_RETENTION_MS
		});
	});
});

describe("expiring snapshots", () => {
	test("claims only snapshots whose expiry has passed", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const expired = await seedSnapshot(t, boxId, {
			expiresAt: NOW - 1
		});
		const live = await seedSnapshot(t, boxId, {
			expiresAt: NOW + 1
		});

		const claim = await t.mutation(
			internal.boxes.snapshots.claimExpiredSnapshots,
			{ limit: 10 }
		);

		expect(claim.snapshotRowIds).toEqual([expired]);
		expect(await t.run(async (ctx) => await ctx.db.get(live))).toMatchObject({
			status: "complete"
		});
	});

	// Claiming is what stops two sweeps deleting the same image twice.
	test("marks what it claimed as deleting so a second sweep skips it", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		await seedSnapshot(t, boxId, { expiresAt: NOW - 1 });

		const first = await t.mutation(
			internal.boxes.snapshots.claimExpiredSnapshots,
			{ limit: 10 }
		);
		const second = await t.mutation(
			internal.boxes.snapshots.claimExpiredSnapshots,
			{ limit: 10 }
		);

		expect(first.snapshotRowIds).toHaveLength(1);
		expect(second.snapshotRowIds).toEqual([]);
	});

	test("says there is more to do when it fills its batch", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		await seedSnapshot(t, boxId, { expiresAt: NOW - 1 });
		await seedSnapshot(t, boxId, { expiresAt: NOW - 2 });

		const claim = await t.mutation(
			internal.boxes.snapshots.claimExpiredSnapshots,
			{ limit: 1 }
		);

		expect(claim).toMatchObject({ hasMore: true });
		expect(claim.snapshotRowIds).toHaveLength(1);
	});

	// A snapshot with no expiry is one nothing has finished deciding about yet;
	// sweeping it would delete a capture in flight.
	test("leaves a snapshot with no expiry alone", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		await seedSnapshot(t, boxId, { status: "creating" });

		const claim = await t.mutation(
			internal.boxes.snapshots.claimExpiredSnapshots,
			{ limit: 10 }
		);

		expect(claim.snapshotRowIds).toEqual([]);
	});
});

describe("automatic snapshots", () => {
	test("takes an automatic snapshot of a running box", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);

		await t.mutation(internal.boxes.snapshots.startAutomaticSnapshot, {
			boxId
		});

		expect(await boxOperations(t, boxId)).toMatchObject([
			{ type: "snapshot", trigger: "system:auto_snapshot" }
		]);
	});

	// An owner who gives every slot to their own snapshots has asked for no daily
	// one. Starting an operation that then fails its capacity check would record a
	// failure every night for a box behaving exactly as configured.
	test("skips a box whose owner kept no slots for automatic snapshots", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		await owner.as.mutation(api.owner.boxes.setSnapshotSplit, {
			manualCap: BOX_PLANS.pro.snapshotCap,
			slug: "mine"
		});

		await t.mutation(internal.boxes.snapshots.startAutomaticSnapshot, {
			boxId
		});

		expect(await boxOperations(t, boxId)).toEqual([]);
	});

	test("skips a box that is not running", async () => {
		const t = testConvex();
		const owner = await seedUser(t, { clerkUserId: "owner" });
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "stopped"
		});

		await t.mutation(internal.boxes.snapshots.startAutomaticSnapshot, {
			boxId
		});

		expect(await boxOperations(t, boxId)).toEqual([]);
	});

	// A fleet-wide sweep must not fail because one box happens to be busy. The
	// box keeps whatever it was doing and the next sweep picks it up.
	test("gives way to whatever the box is already doing", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		await t.mutation(internal.boxes.operation.start.startOperation, {
			boxId,
			idempotencyKey: `stop:${boxId}`,
			trigger: "owner",
			type: "stop"
		});

		await expect(
			t.mutation(internal.boxes.snapshots.startAutomaticSnapshot, { boxId })
		).resolves.toBeNull();
		expect(await readBox(t, boxId)).toMatchObject({ status: "stopping" });
	});
});

describe("deleting a box's snapshots", () => {
	test("queues every snapshot of a box for deletion", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const first = await seedSnapshot(t, boxId, {
			imageId: 1
		});
		const second = await seedSnapshot(t, boxId, {
			imageId: 2
		});

		await t.mutation(internal.boxes.snapshots.cascadeDeleteBoxSnapshots, {
			boxId
		});

		const queued = await scheduledArgs<{
			snapshotRowId: Id<"box_snapshots">;
		}>(t, "boxes/snapshots:runDelete");
		expect(queued.map((job) => job.snapshotRowId).sort()).toEqual(
			[first, second].sort()
		);
	});

	test("leaves another box's snapshots out of the cascade", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		const otherBoxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "other"
		});
		await seedSnapshot(t, boxId);
		const untouched = await seedSnapshot(t, otherBoxId);

		await t.mutation(internal.boxes.snapshots.cascadeDeleteBoxSnapshots, {
			boxId
		});

		const queued = await scheduledArgs<{
			snapshotRowId: Id<"box_snapshots">;
		}>(t, "boxes/snapshots:runDelete");
		expect(queued.map((job) => job.snapshotRowId)).not.toContain(untouched);
		expect(await snapshotsOf(t, otherBoxId)).toHaveLength(1);
	});

	// Claiming twice must not run the Hetzner delete twice.
	test("claims a snapshot for deletion only once", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId, {
			status: "deleting",
			imageId: 7
		});

		const claim = await t.mutation(
			internal.boxes.snapshots.claimSnapshotDelete,
			{ snapshotRowId }
		);

		expect(claim).toEqual({ imageId: 7 });
		expect(
			await t.run(async (ctx) => await ctx.db.get(snapshotRowId))
		).toMatchObject({ status: "deleting" });
	});

	test("reports nothing to delete for a snapshot row that is already gone", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId);
		await t.run(async (ctx) => await ctx.db.delete(snapshotRowId));

		expect(
			await t.mutation(internal.boxes.snapshots.claimSnapshotDelete, {
				snapshotRowId
			})
		).toBeNull();
	});
});

// The cap-repair path, and the arithmetic behind it.
//
// A box can hold more automatic snapshots than its cap allows - an owner moves
// the split, staff change a plan's allowance - so admission is not "is there
// room" but "can I get back to the cap in one bounded step". Every boundary
// below decides between evicting somebody's only copy of their files and
// refusing a capture that should have been allowed, and none of them had a test
// on the boundary itself.
describe("making room for an automatic snapshot", () => {
	// Only finished snapshots can be evicted: a pending or creating one is a
	// Hetzner action in flight, and deleting its row would orphan the image.
	async function seedAutomatic(
		t: Harness,
		boxId: Id<"boxes">,
		userId: string,
		count: number,
		status: Doc<"box_snapshots">["status"] = "complete"
	) {
		const ids: Id<"box_snapshots">[] = [];
		for (let index = 0; index < count; index += 1) {
			ids.push(
				await seedSnapshot(t, boxId, {
					class: "scheduled",
					status,
					createdAt: NOW - DAY_MS * (100 - index)
				})
			);
		}
		return ids;
	}

	const queued = (t: Harness) =>
		scheduledArgs<{ snapshotRowId: Id<"box_snapshots"> }>(
			t,
			"boxes/snapshots:runDelete"
		);

	test("evicts nothing while the box is below its cap", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		await seedAutomatic(t, boxId, owner.clerkUserId, PRO_AUTOMATIC_CAP - 1);

		await t.mutation(internal.boxes.snapshots.beginSnapshot, {
			boxId,
			class: "scheduled"
		});

		expect(await queued(t)).toEqual([]);
	});

	// One over the cap needs two gone: the one that puts it back at the cap, and
	// one more for the row about to be inserted.
	test("evicts down to the cap and one further for the new row", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		const seeded = await seedAutomatic(
			t,
			boxId,
			owner.clerkUserId,
			PRO_AUTOMATIC_CAP + 1
		);

		await t.mutation(internal.boxes.snapshots.beginSnapshot, {
			boxId,
			class: "scheduled"
		});

		// The oldest two, in age order - never the newest, which is the one an
		// owner is most likely to want back.
		expect(await queued(t)).toEqual([
			{ snapshotRowId: seeded[0] },
			{ snapshotRowId: seeded[1] }
		]);
	});

	// Beyond one bounded repair the capture is refused rather than turning into
	// an unbounded delete of an owner's history in a single mutation.
	test("refuses rather than evicting more than one repair batch", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		await seedAutomatic(t, boxId, owner.clerkUserId, PRO_AUTOMATIC_CAP * 2 + 2);

		await expect(
			t.mutation(internal.boxes.snapshots.beginSnapshot, {
				boxId,
				class: "scheduled"
			})
		).rejects.toThrow("snapshot limit");
	});

	// An in-flight capture counts against the cap but cannot be evicted, so a box
	// whose surplus is all unfinished has nothing to give up and is refused.
	test("refuses when the only surplus snapshots are still being captured", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		await seedAutomatic(
			t,
			boxId,
			owner.clerkUserId,
			PRO_AUTOMATIC_CAP + 1,
			"creating"
		);

		await expect(
			t.mutation(internal.boxes.snapshots.beginSnapshot, {
				boxId,
				class: "scheduled"
			})
		).rejects.toThrow("snapshot limit");
		expect(await queued(t)).toEqual([]);
	});

	// A failed row holds no provider image once it is gone, so it is not counted
	// as one of the box's snapshots and does not crowd out a new capture.
	test("does not count a failed capture against the cap", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		await seedAutomatic(t, boxId, owner.clerkUserId, PRO_AUTOMATIC_CAP - 1);
		await seedSnapshot(t, boxId, {
			class: "scheduled",
			status: "failed"
		});

		await t.mutation(internal.boxes.snapshots.beginSnapshot, {
			boxId,
			class: "scheduled"
		});

		expect(await queued(t)).toEqual([]);
	});
});

// The manual cap is a refusal, never an eviction: these are the owner's own
// checkpoints and nothing may delete one to make room for another.
describe("the boundary of the manual cap", () => {
	test("admits the capture that exactly fills the cap", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		for (let index = 0; index < PRO_MANUAL_CAP - 1; index += 1) {
			await seedSnapshot(t, boxId, { class: "manual" });
		}

		await expect(
			t.mutation(internal.boxes.snapshots.beginSnapshot, {
				boxId,
				class: "manual"
			})
		).resolves.toMatchObject({ snapshotRowId: expect.anything() });
	});

	test("refuses the one after it, and evicts nothing", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		for (let index = 0; index < PRO_MANUAL_CAP; index += 1) {
			await seedSnapshot(t, boxId, { class: "manual" });
		}

		await expect(
			t.mutation(internal.boxes.snapshots.beginSnapshot, {
				boxId,
				class: "manual"
			})
		).rejects.toThrow("snapshot limit");
		expect(await snapshotsOf(t, boxId)).toHaveLength(PRO_MANUAL_CAP);
	});

	// A pending manual capture holds a slot: two dialogs open at once must not
	// both be admitted and put the box one over.
	test("counts a capture already in flight against the cap", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		for (let index = 0; index < PRO_MANUAL_CAP - 1; index += 1) {
			await seedSnapshot(t, boxId, { class: "manual" });
		}
		await seedSnapshot(t, boxId, {
			class: "manual",
			status: "pending"
		});

		await expect(
			t.mutation(internal.boxes.snapshots.beginSnapshot, {
				boxId,
				class: "manual"
			})
		).rejects.toThrow("snapshot limit");
	});
});

// How much the expiry sweep claims in one pass, and how it says there is more.
//
// Every row it claims is a Hetzner image about to be deleted, and every row it
// fails to claim is one that keeps billing until the next run. The batch is
// therefore a bound on a transaction, not a bound on the work: the sweep has to
// come back for the rest, and `hasMore` is the only thing that makes it.
describe("claiming expired snapshots in batches", () => {
	async function seedExpired(
		t: Harness,
		boxId: Id<"boxes">,
		userId: string,
		count: number,
		status: Doc<"box_snapshots">["status"] = "complete"
	) {
		for (let index = 0; index < count; index += 1) {
			await seedSnapshot(t, boxId, {
				class: "scheduled",
				status,
				expiresAt: NOW - 1
			});
		}
	}

	const claim = (t: Harness, limit: number) =>
		t.mutation(internal.boxes.snapshots.claimExpiredSnapshots, { limit });

	test("claims no more than the batch it was given", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		await seedExpired(t, boxId, owner.clerkUserId, 5);

		const claimed = await claim(t, 3);

		expect(claimed.snapshotRowIds).toHaveLength(3);
	});

	// The signal that makes the sweep re-drive. A full batch means "there may be
	// more"; without it the fleet's expired images stop being deleted at whatever
	// the batch size happens to be.
	test("says there is more when it filled the batch exactly", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		await seedExpired(t, boxId, owner.clerkUserId, 3);

		expect(await claim(t, 3)).toMatchObject({ hasMore: true });
	});

	test("says there is no more when it did not fill the batch", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		await seedExpired(t, boxId, owner.clerkUserId, 2);

		expect(await claim(t, 3)).toMatchObject({ hasMore: false });
	});

	// A batch of nothing has claimed nothing, so there is nothing to come back
	// for - reporting `hasMore` here would be a sweep that reschedules itself for
	// ever without doing any work.
	test("claims nothing and reports nothing more for a batch of zero", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		await seedExpired(t, boxId, owner.clerkUserId, 3);

		expect(await claim(t, 0)).toEqual({ hasMore: false, snapshotRowIds: [] });
	});

	// The batch is spent across statuses, not per status: a fleet whose expired
	// rows are all `complete` must not be able to starve the `failed` ones, and
	// the total claimed must still respect the transaction bound.
	test("spends one batch across every deletable status", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		await seedExpired(t, boxId, owner.clerkUserId, 2, "complete");
		await seedExpired(t, boxId, owner.clerkUserId, 2, "failed");

		const claimed = await claim(t, 3);

		expect(claimed.snapshotRowIds).toHaveLength(3);
		expect(claimed.hasMore).toBe(true);
	});

	// A pending row has a Hetzner action in flight behind it. Claiming it would
	// delete the row while the image it is waiting for is still being made.
	test("never claims a row that is already being deleted", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		await seedExpired(t, boxId, owner.clerkUserId, 2, "deleting");

		expect(await claim(t, 10)).toMatchObject({ snapshotRowIds: [] });
	});
});

// Cascade deletion walks a box's whole snapshot history a page at a time, so a
// box with more snapshots than one page must not keep the ones past it - those
// images outlive the box and bill for ever.
describe("cascading through a long snapshot history", () => {
	test("resumes from the cursor it is given", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		for (let index = 0; index < 3; index += 1) {
			await seedSnapshot(t, boxId, {
				class: "scheduled",
				createdAt: NOW - DAY_MS * (10 - index)
			});
		}
		const firstPage = await t.run(
			async (ctx) =>
				await ctx.db
					.query("box_snapshots")
					.withIndex("box_id_created_at", (q) => q.eq("box_id", boxId))
					.paginate({ cursor: null, numItems: 1 })
		);

		await t.mutation(internal.boxes.snapshots.cascadeDeleteBoxSnapshots, {
			boxId,
			cursor: firstPage.continueCursor
		});

		// Everything after the cursor, and nothing before it: a cursor read as
		// "start again" would queue the first row twice.
		const queued = await scheduledArgs<{ snapshotRowId: Id<"box_snapshots"> }>(
			t,
			"boxes/snapshots:runDelete"
		);
		expect(queued).toHaveLength(2);
		expect(queued.map((job) => job.snapshotRowId)).not.toContain(
			firstPage.page[0]?._id
		);
	});
});

// The guards on a manual capture, at their boundaries. Each one is a refusal an
// owner reads as a message in a dialog, so each has to fire for its own reason
// and not for another's.
describe("the edges of the manual capture guards", () => {
	test.each(["pending", "creating"] as const)(
		"refuses while a capture is %s",
		async (status) => {
			const t = testConvex();
			const { boxId, owner } = await ownedRunningBox(t);
			await seedSnapshot(t, boxId, {
				status,
				createdAt: NOW - DAY_MS
			});

			await expect(
				owner.as.mutation(api.owner.boxes.createSnapshot, { slug: "mine" })
			).rejects.toThrow("already in progress");
		}
	);

	// A finished capture is not in progress, however recently it finished - the
	// cooldown below is what covers "moments ago", and conflating the two would
	// give the owner the wrong reason.
	test.each(["complete", "failed", "deleting"] as const)(
		"does not call a %s capture one still in progress",
		async (status) => {
			const t = testConvex();
			const { boxId, owner } = await ownedRunningBox(t);
			await seedSnapshot(t, boxId, {
				status,
				createdAt: NOW - DAY_MS
			});

			await expect(
				owner.as.mutation(api.owner.boxes.createSnapshot, { slug: "mine" })
			).resolves.not.toThrow();
		}
	);

	// Exactly the configured interval has elapsed, so the cooldown is over. One
	// millisecond either side of this is the whole difference between a setting
	// an operator configured and one that is off by a poll.
	test("admits a capture exactly one interval after the last", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		await seedSnapshot(t, boxId, {
			createdAt:
				NOW - DEFAULT_SNAPSHOT_POLICY.manualMinIntervalMinutes * MINUTE_MS
		});

		await expect(
			owner.as.mutation(api.owner.boxes.createSnapshot, { slug: "mine" })
		).resolves.not.toThrow();
	});

	test("refuses one millisecond before that", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		await seedSnapshot(t, boxId, {
			createdAt:
				NOW - DEFAULT_SNAPSHOT_POLICY.manualMinIntervalMinutes * MINUTE_MS + 1
		});

		await expect(
			owner.as.mutation(api.owner.boxes.createSnapshot, { slug: "mine" })
		).rejects.toThrow("moments ago");
	});
});

// Finishing a capture whose box or row moved under it. The operation is closed
// first and unconditionally, because a capture that succeeded must never leave
// the box's lock held - everything after that is best-effort record keeping.
describe("finishing a capture against a box that changed", () => {
	test("records the size Hetzner reported", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId, {
			status: "creating"
		});

		await t.mutation(internal.boxes.snapshots.completeSnapshot, {
			snapshotRowId,
			sizeBytes: 2_500_000_000
		});

		expect(
			await t.run(async (ctx) => await ctx.db.get(snapshotRowId))
		).toMatchObject({ status: "complete", size_bytes: 2_500_000_000 });
	});

	// A capture Hetzner gave no size for is still a capture. Recording it is what
	// matters; the size is a column the list prints when it has one.
	test("completes a capture Hetzner reported no size for", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId, {
			status: "creating"
		});

		await t.mutation(internal.boxes.snapshots.completeSnapshot, {
			snapshotRowId
		});

		const [event] = (
			await t.run((ctx) => ctx.db.query("box_events").collect())
		).filter((row) => row.type === "box.snapshot_succeeded");
		expect(event?.metadata).toMatchObject({ sizeBytes: null });
	});

	// The box was deleted while its own snapshot was being captured. The row is
	// still completed - the image exists and reconciliation needs the row to find
	// it - but there is no box left to write an event against.
	test("completes the row even when the box is gone", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId, {
			status: "creating"
		});
		await t.run(async (ctx) => await ctx.db.delete(boxId));

		await t.mutation(internal.boxes.snapshots.completeSnapshot, {
			snapshotRowId
		});

		expect(
			await t.run(async (ctx) => await ctx.db.get(snapshotRowId))
		).toMatchObject({ status: "complete" });
		expect(await t.run((ctx) => ctx.db.query("box_events").collect())).toEqual(
			[]
		);
	});
});

// The nightly capture's own preconditions, which are two separate facts.
describe("what the nightly capture refuses", () => {
	test("skips a box that no longer exists", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		await t.run(async (ctx) => await ctx.db.delete(boxId));

		await t.mutation(internal.boxes.snapshots.startAutomaticSnapshot, {
			boxId
		});

		expect(
			await t.run((ctx) => ctx.db.query("box_operations").collect())
		).toEqual([]);
	});

	test.each(["stopped", "suspended", "repairing"] as const)(
		"skips a box that is %s rather than running",
		async (status) => {
			const t = testConvex();
			const { boxId } = await ownedRunningBox(t);
			await t.run(async (ctx) => await ctx.db.patch(boxId, { status }));

			await t.mutation(internal.boxes.snapshots.startAutomaticSnapshot, {
				boxId
			});

			expect(await boxOperations(t, boxId)).toEqual([]);
		}
	);
});

// The rest of the snapshot lifecycle: the steps between "Hetzner started making
// an image" and "the row and the image are both gone". Each is small and none of
// them had been called, which is how a step that quietly did nothing would look
// exactly like one that worked.
describe("carrying a capture through to its image", () => {
	async function pendingRow(t: Harness) {
		const { boxId, owner } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId, {
			status: "pending"
		});
		return { boxId, owner, snapshotRowId };
	}

	const row = (t: Harness, id: Id<"box_snapshots">) =>
		t.run(async (ctx) => await ctx.db.get(id));

	test("records the provider ids the capture was given", async () => {
		const t = testConvex();
		const { snapshotRowId } = await pendingRow(t);

		await t.mutation(internal.boxes.snapshots.markCreating, {
			snapshotRowId,
			imageId: 22,
			actionId: 11
		});

		expect(await row(t, snapshotRowId)).toMatchObject({
			status: "creating",
			hetzner_image_id: 22,
			hetzner_action_id: 11
		});
	});

	// A row claimed for deletion while its capture was still running must not be
	// dragged back to `creating`: the delete is already in flight behind it.
	test("leaves a row already claimed for deletion alone", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId, {
			status: "deleting"
		});

		await t.mutation(internal.boxes.snapshots.markCreating, {
			snapshotRowId,
			imageId: 22,
			actionId: 11
		});

		expect(await row(t, snapshotRowId)).toMatchObject({ status: "deleting" });
	});

	test("does nothing for a row that is already gone", async () => {
		const t = testConvex();
		const { snapshotRowId } = await pendingRow(t);
		await t.run(async (ctx) => await ctx.db.delete(snapshotRowId));

		await expect(
			t.mutation(internal.boxes.snapshots.markCreating, {
				snapshotRowId,
				imageId: 22,
				actionId: 11
			})
		).resolves.not.toThrow();
	});
});

// What a restore may be made from, and what it must refuse. Restoring rebuilds
// the box's disk, so pointing it at an image that is not there destroys the box
// and gives nothing back.
describe("choosing an image to restore from", () => {
	async function snapshotIn(t: Harness, seed: SnapshotSeed) {
		const { boxId } = await ownedRunningBox(t);
		return await seedSnapshot(t, boxId, seed);
	}

	const target = (t: Harness, snapshotRowId: Id<"box_snapshots">) =>
		t.query(internal.boxes.snapshots.snapshotRestoreTarget, { snapshotRowId });

	test("offers a finished snapshot that has an image", async () => {
		const t = testConvex();
		const snapshotRowId = await snapshotIn(t, {
			status: "complete",
			imageId: 4242
		});

		expect(await target(t, snapshotRowId)).toMatchObject({ imageId: 4242 });
	});

	test.each([
		["still being captured", { status: "creating" as const, imageId: 4242 }],
		["already failed", { status: "failed" as const, imageId: 4242 }],
		["being deleted", { status: "deleting" as const, imageId: 4242 }],
		["finished but holding no image", { status: "complete" as const }]
	])("refuses a snapshot that is %s", async (_name, seed) => {
		const t = testConvex();
		const snapshotRowId = await snapshotIn(t, seed);

		expect(await target(t, snapshotRowId)).toBeNull();
	});
});

// Removing a snapshot: claim the row, delete the provider image, drop the row.
// The order matters - dropping the row first loses the only pointer to an image
// that then bills for ever.
describe("removing a snapshot and its image", () => {
	const imageDeletes = (t: Harness) =>
		scheduledArgs<{ imageId: number }>(t, "boxes/infra/hetznerVps:deleteImage");

	test("drops the row once its image is gone", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId, {
			status: "complete"
		});

		await t.mutation(internal.boxes.snapshots.removeSnapshotRow, {
			snapshotRowId
		});

		expect(await t.run((ctx) => ctx.db.get(snapshotRowId))).toBeNull();
	});

	test("does nothing for a row that is already gone", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId);
		await t.run(async (ctx) => await ctx.db.delete(snapshotRowId));

		await expect(
			t.mutation(internal.boxes.snapshots.removeSnapshotRow, { snapshotRowId })
		).resolves.not.toThrow();
	});

	// A row that never reached Hetzner has no image to delete, and asking to
	// delete image `undefined` is a request that fails for the wrong reason.
	test("drops a row that never got an image without asking Hetzner", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId, {
			status: "failed"
		});

		await t.action(internal.boxes.snapshots.runDelete, { snapshotRowId });

		expect(await t.run((ctx) => ctx.db.get(snapshotRowId))).toBeNull();
		expect(await imageDeletes(t)).toEqual([]);
	});

	test("does nothing at all for a row that has already gone", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId);
		await t.run(async (ctx) => await ctx.db.delete(snapshotRowId));

		await expect(
			t.action(internal.boxes.snapshots.runDelete, { snapshotRowId })
		).resolves.not.toThrow();
	});
});

// The two sweeps that drive all of the above.
describe("the sweeps that drive snapshots", () => {
	test("queues a delete for every snapshot it claimed", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		for (let index = 0; index < 3; index += 1) {
			await seedSnapshot(t, boxId, {
				class: "scheduled",
				expiresAt: NOW - 1
			});
		}

		await t.action(internal.boxes.snapshots.deleteExpiredSnapshots, {});

		expect(
			await scheduledArgs<{ snapshotRowId: Id<"box_snapshots"> }>(
				t,
				"boxes/snapshots:runDelete"
			)
		).toHaveLength(3);
	});

	test("schedules a capture for every running box and no others", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const other = await seedBox(t, {
			user_id: "owner",
			plan: "pro",
			manual_snapshot_cap: 0,
			slug: "second",
			status: "running"
		});
		await seedBox(t, {
			user_id: "owner",
			plan: "pro",
			manual_snapshot_cap: 0,
			slug: "asleep",
			status: "stopped"
		});

		await t.action(internal.boxes.snapshots.scheduleAutomaticSnapshots, {});

		const scheduled = await scheduledArgs<{ boxId: Id<"boxes"> }>(
			t,
			"boxes/snapshots:startAutomaticSnapshot"
		);
		expect([...scheduled.map((job) => job.boxId)].sort()).toEqual(
			[boxId, other].sort()
		);
	});

	// Staggered rather than fired at once: every one of these becomes a Hetzner
	// server action, and the whole fleet asking simultaneously is a rate limit.
	test("staggers the captures it schedules", async () => {
		const t = testConvex();
		await ownedRunningBox(t);
		await seedBox(t, {
			user_id: "owner",
			plan: "pro",
			manual_snapshot_cap: 0,
			slug: "second",
			status: "running"
		});

		await t.action(internal.boxes.snapshots.scheduleAutomaticSnapshots, {});

		const times = (
			await t.run((ctx) =>
				ctx.db.system.query("_scheduled_functions").collect()
			)
		)
			.filter((job) => job.name.includes("startAutomaticSnapshot"))
			.map((job) => job.scheduledTime);
		expect(new Set(times).size).toBe(2);
	});

	test("reports an empty fleet as one finished page", async () => {
		const t = testConvex();

		expect(
			await t.query(internal.boxes.snapshots.runningBoxIdsPage, {
				cursor: null
			})
		).toMatchObject({ isDone: true, page: [] });
	});
});

// The counting behind every capacity decision, at the limits that make it
// approximate.
//
// A box's active snapshots are counted across three statuses against one budget,
// and the count is deliberately allowed to stop early - `exact: false` means
// "at least this many". Admission refuses on an inexact count rather than
// guessing, because guessing high refuses a capture that was allowed and
// guessing low evicts somebody's files.
describe("counting a box's active snapshots against a budget", () => {
	async function seedAcrossStatuses(
		t: Harness,
		boxId: Id<"boxes">,
		userId: string,
		counts: { complete?: number; creating?: number; pending?: number }
	) {
		for (const [status, count] of Object.entries(counts)) {
			for (let index = 0; index < (count ?? 0); index += 1) {
				await seedSnapshot(t, boxId, {
					class: "scheduled",
					status: status as Doc<"box_snapshots">["status"],
					createdAt: NOW - DAY_MS * (100 - index)
				});
			}
		}
	}

	// The budget is spent in status order, so a box whose first status alone
	// exceeds it never reads the others - and the count it returns is a floor,
	// not a total. Admission has to refuse on that rather than treat it as exact.
	test("refuses a capture when the count stopped short of the truth", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		await seedAcrossStatuses(t, boxId, owner.clerkUserId, {
			pending: PRO_AUTOMATIC_CAP * 2 + 1,
			complete: 2
		});

		await expect(
			t.mutation(internal.boxes.snapshots.beginSnapshot, {
				boxId,
				class: "scheduled"
			})
		).rejects.toThrow("snapshot limit");
	});

	// Exactly one repair batch is the most that may be evicted in one admission.
	// The boundary is the whole rule: one more and the capture is refused.
	test("admits the capture that needs exactly one repair batch", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		// requiredEvictions = count - cap + 1, so count = cap + capRepairBatch - 1
		// = 2 * cap makes it exactly capRepairBatch.
		await seedAcrossStatuses(t, boxId, owner.clerkUserId, {
			complete: PRO_AUTOMATIC_CAP * 2
		});

		await t.mutation(internal.boxes.snapshots.beginSnapshot, {
			boxId,
			class: "scheduled"
		});

		expect(
			await scheduledArgs<{ snapshotRowId: Id<"box_snapshots"> }>(
				t,
				"boxes/snapshots:runDelete"
			)
		).toHaveLength(PRO_AUTOMATIC_CAP + 1);
	});

	test("refuses the one that would need a batch and a row more", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		await seedAcrossStatuses(t, boxId, owner.clerkUserId, {
			complete: PRO_AUTOMATIC_CAP * 2 + 1
		});

		await expect(
			t.mutation(internal.boxes.snapshots.beginSnapshot, {
				boxId,
				class: "scheduled"
			})
		).rejects.toThrow("snapshot limit");
	});
});

// Deleting the provider image, and the guard that decides whether there is one.
describe("deleting the image behind a snapshot row", () => {
	function stubHetzner() {
		const deletes: string[] = [];
		vi.stubEnv("HETZNER_CLOUD_TOKEN", "token");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: URL | string, init?: RequestInit) => {
				if (init?.method === "DELETE") deletes.push(String(input));
				return {
					ok: true,
					status: 200,
					headers: new Headers(),
					text: async () => "{}"
				} as unknown as Response;
			})
		);
		return deletes;
	}

	test("asks Hetzner to delete the image a row holds", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId, {
			status: "complete",
			imageId: 4242
		});
		const deletes = stubHetzner();

		await t.action(internal.boxes.snapshots.runDelete, { snapshotRowId });

		expect(deletes.filter((url) => url.includes("/images/4242"))).toHaveLength(
			1
		);
	});

	// A row with no image has nothing at Hetzner. Asking anyway is a request for
	// image `undefined`, which fails and leaves the row behind for ever.
	test("asks Hetzner nothing for a row that never got an image", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId, {
			status: "failed"
		});
		const deletes = stubHetzner();

		await t.action(internal.boxes.snapshots.runDelete, { snapshotRowId });

		expect(deletes).toEqual([]);
		expect(await t.run((ctx) => ctx.db.get(snapshotRowId))).toBeNull();
	});
});

// Claiming a row for deletion is the lock that stops two sweeps deleting the
// same image twice, and it has to be idempotent for the one that already holds
// it.
describe("claiming a row for deletion", () => {
	test("marks a live row as deleting and reports its image", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId, {
			status: "complete",
			imageId: 4242
		});

		expect(
			await t.mutation(internal.boxes.snapshots.claimSnapshotDelete, {
				snapshotRowId
			})
		).toEqual({ imageId: 4242 });
		expect(await t.run((ctx) => ctx.db.get(snapshotRowId))).toMatchObject({
			status: "deleting"
		});
	});

	// Already claimed: still answer with the image, because the caller that
	// re-drives has to finish the provider delete the first one may not have.
	test("still reports the image for a row already being deleted", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId, {
			status: "deleting",
			imageId: 4242
		});

		expect(
			await t.mutation(internal.boxes.snapshots.claimSnapshotDelete, {
				snapshotRowId
			})
		).toEqual({ imageId: 4242 });
	});
});

// The re-drives. Each of these sweeps bounds one transaction and comes back for
// the rest; without the re-drive the fleet's work simply stops at one batch and
// nothing anywhere says so.
describe("finishing work that does not fit in one pass", () => {
	test("comes back for the snapshots a full expiry batch left behind", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		for (let index = 0; index < 3; index += 1) {
			await seedSnapshot(t, boxId, {
				class: "scheduled",
				expiresAt: NOW - 1
			});
		}

		const claim = await t.mutation(
			internal.boxes.snapshots.claimExpiredSnapshots,
			{ limit: 3 }
		);

		expect(claim.hasMore).toBe(true);
	});

	test("walks past the first page of a box's snapshot history", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		await t.run(async (ctx) => {
			for (let index = 0; index < 101; index += 1) {
				await ctx.db.insert("box_snapshots", {
					box_id: boxId,
					class: "scheduled",
					status: "complete",
					created_at: NOW - index
				});
			}
		});

		await t.mutation(internal.boxes.snapshots.cascadeDeleteBoxSnapshots, {
			boxId
		});

		// The hundred that fit in the first page are queued, and the cascade
		// schedules itself with a cursor for the hundred-and-first. Without that
		// continuation the last row - and its provider image - is never removed.
		expect(await scheduledJobs(t, "boxes/snapshots:runDelete")).toHaveLength(
			100
		);
		const [continuation] = await scheduledArgs<{ cursor: string | null }>(
			t,
			"boxes/snapshots:cascadeDeleteBoxSnapshots"
		);
		expect(continuation?.cursor).toEqual(expect.any(String));
	});
});

// The shape a snapshot takes on its way to a page, and the one thing it has to
// get right: a field the row does not have yet is `null`, never `undefined`.
//
// Convex validators reject `undefined` in a returned object, so an unfinished
// snapshot would make the whole list query throw rather than render a row with a
// blank column - and the list is what an owner opens to find the snapshot they
// want to restore from.
describe("what a snapshot looks like to a page", () => {
	test("reports every field a finished snapshot has", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId, {
			class: "manual",
			status: "complete",
			expiresAt: NOW + DAY_MS
		});
		await t.run(async (ctx) => {
			await ctx.db.patch(snapshotRowId, {
				size_bytes: 2_500_000_000,
				completed_at: NOW
			});
		});

		const [view] = await owner.as.query(api.owner.boxes.snapshots, {
			slug: "mine"
		});

		expect(view).toEqual({
			id: snapshotRowId,
			beforeOperation: null,
			class: "manual",
			status: "complete",
			sizeBytes: 2_500_000_000,
			createdAt: NOW - DAY_MS,
			completedAt: NOW,
			expiresAt: NOW + DAY_MS
		});
	});

	// A capture still running has none of the three. Each has to come back as
	// null, and the query has to survive returning it.
	test("reports an unfinished snapshot's missing fields as null", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("box_snapshots", {
				box_id: boxId,
				class: "manual",
				status: "creating",
				created_at: NOW
			});
		});

		const [view] = await owner.as.query(api.owner.boxes.snapshots, {
			slug: "mine"
		});

		expect(view).toMatchObject({
			sizeBytes: null,
			completedAt: null,
			expiresAt: null
		});
	});
});

// The end of a restore: the box comes back to `running`, the operation closes,
// and the event names which snapshot it was restored from. Everything before
// this point is destructive - the disk has already been rebuilt from the image -
// so an operation left open here is a box that survived the rebuild and is then
// blocked from every later action.
describe("finishing a restore", () => {
	async function restoringBox(t: Harness) {
		const { boxId } = await ownedRunningBox(t);
		await t.run(
			async (ctx) => await ctx.db.patch(boxId, { status: "restoring" })
		);
		const snapshotRowId = await seedSnapshot(t, boxId, {
			status: "complete",
			imageId: 4242
		});
		const operationId = await t.run(
			async (ctx) =>
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: "restore",
					status: "running",
					idempotency_key: `restore:${boxId}`,
					trigger: "owner",
					created_at: NOW,
					updated_at: NOW
				})
		);
		return { boxId, operationId, snapshotRowId };
	}

	test("brings the box back and closes the operation", async () => {
		const t = testConvex();
		const { boxId, operationId, snapshotRowId } = await restoringBox(t);

		await t.mutation(internal.boxes.snapshots.markRestoreSucceeded, {
			boxId,
			floorClamped: false,
			operationId,
			snapshotRowId,
			runtimeImage: null
		});

		expect(await readBox(t, boxId)).toMatchObject({ status: "running" });
		expect(await readOperation(t, operationId)).toMatchObject({
			status: "succeeded",
			finished_at: NOW
		});
	});

	// Which snapshot the box was rewound to is the one fact support cannot
	// reconstruct afterwards - the row may be expired and deleted by then.
	test("records which snapshot the box was restored from", async () => {
		const t = testConvex();
		const { boxId, operationId, snapshotRowId } = await restoringBox(t);

		await t.mutation(internal.boxes.snapshots.markRestoreSucceeded, {
			boxId,
			floorClamped: false,
			operationId,
			snapshotRowId,
			runtimeImage: null
		});

		expect(await boxEvents(t, boxId)).toMatchObject([
			{ type: "box.restore_succeeded", metadata: { snapshotRowId } }
		]);
	});

	// A box deleted while its own restore was in flight. Closing the operation is
	// still the part that must happen - it is what stops the teardown that
	// follows from being refused as "busy" - and there is no box left to log
	// against.
	test("still closes the operation when the box is gone", async () => {
		const t = testConvex();
		const { boxId, operationId, snapshotRowId } = await restoringBox(t);
		await t.run(async (ctx) => await ctx.db.delete(boxId));

		await t.mutation(internal.boxes.snapshots.markRestoreSucceeded, {
			boxId,
			floorClamped: false,
			operationId,
			snapshotRowId,
			runtimeImage: null
		});

		expect(await readOperation(t, operationId)).toMatchObject({
			status: "succeeded"
		});
		expect(await t.run((ctx) => ctx.db.query("box_events").collect())).toEqual(
			[]
		);
	});
});

// The nightly capture gives way to whatever the box is already doing. A refusal
// from the operation lock is expected and silent; anything else is not, because
// a sweep that swallowed a real error would look healthy while capturing nothing.
describe("the nightly capture meeting a busy box", () => {
	test("gives way without recording a failure", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		await t.run(
			async (ctx) =>
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: "repair",
					status: "running",
					idempotency_key: "busy",
					trigger: "owner",
					created_at: NOW,
					updated_at: NOW
				})
		);

		await expect(
			t.mutation(internal.boxes.snapshots.startAutomaticSnapshot, { boxId })
		).resolves.not.toThrow();

		expect(
			(await boxOperations(t, boxId)).filter((row) => row.type === "snapshot")
		).toEqual([]);
	});
});

// The edges of a snapshot's life that only show up when two things happen at
// once: a row deleted while its capture was still running, a box removed under
// an operation, a sweep asked for more than it can do in one pass.
describe("a capture whose row went away underneath it", () => {
	// A snapshot the owner deleted mid-capture is already being torn down. Writing
	// "complete" over that would resurrect a row nothing will ever delete again -
	// its delete pass has already been and gone - and bill for the image forever.
	test("does not complete a snapshot that is already being deleted", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId, {
			status: "deleting"
		});

		await t.mutation(internal.boxes.snapshots.completeSnapshot, {
			snapshotRowId,
			sizeBytes: 100
		});

		expect(await snapshotsOf(t, boxId)).toMatchObject([{ status: "deleting" }]);
	});

	test("does not fail a snapshot that is already being deleted", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId, {
			status: "deleting"
		});

		await t.mutation(internal.boxes.snapshots.failSnapshot, {
			snapshotRowId,
			error: "hetzner refused"
		});

		expect(await snapshotsOf(t, boxId)).toMatchObject([{ status: "deleting" }]);
	});

	// Both are reached by a workflow holding a row id across steps, so the row
	// really can be gone by the time the step comes back.
	test("says nothing when the row it was completing is gone", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId);
		await t.run(async (ctx) => await ctx.db.delete(snapshotRowId));

		await expect(
			t.mutation(internal.boxes.snapshots.completeSnapshot, {
				snapshotRowId,
				sizeBytes: 100
			})
		).resolves.not.toThrow();
	});

	test("says nothing when the row it was failing is gone", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId);
		await t.run(async (ctx) => await ctx.db.delete(snapshotRowId));

		await expect(
			t.mutation(internal.boxes.snapshots.failSnapshot, {
				snapshotRowId,
				error: "hetzner refused"
			})
		).resolves.not.toThrow();
	});

	test("refuses to open a snapshot on a box that is gone", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		await t.run(async (ctx) => await ctx.db.delete(boxId));

		await expect(
			t.mutation(internal.boxes.snapshots.beginSnapshot, {
				boxId,
				class: "manual"
			})
		).rejects.toThrow("Box not found.");
	});
});

// Claiming a row for deletion is what makes the delete idempotent: the status
// moves once, and a second pass finds it already moved.
describe("claiming a row that is already being deleted", () => {
	test("leaves a row that is already deleting exactly as it is", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId, {
			status: "deleting",
			imageId: 7
		});

		expect(
			await t.mutation(internal.boxes.snapshots.claimSnapshotDelete, {
				snapshotRowId
			})
		).toEqual({ imageId: 7 });
		expect(await snapshotsOf(t, boxId)).toMatchObject([
			{ status: "deleting", hetzner_image_id: 7 }
		]);
	});

	test("hands back nothing for a row that is already gone", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId);
		await t.run(async (ctx) => await ctx.db.delete(snapshotRowId));

		expect(
			await t.mutation(internal.boxes.snapshots.claimSnapshotDelete, {
				snapshotRowId
			})
		).toBeNull();
	});
});

// The nightly sweep that hands every running box its automatic capture. It is
// paged, and the delay each box is given is spread across the whole fleet - so
// the count has to carry across pages or every page would start its spread again
// from zero and land the whole fleet in the first few minutes.
describe("spreading the nightly capture across the fleet", () => {
	async function runningBoxes(t: Harness, count: number) {
		const owner = await seedUser(t, { clerkUserId: "owner" });
		await t.run(async (ctx) => {
			for (let index = 0; index < count; index += 1) {
				await ctx.db.insert("boxes", {
					user_id: owner.clerkUserId,
					slug: `fleet-${index}`,
					plan: "pro",
					manual_snapshot_cap: BOX_PLANS.pro.snapshotManualDefault,
					status: "running",
					created_at: 1,
					updated_at: 1
				});
			}
		});
	}

	const schedule = (t: Harness, args: object = {}) =>
		t.action(internal.boxes.snapshots.scheduleAutomaticSnapshots, args);

	test("gives each box on the first page a later slot than the last", async () => {
		const t = testConvex();
		await runningBoxes(t, 3);

		await schedule(t);

		const jobs = await scheduledJobs(
			t,
			"boxes/snapshots:startAutomaticSnapshot"
		);
		const times = jobs.map((job) => job.scheduledTime).sort((a, b) => a - b);
		expect(times).toHaveLength(3);
		expect(new Set(times).size).toBe(3);
	});

	// The offset is what a second page continues from. Starting it at zero again
	// would give the second page the same slots as the first.
	test("continues the spread from where the previous page stopped", async () => {
		const t = testConvex();
		await runningBoxes(t, 2);

		await schedule(t, { scheduledCount: 10 });

		const [first] = await scheduledJobs(
			t,
			"boxes/snapshots:startAutomaticSnapshot"
		);
		await t.run(async (ctx) => {
			for (const job of await ctx.db.system
				.query("_scheduled_functions")
				.collect()) {
				void job;
			}
		});
		const t2 = testConvex();
		await runningBoxes(t2, 2);
		await schedule(t2, { scheduledCount: 0 });
		const [zero] = await scheduledJobs(
			t2,
			"boxes/snapshots:startAutomaticSnapshot"
		);

		expect(first?.scheduledTime).toBeGreaterThan(zero?.scheduledTime ?? 0);
	});

	// A negative or fractional count is not a slot number. Clamping keeps the
	// spread starting from a whole, non-negative offset.
	test("treats a nonsense offset as no offset", async () => {
		const t = testConvex();
		await runningBoxes(t, 1);

		await schedule(t, { scheduledCount: -50 });

		const [job] = await scheduledJobs(
			t,
			"boxes/snapshots:startAutomaticSnapshot"
		);
		const t2 = testConvex();
		await runningBoxes(t2, 1);
		await schedule(t2, {});
		const [baseline] = await scheduledJobs(
			t2,
			"boxes/snapshots:startAutomaticSnapshot"
		);

		expect(job?.scheduledTime).toBe(baseline?.scheduledTime);
	});
});

// The nightly capture skips boxes it would only fail on.
describe("which boxes the nightly capture skips", () => {
	test.each(["stopped", "suspended", "deleted", "creating"] as const)(
		"skips a box that is %s",
		async (status) => {
			const t = testConvex();
			const owner = await seedUser(t, { clerkUserId: "owner" });
			const boxId = await seedBox(t, {
				user_id: owner.clerkUserId,
				plan: "pro",
				manual_snapshot_cap: BOX_PLANS.pro.snapshotManualDefault,
				slug: "mine",
				status
			});

			await t.mutation(internal.boxes.snapshots.startAutomaticSnapshot, {
				boxId
			});

			expect(await boxOperations(t, boxId)).toEqual([]);
		}
	);

	test("skips a box that is gone", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		await t.run(async (ctx) => await ctx.db.delete(boxId));

		await expect(
			t.mutation(internal.boxes.snapshots.startAutomaticSnapshot, { boxId })
		).resolves.not.toThrow();
	});

	// One night is one capture. The key is bucketed by the automatic cadence, so
	// a sweep that runs twice in a night does not take two.
	test("takes one capture however often the sweep runs that night", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);

		await t.mutation(internal.boxes.snapshots.startAutomaticSnapshot, {
			boxId
		});
		vi.setSystemTime(NOW + 60 * MINUTE_MS);
		await t.mutation(internal.boxes.snapshots.startAutomaticSnapshot, {
			boxId
		});

		expect(await boxOperations(t, boxId)).toHaveLength(1);
	});
});

// Every sweep over snapshots is bounded per transaction and re-drives itself.
// These are the boxes and fleets big enough to need a second pass - the case a
// missing re-drive turns into "the first hundred were deleted and the rest bill
// for ever", which nothing else would ever report.
describe("sweeps that need more than one pass", () => {
	async function snapshots(
		t: Harness,
		boxId: Id<"boxes">,
		userId: string,
		count: number,
		seed: SnapshotSeed = {}
	) {
		await t.run(async (ctx) => {
			for (let index = 0; index < count; index += 1) {
				await ctx.db.insert("box_snapshots", {
					box_id: boxId,
					class: seed.class ?? "manual",
					status: seed.status ?? "complete",
					hetzner_image_id: seed.imageId,
					created_at: (seed.createdAt ?? NOW - DAY_MS) + index,
					expires_at: seed.expiresAt
				});
			}
		});
	}

	test("cascading a delete comes back for the rows past the first page", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		await snapshots(t, boxId, owner.clerkUserId, 101);

		await t.mutation(internal.boxes.snapshots.cascadeDeleteBoxSnapshots, {
			boxId
		});

		const [next] = await scheduledArgs<{ boxId: Id<"boxes">; cursor: string }>(
			t,
			"boxes/snapshots:cascadeDeleteBoxSnapshots"
		);
		expect(next).toMatchObject({ boxId });
		expect(next?.cursor).toEqual(expect.any(String));
	});

	test("cascading stops when one page was the whole history", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		await snapshots(t, boxId, owner.clerkUserId, 2);

		await t.mutation(internal.boxes.snapshots.cascadeDeleteBoxSnapshots, {
			boxId
		});

		expect(
			await scheduledJobs(t, "boxes/snapshots:cascadeDeleteBoxSnapshots")
		).toEqual([]);
	});

	// The expiry sweep claims a bounded batch and says whether more are waiting.
	// Without the re-drive a fleet with more expired snapshots than one batch
	// would shed exactly one batch a night, for ever.
	test("the expiry sweep comes back while more are waiting", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		await snapshots(t, boxId, owner.clerkUserId, 201, {
			expiresAt: NOW - 1
		});

		await t.action(internal.boxes.snapshots.deleteExpiredSnapshots, {});

		expect(
			await scheduledJobs(t, "boxes/snapshots:deleteExpiredSnapshots")
		).toHaveLength(1);
	});

	test("the expiry sweep stops when it drained everything due", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		await snapshots(t, boxId, owner.clerkUserId, 2, { expiresAt: NOW - 1 });

		await t.action(internal.boxes.snapshots.deleteExpiredSnapshots, {});

		expect(
			await scheduledJobs(t, "boxes/snapshots:deleteExpiredSnapshots")
		).toEqual([]);
		expect(await scheduledJobs(t, "boxes/snapshots:runDelete")).toHaveLength(2);
	});

	// The claim is bounded across every deletable status, not per status: two
	// statuses each holding rows must still yield exactly the batch asked for.
	test("claims no more than it was asked for across statuses", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		await snapshots(t, boxId, owner.clerkUserId, 3, {
			status: "failed",
			expiresAt: NOW - 1
		});
		await snapshots(t, boxId, owner.clerkUserId, 3, {
			status: "complete",
			expiresAt: NOW - 1
		});

		const claim = await t.mutation(
			internal.boxes.snapshots.claimExpiredSnapshots,
			{ limit: 4 }
		);

		expect(claim.snapshotRowIds).toHaveLength(4);
		expect(claim.hasMore).toBe(true);
	});

	test("claims nothing when asked for nothing", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		await snapshots(t, boxId, owner.clerkUserId, 3, { expiresAt: NOW - 1 });

		const claim = await t.mutation(
			internal.boxes.snapshots.claimExpiredSnapshots,
			{ limit: 0 }
		);

		expect(claim.snapshotRowIds).toEqual([]);
	});

	// The nightly spread pages the fleet, and the page after the first has to be
	// asked for or only the first two hundred boxes are ever captured.
	test("the nightly spread comes back for the boxes past the first page", async () => {
		const t = testConvex();
		const owner = await seedUser(t, { clerkUserId: "owner" });
		await t.run(async (ctx) => {
			for (let index = 0; index < 201; index += 1) {
				await ctx.db.insert("boxes", {
					user_id: owner.clerkUserId,
					slug: `fleet-${index}`,
					plan: "pro",
					manual_snapshot_cap: BOX_PLANS.pro.snapshotManualDefault,
					status: "running",
					created_at: 1,
					updated_at: 1
				});
			}
		});

		await t.action(internal.boxes.snapshots.scheduleAutomaticSnapshots, {});

		const [next] = await scheduledArgs<{
			cursor: string;
			scheduledCount: number;
		}>(t, "boxes/snapshots:scheduleAutomaticSnapshots");
		expect(next?.cursor).toEqual(expect.any(String));
		// The count carries the boxes already scheduled, so the next page keeps
		// spreading rather than restarting at the front of the night.
		expect(next?.scheduledCount).toBe(200);
	});
});

// The two idempotency keys, checked across boxes rather than across time. A key
// that lost the box it names would let one box's capture suppress another's.
describe("keeping two boxes' captures apart", () => {
	async function secondBox(t: Harness) {
		return await seedBox(t, {
			user_id: "owner",
			plan: "pro",
			manual_snapshot_cap: BOX_PLANS.pro.snapshotManualDefault,
			slug: "other",
			status: "running"
		});
	}

	test("a nightly capture on one box does not suppress another's", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const other = await secondBox(t);

		await t.mutation(internal.boxes.snapshots.startAutomaticSnapshot, {
			boxId
		});
		await t.mutation(internal.boxes.snapshots.startAutomaticSnapshot, {
			boxId: other
		});

		expect(await boxOperations(t, boxId)).toHaveLength(1);
		expect(await boxOperations(t, other)).toHaveLength(1);
	});
});

// A snapshot row that never reached Hetzner has no image to delete, and asking
// Hetzner to delete `undefined` is a request that can only fail - which would
// leave the row behind for ever because the delete never gets to remove it.
describe("deleting a snapshot that never became an image", () => {
	test("removes the row without calling the provider", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId, {
			status: "failed"
		});
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: URL | string) => {
				calls.push(String(input));
				return {
					ok: true,
					status: 200,
					headers: new Headers(),
					text: async () => JSON.stringify({})
				} as unknown as Response;
			})
		);

		await t.action(internal.boxes.snapshots.runDelete, { snapshotRowId });

		expect(calls).toEqual([]);
		expect(await snapshotsOf(t, boxId)).toEqual([]);
		vi.unstubAllGlobals();
	});
});

// The last few edges: what the provider is asked to do, what the scheduler is
// handed, and the guard that keeps two captures of one box from overlapping.
describe("the edges of deleting and scheduling", () => {
	test("deletes the image behind a snapshot that reached Hetzner", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId, {
			imageId: 4242
		});
		vi.stubEnv("HETZNER_CLOUD_TOKEN", "hz-token");
		const calls: { method: string; url: string }[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: URL | string, init?: RequestInit) => {
				calls.push({ method: init?.method ?? "GET", url: String(input) });
				return {
					ok: true,
					status: 200,
					headers: new Headers(),
					text: async () => JSON.stringify({})
				} as unknown as Response;
			})
		);

		await t.action(internal.boxes.snapshots.runDelete, { snapshotRowId });

		expect(
			calls.filter(
				(call) => call.method === "DELETE" && call.url.includes("/images/4242")
			)
		).toHaveLength(1);
		expect(await snapshotsOf(t, boxId)).toEqual([]);
		vi.unstubAllGlobals();
	});

	// Each expired row is handed to its own delete, named. A job queued without
	// the row it is for would delete nothing and report success.
	test("hands each expired row to its own delete", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId, {
			expiresAt: NOW - 1
		});

		await t.action(internal.boxes.snapshots.deleteExpiredSnapshots, {});

		expect(await scheduledArgs(t, "boxes/snapshots:runDelete")).toEqual([
			{ snapshotRowId }
		]);
	});

	test("the nightly spread stops once it has walked the fleet", async () => {
		const t = testConvex();
		await ownedRunningBox(t);

		await t.action(internal.boxes.snapshots.scheduleAutomaticSnapshots, {});

		expect(
			await scheduledJobs(t, "boxes/snapshots:scheduleAutomaticSnapshots")
		).toEqual([]);
	});
});

// Counting a box's snapshots against its cap, at the edges that decide whether
// somebody gets what they paid for or more than it.
//
// The count is deliberately bounded - it asks for one past the cap and stops -
// so it reports a floor rather than a total, and says which. Admission refuses
// on an inexact count rather than guessing, because guessing low over-subscribes
// the fleet's snapshot quota and guessing high refuses a paying customer.
describe("counting against the cap it stops at", () => {
	async function withSnapshots(
		t: Harness,
		count: number,
		seed: SnapshotSeed = {}
	) {
		const { boxId, owner } = await ownedRunningBox(t);
		await t.run(async (ctx) => {
			for (let index = 0; index < count; index += 1) {
				await ctx.db.insert("box_snapshots", {
					box_id: boxId,
					class: seed.class ?? "manual",
					status: seed.status ?? "complete",
					created_at: NOW - DAY_MS + index,
					expires_at: seed.expiresAt
				});
			}
		});
		return { boxId, owner };
	}

	const capture = (t: Harness, owner: { as: Caller }) =>
		owner.as.mutation(api.owner.boxes.createSnapshot, { slug: "mine" });

	// One below the cap is room for exactly one more.
	test("allows a capture with one slot left", async () => {
		const t = testConvex();
		const { owner } = await withSnapshots(t, PRO_MANUAL_CAP - 1);

		await expect(capture(t, owner)).resolves.not.toThrow();
	});

	// Exactly at the cap is not room for one more. Reading "at" as "under" is
	// how a box ends up with more snapshots than its plan sells.
	test("refuses a capture at the cap exactly", async () => {
		const t = testConvex();
		const { boxId, owner } = await withSnapshots(t, PRO_MANUAL_CAP);

		await expect(capture(t, owner)).rejects.toThrow();
		expect(await snapshotsOf(t, boxId)).toHaveLength(PRO_MANUAL_CAP);
	});

	// Past the cap - which a cap change can produce - stays refused rather than
	// wrapping around into "there is room".
	test("refuses a capture past the cap", async () => {
		const t = testConvex();
		const { owner } = await withSnapshots(t, PRO_MANUAL_CAP + 2);

		await expect(capture(t, owner)).rejects.toThrow();
	});

	// A snapshot still being taken counts against the cap: it is going to occupy
	// a slot, and not counting it is how two captures each believe they fit.
	test("counts a capture still in flight against the cap", async () => {
		const t = testConvex();
		const { owner } = await withSnapshots(t, PRO_MANUAL_CAP - 1, {
			status: "pending"
		});

		await expect(capture(t, owner)).rejects.toThrow();
	});

	// The automatic half is capped separately, so filling the manual half does
	// not stop the nightly capture - that separation is what the split sells.
	test("does not let manual snapshots block the nightly one", async () => {
		const t = testConvex();
		const { boxId } = await withSnapshots(t, PRO_MANUAL_CAP);

		await t.mutation(internal.boxes.snapshots.startAutomaticSnapshot, {
			boxId
		});

		expect(await boxOperations(t, boxId)).toMatchObject([
			{ type: "snapshot", trigger: "system:auto_snapshot" }
		]);
	});

	// A box whose owner gave every slot to manual captures has no automatic
	// allowance, and the nightly sweep skips it rather than failing every night.
	test("skips the nightly capture on a box with no automatic slots", async () => {
		const t = testConvex();
		const owner = await seedUser(t, { clerkUserId: "owner" });
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			plan: "pro",
			// Every slot given to manual leaves the automatic half at zero.
			manual_snapshot_cap: PRO_MANUAL_CAP + PRO_AUTOMATIC_CAP,
			slug: "mine",
			status: "running"
		});

		await t.mutation(internal.boxes.snapshots.startAutomaticSnapshot, {
			boxId
		});

		expect(await boxOperations(t, boxId)).toEqual([]);
	});
});

// The count stops early once it has seen enough, so past a point it reports a
// floor rather than a total and says so. Admission refuses on that rather than
// guessing: guessing low over-subscribes the fleet's snapshot quota at Hetzner,
// which is a limit shared by every customer.
describe("a box with more snapshots than the count will walk", () => {
	test("refuses the nightly capture rather than guessing at the total", async () => {
		const t = testConvex();
		const owner = await seedUser(t, { clerkUserId: "owner" });
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			plan: "pro",
			manual_snapshot_cap: BOX_PLANS.pro.snapshotManualDefault,
			slug: "mine",
			status: "running"
		});
		// Enough scheduled snapshots that the bounded count gives up before
		// reaching the end: the cap plus its repair batch.
		await t.run(async (ctx) => {
			for (let index = 0; index < PRO_AUTOMATIC_CAP * 2 + 2; index += 1) {
				await ctx.db.insert("box_snapshots", {
					box_id: boxId,
					class: "scheduled",
					status: "complete",
					created_at: NOW - DAY_MS + index
				});
			}
		});

		// The capacity check lives in the workflow's first step rather than in the
		// sweep that queues it, so this is where an inexact count is refused.
		await expect(
			t.mutation(internal.boxes.snapshots.beginSnapshot, {
				boxId,
				class: "scheduled"
			})
		).rejects.toThrow();

		// Nothing opened and nothing evicted - an inexact count is not a licence
		// to delete an owner's snapshots.
		expect(await snapshotsOf(t, boxId)).toHaveLength(PRO_AUTOMATIC_CAP * 2 + 2);
	});
});

// A manual capture's idempotency key names the box it is for. Without that, one
// owner pressing the button would silence another owner's capture for the whole
// cooldown bucket - the two requests would deduplicate against each other.
describe("keeping two owners' manual captures apart", () => {
	test("a capture on one box does not suppress another's", async () => {
		const t = testConvex();
		const first = await seedUser(t, { clerkUserId: "owner_one" });
		const second = await seedUser(t, {
			clerkUserId: "owner_two",
			email: "two@example.com"
		});
		const boxes = await Promise.all(
			[
				{ owner: first, slug: "one" },
				{ owner: second, slug: "two" }
			].map(({ owner, slug }) =>
				seedBox(t, {
					user_id: owner.clerkUserId,
					plan: "pro",
					manual_snapshot_cap: BOX_PLANS.pro.snapshotManualDefault,
					slug,
					status: "running"
				})
			)
		);

		await first.as.mutation(api.owner.boxes.createSnapshot, { slug: "one" });
		await second.as.mutation(api.owner.boxes.createSnapshot, { slug: "two" });

		for (const boxId of boxes) {
			expect(await boxOperations(t, boxId)).toHaveLength(1);
		}
	});
});

// The box's undo point. It is the deployment's snapshot rather than the
// owner's - taken before an operation they cannot otherwise come back from,
// held in a slot reserved outside what their plan sells, and replaced by the
// next one rather than removed by hand.
describe("the rollback snapshot taken before a destructive operation", () => {
	// The reserved slot, asked of the box that proves it is reserved: an owner who
	// gave every slot to snapshots they take themselves has an automatic
	// allowance of zero, and has filled the manual one. Neither cap has room, and
	// the undo point is admitted anyway - because it is not taken from either.
	//
	// This is also what stops the operation being refused: a capture the
	// destructive operations run first, refused for want of a slot, is an update
	// nobody can perform.
	test("is admitted on a box with no slot of its own allowance free", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		await t.run(
			async (ctx) =>
				await ctx.db.patch(boxId, {
					manual_snapshot_cap: BOX_PLANS.pro.snapshotCap
				})
		);
		for (let index = 0; index < BOX_PLANS.pro.snapshotCap; index += 1) {
			await seedSnapshot(t, boxId, { class: "manual" });
		}

		await t.mutation(internal.boxes.snapshots.beginSnapshot, {
			boxId,
			beforeOperation: "update",
			class: "rollback"
		});

		expect(
			(await snapshotsOf(t, boxId)).filter((row) => row.class === "rollback")
		).toHaveLength(1);
		// And nothing of the owner's was taken to fit it in.
		expect(
			await scheduledArgs<{ snapshotRowId: Id<"box_snapshots"> }>(
				t,
				"boxes/snapshots:runDelete"
			)
		).toEqual([]);
	});

	// Both facts are what make the row usable later: the operation names it in the
	// interface, and the image is what a restore puts the box back onto.
	test("records the operation it precedes and the version it captured", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		await t.run(
			async (ctx) =>
				await ctx.db.patch(boxId, {
					runtime_image: "ghcr.io/x@sha256:old",
					runtime_version: "0.1.0"
				})
		);

		await t.mutation(internal.boxes.snapshots.beginSnapshot, {
			boxId,
			beforeOperation: "update",
			class: "rollback"
		});

		expect(await snapshotsOf(t, boxId)).toMatchObject([
			{
				before_operation: "update",
				class: "rollback",
				runtime_image: "ghcr.io/x@sha256:old",
				runtime_version: "0.1.0"
			}
		]);
	});

	test("cannot be deleted by the owner whose box it protects", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		const snapshotId = await seedSnapshot(t, boxId, { class: "rollback" });

		await expect(
			owner.as.mutation(api.owner.boxes.deleteSnapshot, { snapshotId })
		).rejects.toThrow("taken automatically");
		expect(await snapshotsOf(t, boxId)).toMatchObject([{ status: "complete" }]);
	});
});

// One rollback snapshot per box, and the replacement is made before the old one
// goes. The sweep runs after the operation, so the row a restore was reading is
// still there while it needs it.
describe("what supersedes a box's rollback snapshot", () => {
	// The rows are seeded out of order on purpose. Which one is newest is a fact
	// about `created_at`, and the index is what makes the query answer by it - so
	// a test whose rows are written in date order would pass just as well if the
	// query answered by the order they were written, and could not tell the two
	// apart.
	test("keeps the newest complete one and queues every other for deletion", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const newest = await seedSnapshot(t, boxId, {
			class: "rollback",
			createdAt: NOW
		});
		const previous = await seedSnapshot(t, boxId, {
			class: "rollback",
			createdAt: NOW - DAY_MS
		});
		const abandoned = await seedSnapshot(t, boxId, {
			class: "rollback",
			createdAt: NOW - MINUTE_MS,
			status: "failed"
		});
		const manual = await seedSnapshot(t, boxId, { class: "manual" });

		await t.mutation(internal.boxes.snapshots.supersedeRollbackSnapshots, {
			boxId
		});

		const queued = (
			await scheduledArgs<{ snapshotRowId: Id<"box_snapshots"> }>(
				t,
				"boxes/snapshots:runDelete"
			)
		).map((job) => job.snapshotRowId);
		expect([...queued].sort()).toEqual([previous, abandoned].sort());
		expect(queued).not.toContain(newest);
		expect(queued).not.toContain(manual);
	});

	// A box whose only rollback rows never completed - the first capture of its
	// life failed, or the one complete row was claimed for deletion meanwhile. It
	// has nothing to keep, so it keeps nothing, and the pass has to survive
	// finding that rather than reading an id off the row it did not find.
	test("removes every rollback row when none of them completed", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const failed = await seedSnapshot(t, boxId, {
			class: "rollback",
			createdAt: NOW - DAY_MS,
			status: "failed"
		});
		const claimed = await seedSnapshot(t, boxId, {
			class: "rollback",
			createdAt: NOW,
			status: "deleting"
		});

		await t.mutation(internal.boxes.snapshots.supersedeRollbackSnapshots, {
			boxId
		});

		const queued = (
			await scheduledArgs<{ snapshotRowId: Id<"box_snapshots"> }>(
				t,
				"boxes/snapshots:runDelete"
			)
		).map((job) => job.snapshotRowId);
		expect([...queued].sort()).toEqual([failed, claimed].sort());
	});

	// An operation that failed before its capture completed leaves the box's
	// previous undo point in place: there is no newer one to replace it with, and
	// removing it would leave the box with none at all.
	test("keeps the last complete one when the newest capture failed", async () => {
		const t = testConvex();
		const { boxId } = await ownedRunningBox(t);
		const previous = await seedSnapshot(t, boxId, {
			class: "rollback",
			createdAt: NOW - DAY_MS
		});
		await seedSnapshot(t, boxId, {
			class: "rollback",
			createdAt: NOW,
			status: "failed"
		});

		await t.mutation(internal.boxes.snapshots.supersedeRollbackSnapshots, {
			boxId
		});

		const queued = (
			await scheduledArgs<{ snapshotRowId: Id<"box_snapshots"> }>(
				t,
				"boxes/snapshots:runDelete"
			)
		).map((job) => job.snapshotRowId);
		expect(queued).not.toContain(previous);
	});
});

// Restoring a snapshot puts the box back on the version its files came from.
// Without it the restored disk boots under whatever image the box's row names
// now - which, immediately after an update, is the one being rolled away from.
describe("the version a restore puts back", () => {
	async function restorableSnapshot(
		t: Harness,
		seed: Partial<Doc<"box_snapshots">> = {}
	) {
		const { boxId } = await ownedRunningBox(t);
		const snapshotRowId = await seedSnapshot(t, boxId, {
			status: "complete",
			imageId: 4242
		});
		await t.run(
			async (ctx) =>
				await ctx.db.patch(snapshotRowId, {
					runtime_image: "ghcr.io/x@sha256:old",
					runtime_version: "0.1.0",
					...seed
				})
		);
		return snapshotRowId;
	}

	test("offers the version the snapshot was taken on", async () => {
		const t = testConvex();
		const snapshotRowId = await restorableSnapshot(t);

		expect(
			await t.query(internal.boxes.snapshots.snapshotRestoreTarget, {
				snapshotRowId
			})
		).toMatchObject({
			floorClamped: false,
			runtimeImage: "ghcr.io/x@sha256:old",
			runtimeVersion: "0.1.0"
		});
	});

	// A floor is the one thing that overrides the recorded version. Putting back a
	// version staff have retired would undo an update this deployment does
	// not consider optional, so the files come back and the image does not.
	test("puts a box below the fleet floor onto the floor image instead", async () => {
		const t = testConvex();
		const snapshotRowId = await restorableSnapshot(t);
		await seedSettings(t, {
			minimum_runtime_image: "ghcr.io/x@sha256:floor",
			minimum_runtime_version: "0.3.0"
		});

		expect(
			await t.query(internal.boxes.snapshots.snapshotRestoreTarget, {
				snapshotRowId
			})
		).toMatchObject({
			floorClamped: true,
			runtimeImage: "ghcr.io/x@sha256:floor",
			runtimeVersion: "0.3.0"
		});
	});

	// A snapshot already on the floor image is not below it, so nothing is
	// clamped and the recorded version is what comes back.
	test("leaves a snapshot already on the floor image alone", async () => {
		const t = testConvex();
		const snapshotRowId = await restorableSnapshot(t, {
			runtime_image: "ghcr.io/x@sha256:floor",
			runtime_version: "0.3.0"
		});
		await seedSettings(t, {
			minimum_runtime_image: "ghcr.io/x@sha256:floor",
			minimum_runtime_version: "0.3.0"
		});

		expect(
			await t.query(internal.boxes.snapshots.snapshotRestoreTarget, {
				snapshotRowId
			})
		).toMatchObject({
			floorClamped: false,
			runtimeImage: "ghcr.io/x@sha256:floor"
		});
	});
});

// The cooldown is about how often the owner may press the button, so only their
// own snapshots may set it running. It used to read the last snapshot of any
// class, which let a nightly capture - or the safety copy taken before an
// update - lock them out of their own box for the length of an operator setting.
describe("what the manual cooldown counts", () => {
	test("ignores a rollback snapshot taken moments ago", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		await seedSnapshot(t, boxId, { class: "rollback", createdAt: NOW });

		await owner.as.mutation(api.owner.boxes.createSnapshot, { slug: "mine" });

		expect(await boxOperations(t, boxId)).toHaveLength(1);
	});

	// Still in progress is still in progress, whoever asked for it: Hetzner
	// serializes a server's actions, so a second capture cannot start beside it.
	// The sentence says which kind is running rather than implying it was theirs.
	test("still refuses while a rollback capture is running, and says so", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedRunningBox(t);
		await seedSnapshot(t, boxId, {
			class: "rollback",
			createdAt: NOW,
			status: "creating"
		});

		await expect(
			owner.as.mutation(api.owner.boxes.createSnapshot, { slug: "mine" })
		).rejects.toThrow("safety snapshot");
	});
});
