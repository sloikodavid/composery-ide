import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "@/convex/_generated/api";
import { DAY_MS } from "@/convex/time";
import {
	DELETE_ATTEMPTS_BEFORE_ALERT,
	deleteNeedsPerson
} from "@/convex/boxes/cleanup";
import { SUBSCRIPTION_RECONCILIATION_STATUSES } from "@/convex/boxes/queries";
import {
	billingRecordPurgeAt,
	deletedBoxPurgeAt
} from "@/convex/boxes/retention";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import {
	boxEvents,
	boxOperations,
	readBox,
	readOperation,
	scheduledArgs,
	scheduledJobs,
	seedBox,
	seedUser,
	staffAlerts,
	testConvex,
	type Harness
} from "../../../support/convex";

const NOW = Date.UTC(2026, 6, 29, 10, 0, 0);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("deleteNeedsPerson", () => {
	// The incident this sweep exists for had exactly one failed delete, on a box
	// whose Hetzner teardown had already finished. A rule that only reacted to
	// repeat failures would have stayed silent on it - which is what happened.
	test("does not call one failure a standing problem", () => {
		expect(deleteNeedsPerson(1)).toBe(false);
	});

	test("escalates at the threshold and not before", () => {
		expect(deleteNeedsPerson(DELETE_ATTEMPTS_BEFORE_ALERT - 1)).toBe(false);
		expect(deleteNeedsPerson(DELETE_ATTEMPTS_BEFORE_ALERT)).toBe(true);
		expect(deleteNeedsPerson(DELETE_ATTEMPTS_BEFORE_ALERT + 10)).toBe(true);
	});
});

describe("delete_failed has one owner", () => {
	// If subscription reconciliation started reaching delete_failed boxes again,
	// two hourly sweeps would re-drive the same deletion under different triggers
	// and the box's history would stop saying which one was finishing it.
	test("leaves delete_failed to the sweep that finishes deletions", () => {
		expect(SUBSCRIPTION_RECONCILIATION_STATUSES).not.toContain("delete_failed");
	});

	// The exclusion has to stay narrow: a box that is merely broken is not on its
	// way out, and its subscription still has to be checked.
	test("still reconciles boxes that failed something other than deletion", () => {
		expect(SUBSCRIPTION_RECONCILIATION_STATUSES).toContain("repair_failed");
		expect(SUBSCRIPTION_RECONCILIATION_STATUSES).toContain("create_failed");
		expect(SUBSCRIPTION_RECONCILIATION_STATUSES).toContain("running");
	});
});

describe("finishFailedDeletions", () => {
	test("alerts at the threshold without abandoning the deletion retry", async () => {
		const t = testConvex();
		const boxId = await seedBox(t, {
			user_id: "owner",
			status: "delete_failed"
		});
		await t.run(async (ctx) => {
			for (let attempt = 0; attempt < DELETE_ATTEMPTS_BEFORE_ALERT; attempt++) {
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: "delete",
					status: "failed",
					idempotency_key: `failed:${attempt}`,
					trigger: "system:delete_retry",
					created_at: attempt,
					updated_at: attempt
				});
			}
		});

		await t.action(internal.boxes.cleanup.finishFailedDeletions, {});

		expect(await staffAlerts(t)).toEqual([
			expect.objectContaining({
				severity: "critical",
				subject: expect.stringContaining(
					`has failed to delete ${DELETE_ATTEMPTS_BEFORE_ALERT} times`
				)
			})
		]);
		expect(await boxOperations(t, boxId)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					idempotency_key: `delete:${boxId}`,
					status: "pending",
					trigger: "system:delete_retry",
					type: "delete"
				})
			])
		);
	});

	test("retries below the threshold without raising a staff alert", async () => {
		const t = testConvex();
		const boxId = await seedBox(t, {
			user_id: "owner",
			status: "delete_failed"
		});
		await t.run(
			async (ctx) =>
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: "delete",
					status: "failed",
					idempotency_key: "failed:once",
					trigger: "system:delete_retry",
					created_at: 1,
					updated_at: 1
				})
		);

		await t.action(internal.boxes.cleanup.finishFailedDeletions, {});

		expect(await staffAlerts(t)).toEqual([]);
		expect(await boxOperations(t, boxId)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					status: "pending",
					trigger: "system:delete_retry",
					type: "delete"
				})
			])
		);
	});
});

describe("purgeBox", () => {
	test("removes runtime health, unlinks billing evidence, and schedules provider cleanup", async () => {
		const t = testConvex();
		const boxId = await seedBox(t, {
			deleted_at: NOW - 2,
			purge_at: NOW - 1,
			status: "deleted",
			user_id: "deleted:owner"
		});
		const { healthId, intentId, snapshotId } = await t.run(async (ctx) => {
			const healthId = await ctx.db.insert("box_health", {
				box_id: boxId,
				consecutive_failures: 4,
				updated_at: NOW - 10
			});
			const intentId = await ctx.db.insert("box_checkout_intents", {
				box_id: boxId,
				created_at: NOW - 10,
				plan: "air",
				slug: "old-box",
				status: "converted",
				updated_at: NOW - 10,
				user_id: "deleted:owner"
			});
			const snapshotId = await ctx.db.insert("box_snapshots", {
				box_id: boxId,
				class: "manual",
				created_at: NOW - 10,
				status: "complete"
			});
			return { healthId, intentId, snapshotId };
		});

		await t.mutation(internal.boxes.cleanup.purgeBox, { boxId });

		const rows = await t.run(async (ctx) => ({
			box: await ctx.db.get(boxId),
			health: await ctx.db.get(healthId),
			intent: await ctx.db.get(intentId)
		}));
		expect(rows.health).toBeNull();
		expect(rows.intent?.slug).toBe(`deleted-${intentId}`);
		expect(Object.hasOwn(rows.intent ?? {}, "box_id")).toBe(false);
		expect(rows.box).not.toBeNull();
		expect(
			await scheduledArgs<{ snapshotRowId: typeof snapshotId }>(
				t,
				"boxes/snapshots:runDelete"
			)
		).toEqual([{ snapshotRowId: snapshotId }]);
	});

	test("reschedules each independent dependency and deletes only an empty box", async () => {
		for (const dependency of [
			"health",
			"intent",
			"snapshot",
			"none"
		] as const) {
			const t = testConvex();
			const boxId = await seedBox(t, {
				deleted_at: NOW - 2,
				purge_at: NOW - 1,
				slug: `box-${dependency}`,
				status: "deleted",
				user_id: "deleted:owner"
			});
			await t.run(async (ctx) => {
				if (dependency === "health") {
					await ctx.db.insert("box_health", {
						box_id: boxId,
						consecutive_failures: 1,
						updated_at: NOW - 10
					});
				}
				if (dependency === "intent") {
					await ctx.db.insert("box_checkout_intents", {
						box_id: boxId,
						created_at: NOW - 10,
						plan: "air",
						slug: "old-box",
						status: "converted",
						updated_at: NOW - 10,
						user_id: "deleted:owner"
					});
				}
				if (dependency === "snapshot") {
					await ctx.db.insert("box_snapshots", {
						box_id: boxId,
						class: "manual",
						created_at: NOW - 10,
						status: "complete"
					});
				}
			});

			await t.mutation(internal.boxes.cleanup.purgeBox, { boxId });

			const box = await t.run(async (ctx) => await ctx.db.get(boxId));
			const purgeJobs = (await scheduledJobs(t)).filter(
				(job) => job.name === "boxes/cleanup:purgeBox"
			);
			if (dependency === "none") {
				expect(box).toBeNull();
				expect(purgeJobs).toEqual([]);
			} else {
				expect(box).not.toBeNull();
				expect(purgeJobs).toEqual([
					expect.objectContaining({
						scheduledTime: NOW + (dependency === "snapshot" ? 60_000 : 0),
						args: [{ boxId }]
					})
				]);
			}
		}
	});
});

// The retention machinery: what a deleted box leaves behind, for how long, and
// what eventually removes it.
//
// Two of these walk a `purge_at` range, and that index is the one this codebase
// warns about by name: `purge_at` is optional, and Convex orders a missing field
// *below* every number, so a bare `lte("purge_at", now)` selects every row that
// never got one - which is every live box and every checkout still in flight.
// The lower bound is the only thing between this sweep and the whole table.
describe("scheduling expired boxes for purge", () => {
	const scheduledPurges = (t: Harness) =>
		scheduledArgs<{ boxId: Id<"boxes"> }>(t, "boxes/cleanup:purgeBox");

	async function box(t: Harness, seed: Partial<Doc<"boxes">>) {
		const owner = await seedUser(t, {
			clerkUserId: `user_${seed.slug ?? "x"}`
		});
		return await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: String(seed.slug ?? "box"),
			...seed
		});
	}

	test("schedules a tombstone whose window has closed", async () => {
		const t = testConvex();
		const boxId = await box(t, {
			slug: "due",
			status: "deleted",
			purge_at: NOW - 1
		});

		await t.mutation(internal.boxes.cleanup.scheduleExpiredBoxPurges, {});

		expect(await scheduledPurges(t)).toEqual([{ boxId }]);
	});

	// The failure this file's comment exists for. A live box has no `purge_at`
	// at all, and an unbounded range would sort it below every number and hand it
	// to `purgeBox` - which deletes every row that names it.
	test("never selects a live box, which has no purge date at all", async () => {
		const t = testConvex();
		await box(t, { slug: "alive", status: "running" });

		await t.mutation(internal.boxes.cleanup.scheduleExpiredBoxPurges, {});

		expect(await scheduledPurges(t)).toEqual([]);
	});

	test("leaves a tombstone whose window is still open", async () => {
		const t = testConvex();
		await box(t, { slug: "waiting", status: "deleted", purge_at: NOW + 1 });

		await t.mutation(internal.boxes.cleanup.scheduleExpiredBoxPurges, {});

		expect(await scheduledPurges(t)).toEqual([]);
	});
});

describe("purging expired checkout records", () => {
	async function intent(t: Harness, seed: Record<string, unknown>) {
		return await t.run(
			async (ctx) =>
				await ctx.db.insert("box_checkout_intents", {
					user_id: "user_buyer",
					slug: String(seed.slug ?? "wanted"),
					plan: "air",
					status: "released",
					created_at: 1,
					updated_at: 1,
					...seed
				})
		);
	}

	const rows = (t: Harness) =>
		t.run((ctx) => ctx.db.query("box_checkout_intents").collect());

	test("removes a record past its window", async () => {
		const t = testConvex();
		await intent(t, { purge_at: NOW - 1 });

		await t.mutation(internal.boxes.cleanup.purgeExpiredCheckoutRecords, {});

		expect(await rows(t)).toEqual([]);
	});

	// The same lower-bound trap: an intent still in flight has no purge date, and
	// deleting it would lose the record of a checkout somebody is paying for.
	test("never selects an intent that has no purge date yet", async () => {
		const t = testConvex();
		await intent(t, { status: "active" });

		await t.mutation(internal.boxes.cleanup.purgeExpiredCheckoutRecords, {});

		expect(await rows(t)).toHaveLength(1);
	});

	// Statutory retention outranks the ordinary window: a paid record is kept
	// until its own longer date, and the sweep re-dates it rather than deleting.
	test("defers to a longer statutory hold rather than deleting", async () => {
		const t = testConvex();
		await intent(t, { purge_at: NOW - 1, retain_until: NOW + 100_000 });

		await t.mutation(internal.boxes.cleanup.purgeExpiredCheckoutRecords, {});

		expect(await rows(t)).toMatchObject([{ purge_at: NOW + 100_000 }]);
	});

	// A record still naming a live box is evidence about a box that exists, so
	// the sweep backs off and looks again rather than unlinking it early.
	test("backs off from a record whose box is still there", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, { user_id: owner.clerkUserId });
		await intent(t, { purge_at: NOW - 1, box_id: boxId });

		await t.mutation(internal.boxes.cleanup.purgeExpiredCheckoutRecords, {});

		const [row] = await rows(t);
		expect(row).toBeDefined();
		expect(row?.purge_at).toBeGreaterThan(NOW);
	});
});

// What a deleted box's own rows keep. The box row is a tombstone kept for
// support; everything hanging off it that is not evidence goes now.
describe("removing a deleted box's runtime data", () => {
	test("removes the rows that only describe a box that is running", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "deleted"
		});
		await t.run(async (ctx) => {
			await ctx.db.insert("box_metrics", {
				box_id: boxId,
				sampled_at: 1,
				cpu_percent: 1,
				ingress_bps: 1,
				egress_bps: 1,
				ingress_pps: 1,
				egress_pps: 1,
				disk_read_bps: 1,
				disk_write_bps: 1
			});
			// The row automatic repair's failure count lives in. Left behind, it is
			// a count for a box that can never be probed again.
			await ctx.db.insert("box_health", {
				box_id: boxId,
				consecutive_failures: 3,
				updated_at: 1
			});
			await ctx.db.insert("box_auth_codes", {
				box_id: boxId,
				code_hash: "c",
				code_challenge: "x",
				redirect_uri: "https://x/y",
				type: "session",
				expires_at: NOW + 1000,
				created_at: 1
			});
		});

		await t.mutation(internal.boxes.cleanup.deleteRuntimeData, { boxId });

		expect(
			await t.run(async (ctx) => ({
				metrics: (await ctx.db.query("box_metrics").collect()).length,
				health: (await ctx.db.query("box_health").collect()).length,
				codes: (await ctx.db.query("box_auth_codes").collect()).length
			}))
		).toEqual({ metrics: 0, health: 0, codes: 0 });
	});
});

// Sanitisation: a deleted box keeps its history for support, with the parts that
// are somebody's data taken out of it.
describe("sanitising a deleted box's history", () => {
	test("frees the slug an operation reserved and drops its error text", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "deleted"
		});
		const operationId = await t.run(
			async (ctx) =>
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: "change_slug",
					status: "failed",
					idempotency_key: "k",
					reserved_slug: "wanted",
					last_error: "the host named 1.2.3.4 refused",
					trigger: "owner",
					created_at: 1,
					updated_at: 1
				})
		);

		await t.mutation(internal.boxes.cleanup.sanitizeOperations, { boxId });

		const row = await readOperation(t, operationId);
		expect(row).not.toHaveProperty("reserved_slug");
		expect(row).not.toHaveProperty("last_error");
		// Re-keyed so the original idempotency key cannot collide with a future
		// operation on a box that reuses the slug.
		expect(row?.idempotency_key).toBe(`deleted:${operationId}`);
	});

	// A suspension's reason survives, because it is the answer to "why was I
	// suspended" long after the box is gone. Nothing else does.
	test("keeps a suspension's reason and nothing else's metadata", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "deleted"
		});
		await t.run(async (ctx) => {
			await ctx.db.insert("box_operations", {
				box_id: boxId,
				type: "suspend",
				status: "succeeded",
				idempotency_key: "s",
				trigger: "staff",
				metadata: { reason: "Sustained egress", note: "internal" },
				created_at: 1,
				updated_at: 1
			});
			await ctx.db.insert("box_operations", {
				box_id: boxId,
				type: "change_slug",
				status: "succeeded",
				idempotency_key: "c",
				trigger: "owner",
				metadata: { oldSlug: "a", newSlug: "b" },
				created_at: 2,
				updated_at: 2
			});
		});

		await t.mutation(internal.boxes.cleanup.sanitizeOperations, { boxId });

		const rows = await boxOperations(t, boxId);
		expect(rows.find((row) => row.type === "suspend")?.metadata).toEqual({
			reason: "Sustained egress"
		});
		expect(rows.find((row) => row.type === "change_slug")).not.toHaveProperty(
			"metadata"
		);
	});

	test("strips the message and metadata from every event", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "deleted"
		});
		await t.run(async (ctx) => {
			await ctx.db.insert("box_events", {
				box_id: boxId,
				user_id: owner.clerkUserId,
				type: "box.repair_failed",
				message: "ssh to 1.2.3.4 refused",
				metadata: { host: "1.2.3.4" },
				created_at: 1
			});
		});

		await t.mutation(internal.boxes.cleanup.sanitizeEvents, { boxId });

		const [event] = await boxEvents(t, boxId);
		// The type stays: what happened is the history, and it names no one.
		expect(event?.type).toBe("box.repair_failed");
		expect(event).not.toHaveProperty("message");
		expect(event).not.toHaveProperty("metadata");
	});
});

// A box deleted before the tombstone rules existed has a `deleted` status and no
// purge date, so nothing would ever collect it. This is what gives it one.
describe("normalising boxes deleted before they had a purge date", () => {
	test("dates a tombstone from when it was deleted and schedules its cleanup", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "deleted",
			deleted_at: NOW - 1000
		});

		await t.mutation(internal.boxes.cleanup.normalizeDeletedBoxes, {});

		expect(await readBox(t, boxId)).toMatchObject({
			purge_at: deletedBoxPurgeAt(NOW - 1000)
		});
		expect(
			await scheduledJobs(t, "boxes/cleanup:deleteRuntimeData")
		).toHaveLength(1);
	});

	// No `deleted_at` either, on the oldest rows. `updated_at` is the closest
	// honest answer, and dating from "now" would restart a window that has in
	// fact been running for months.
	test("falls back to when the row was last touched", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await t.run(
			async (ctx) =>
				await ctx.db.insert("boxes", {
					user_id: owner.clerkUserId,
					slug: "ancient",
					plan: "air",
					manual_snapshot_cap: 0,
					status: "deleted",
					created_at: 1,
					updated_at: NOW - 5000
				})
		);

		await t.mutation(internal.boxes.cleanup.normalizeDeletedBoxes, {});

		expect(await readBox(t, boxId)).toMatchObject({
			purge_at: deletedBoxPurgeAt(NOW - 5000)
		});
	});

	test("leaves a tombstone that already has a purge date alone", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "deleted",
			deleted_at: NOW - 1000,
			purge_at: NOW + 99
		});

		await t.mutation(internal.boxes.cleanup.normalizeDeletedBoxes, {});

		expect(await readBox(t, boxId)).toMatchObject({ purge_at: NOW + 99 });
	});

	test("leaves a live box alone", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "running"
		});

		await t.mutation(internal.boxes.cleanup.normalizeDeletedBoxes, {});

		expect(await readBox(t, boxId)).not.toHaveProperty("purge_at");
	});
});

// Checkout records outlive the box they bought, because a refund, a chargeback
// or a tax enquiry is answered from them. What they must not outlive is the
// live checkout link they carry: that is a capability anyone holding it could
// act on, and it means nothing once the box exists.
describe("starting a deleted box's checkout retention", () => {
	async function intents(t: Harness, boxId: Id<"boxes">, count: number) {
		await t.run(async (ctx) => {
			for (let index = 0; index < count; index += 1) {
				await ctx.db.insert("box_checkout_intents", {
					user_id: "user_buyer",
					slug: `bought-${index}`,
					plan: "air",
					status: "converted",
					box_id: boxId,
					polar_checkout_url: "https://polar.test/checkout/secret",
					created_at: 1,
					updated_at: 1
				});
			}
		});
	}

	const rows = (t: Harness) =>
		t.run((ctx) => ctx.db.query("box_checkout_intents").collect());

	async function deletedBox(t: Harness) {
		const owner = await seedUser(t);
		return await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "deleted"
		});
	}

	test("dates the record for statutory retention and drops its live link", async () => {
		const t = testConvex();
		const boxId = await deletedBox(t);
		await intents(t, boxId, 1);

		await t.mutation(internal.boxes.cleanup.startCheckoutRetention, {
			boxId,
			deletedAt: NOW
		});

		const [row] = await rows(t);
		expect(row?.purge_at).toBe(billingRecordPurgeAt(NOW));
		expect(row).not.toHaveProperty("polar_checkout_url");
	});

	// Bounded per transaction and re-driven, so a box bought and re-bought more
	// times than one page holds still has every record dated.
	test("comes back for the rest when it fills a page", async () => {
		const t = testConvex();
		const boxId = await deletedBox(t);
		await intents(t, boxId, 101);

		await t.mutation(internal.boxes.cleanup.startCheckoutRetention, {
			boxId,
			deletedAt: NOW
		});

		const [next] = await scheduledArgs<{ cursor: string | null }>(
			t,
			"boxes/cleanup:startCheckoutRetention"
		);
		expect(next?.cursor).toEqual(expect.any(String));
	});

	test("stops when one page was all of them", async () => {
		const t = testConvex();
		const boxId = await deletedBox(t);
		await intents(t, boxId, 2);

		await t.mutation(internal.boxes.cleanup.startCheckoutRetention, {
			boxId,
			deletedAt: NOW
		});

		expect(
			await scheduledJobs(t, "boxes/cleanup:startCheckoutRetention")
		).toEqual([]);
	});

	// Another box's records are another box's evidence.
	test("leaves another box's checkout records alone", async () => {
		const t = testConvex();
		const boxId = await deletedBox(t);
		const other = await deletedBox(t);
		await intents(t, other, 1);

		await t.mutation(internal.boxes.cleanup.startCheckoutRetention, {
			boxId,
			deletedAt: NOW
		});

		expect(await rows(t)).toMatchObject([
			{ polar_checkout_url: "https://polar.test/checkout/secret" }
		]);
	});
});

// Every sweep in this file is bounded per transaction and re-drives itself on a
// full batch. A missing re-drive is the shape that shrinks a table by one batch
// a day for ever while the cron reports success.
describe("sweeps that come back for the rest", () => {
	async function deletedBoxes(t: Harness, count: number) {
		const owner = await seedUser(t);
		await t.run(async (ctx) => {
			for (let index = 0; index < count; index += 1) {
				await ctx.db.insert("boxes", {
					user_id: owner.clerkUserId,
					slug: `gone-${index}`,
					plan: "air",
					manual_snapshot_cap: 0,
					status: "deleted",
					deleted_at: NOW - 1,
					created_at: 1,
					updated_at: 1
				});
			}
		});
	}

	test("normalising tombstones re-drives on a full batch", async () => {
		const t = testConvex();
		await deletedBoxes(t, 100);

		await t.mutation(internal.boxes.cleanup.normalizeDeletedBoxes, {});

		expect(
			await scheduledJobs(t, "boxes/cleanup:normalizeDeletedBoxes")
		).toHaveLength(1);
	});

	test("normalising stops when it did not fill one", async () => {
		const t = testConvex();
		await deletedBoxes(t, 2);

		await t.mutation(internal.boxes.cleanup.normalizeDeletedBoxes, {});

		expect(
			await scheduledJobs(t, "boxes/cleanup:normalizeDeletedBoxes")
		).toEqual([]);
	});

	test("purging checkout records re-drives on a full batch", async () => {
		const t = testConvex();
		await t.run(async (ctx) => {
			for (let index = 0; index < 100; index += 1) {
				await ctx.db.insert("box_checkout_intents", {
					user_id: "user_buyer",
					slug: `old-${index}`,
					plan: "air",
					status: "released",
					purge_at: NOW - 1,
					created_at: 1,
					updated_at: 1
				});
			}
		});

		await t.mutation(internal.boxes.cleanup.purgeExpiredCheckoutRecords, {});

		expect(
			await scheduledJobs(t, "boxes/cleanup:purgeExpiredCheckoutRecords")
		).toHaveLength(1);
	});

	test("scheduling purges walks past a full page of tombstones", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		await t.run(async (ctx) => {
			for (let index = 0; index < 101; index += 1) {
				await ctx.db.insert("boxes", {
					user_id: owner.clerkUserId,
					slug: `due-${index}`,
					plan: "air",
					manual_snapshot_cap: 0,
					status: "deleted",
					purge_at: NOW - 1,
					created_at: 1,
					updated_at: 1
				});
			}
		});

		await t.mutation(internal.boxes.cleanup.scheduleExpiredBoxPurges, {});

		const [next] = await scheduledArgs<{ cursor: string | null }>(
			t,
			"boxes/cleanup:scheduleExpiredBoxPurges"
		);
		expect(next?.cursor).toEqual(expect.any(String));
	});

	test("sanitising a long history walks past its first page", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "deleted"
		});
		await t.run(async (ctx) => {
			for (let index = 0; index < 101; index += 1) {
				await ctx.db.insert("box_events", {
					box_id: boxId,
					user_id: owner.clerkUserId,
					type: "box.repair_failed",
					message: "ssh refused",
					created_at: index
				});
			}
		});

		await t.mutation(internal.boxes.cleanup.sanitizeEvents, { boxId });

		const [next] = await scheduledArgs<{ cursor: string | null }>(
			t,
			"boxes/cleanup:sanitizeEvents"
		);
		expect(next?.cursor).toEqual(expect.any(String));
	});

	test("removing runtime data comes back while a table still has rows", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "deleted"
		});
		await t.run(async (ctx) => {
			for (let index = 0; index < 100; index += 1) {
				await ctx.db.insert("box_metrics", {
					box_id: boxId,
					sampled_at: index,
					cpu_percent: 1,
					ingress_bps: 1,
					egress_bps: 1,
					ingress_pps: 1,
					egress_pps: 1,
					disk_read_bps: 1,
					disk_write_bps: 1
				});
			}
		});

		await t.mutation(internal.boxes.cleanup.deleteRuntimeData, { boxId });

		expect(
			await scheduledJobs(t, "boxes/cleanup:deleteRuntimeData")
		).toHaveLength(1);
	});
});

// The one alert in this file, and the only thing that tells a person a box is
// stuck. Its owner is gone, so nobody opens its page; the sweep retries in
// silence for ever. Everything about it is therefore load-bearing: whether it
// fires, how often, and whether it says enough to act on.
describe("telling staff a deletion needs a person", () => {
	async function stuckBox(t: Harness, seed: Partial<Doc<"boxes">> = {}) {
		const owner = await seedUser(t);
		return await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas",
			status: "delete_failed",
			hetzner_server_id: 4242,
			...seed
		});
	}

	const raise = (t: Harness, boxId: Id<"boxes">, failedDeletes = 3) =>
		t.mutation(internal.boxes.cleanup.alertDeletionNeedsPerson, {
			boxId,
			failedDeletes
		});

	test("names the box, its identifier and how many attempts failed", async () => {
		const t = testConvex();
		const boxId = await stuckBox(t);

		await raise(t, boxId, 7);

		const [alert] = await staffAlerts(t);
		expect(alert?.subject).toBe("Box atlas has failed to delete 7 times");
		expect(alert?.text).toContain(boxId);
		expect(alert?.text).toContain("7 failures");
		expect(alert?.severity).toBe("critical");
	});

	// The server id is what someone checks first, because a teardown that
	// finished at Hetzner still leaves this record behind - and a box with none
	// recorded has to say that rather than leave the sentence out.
	test("says which Hetzner server to look at", async () => {
		const t = testConvex();
		const boxId = await stuckBox(t);

		await raise(t, boxId);

		expect((await staffAlerts(t))[0]?.text).toContain(
			"recorded Hetzner server is 4242"
		);
	});

	test("says so when there is no server to look at", async () => {
		const t = testConvex();
		const boxId = await stuckBox(t, { hetzner_server_id: undefined });

		await raise(t, boxId);

		expect((await staffAlerts(t))[0]?.text).toContain(
			"no Hetzner server recorded"
		);
	});

	// The sweep runs hourly and the box stays stuck, so the alert is keyed per
	// box per day. Without that an unattended box sends mail every hour until
	// somebody mutes the address the alerts arrive at.
	test("raises one alert a day however often the sweep runs", async () => {
		const t = testConvex();
		const boxId = await stuckBox(t);

		for (let hour = 0; hour < 5; hour += 1) {
			vi.setSystemTime(NOW + hour * 60 * 60 * 1000);
			await raise(t, boxId);
		}

		expect(await staffAlerts(t)).toHaveLength(1);
	});

	test("raises it again the next day", async () => {
		const t = testConvex();
		const boxId = await stuckBox(t);
		await raise(t, boxId);

		vi.setSystemTime(NOW + 24 * 60 * 60 * 1000);
		await raise(t, boxId);

		expect(await staffAlerts(t)).toHaveLength(2);
	});

	// Two boxes stuck on the same day are two problems.
	test("keeps two stuck boxes apart", async () => {
		const t = testConvex();
		await raise(t, await stuckBox(t));
		await raise(t, await stuckBox(t, { slug: "borealis" }));

		expect(await staffAlerts(t)).toHaveLength(2);
	});

	// The sweep reads the list and alerts in a separate transaction, so a box
	// that finished deleting in between must not produce an alert about a
	// deletion that is no longer failing.
	test("says nothing about a box that recovered in the meantime", async () => {
		const t = testConvex();
		const boxId = await stuckBox(t, { status: "deleted" });

		await raise(t, boxId);

		expect(await staffAlerts(t)).toEqual([]);
	});

	test("says nothing about a box that is gone entirely", async () => {
		const t = testConvex();
		const boxId = await stuckBox(t);
		await t.run(async (ctx) => await ctx.db.delete(boxId));

		await raise(t, boxId);

		expect(await staffAlerts(t)).toEqual([]);
	});

	// The query the sweep reads. An empty fleet has nothing stuck in it, and a
	// list that is not empty is what makes the sweep act.
	test("reports nothing when no deletion is failing", async () => {
		const t = testConvex();
		await stuckBox(t, { status: "deleted" });

		expect(
			await t.query(internal.boxes.cleanup.boxesFailedToDelete, {})
		).toEqual([]);
	});
});

// The follow-up work a tombstone schedules, asserted by what each job was asked
// to do rather than by how many were queued. Every one of these carries the box
// it is for, and a job that lost it would run against nothing at all.
describe("what normalising a tombstone hands to the next step", () => {
	test("gives every follow-up the box it is for", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "deleted",
			deleted_at: NOW - 5
		});

		await t.mutation(internal.boxes.cleanup.normalizeDeletedBoxes, {});

		for (const step of [
			"deleteRuntimeData",
			"sanitizeOperations",
			"sanitizeEvents"
		]) {
			expect(await scheduledArgs(t, `boxes/cleanup:${step}`)).toEqual([
				{ boxId }
			]);
		}
		expect(
			await scheduledArgs(t, "boxes/cleanup:startCheckoutRetention")
		).toEqual([{ boxId, deletedAt: NOW - 5 }]);
	});

	// The tombstone's own date is what every retention window is measured from,
	// and a row that never got one falls back to when it was last touched.
	test("dates the retention from the box's last update when it never got one", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "deleted",
			updated_at: NOW - 9
		});

		await t.mutation(internal.boxes.cleanup.normalizeDeletedBoxes, {});

		expect(
			await scheduledArgs(t, "boxes/cleanup:startCheckoutRetention")
		).toEqual([{ boxId, deletedAt: NOW - 9 }]);
	});
});

// Removing a box's runtime data walks five tables at once and comes back only
// while one of them still has rows. Coming back when none does is an hourly
// no-op for ever; not coming back when one does leaves data behind.
describe("removing a deleted box's runtime data", () => {
	async function metrics(t: Harness, boxId: Id<"boxes">, count: number) {
		await t.run(async (ctx) => {
			for (let index = 0; index < count; index += 1) {
				await ctx.db.insert("box_metrics", {
					box_id: boxId,
					sampled_at: index,
					cpu_percent: 1,
					ingress_bps: 1,
					egress_bps: 1,
					ingress_pps: 1,
					egress_pps: 1,
					disk_read_bps: 1,
					disk_write_bps: 1
				});
			}
		});
	}

	async function deletedBox(t: Harness) {
		const owner = await seedUser(t);
		return await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "deleted"
		});
	}

	test("stops once every table it walks is drained", async () => {
		const t = testConvex();
		const boxId = await deletedBox(t);
		await metrics(t, boxId, 99);

		await t.mutation(internal.boxes.cleanup.deleteRuntimeData, { boxId });

		expect(await t.run((ctx) => ctx.db.query("box_metrics").collect())).toEqual(
			[]
		);
		expect(await scheduledJobs(t, "boxes/cleanup:deleteRuntimeData")).toEqual(
			[]
		);
	});

	test("comes back for the same box, not for some other", async () => {
		const t = testConvex();
		const boxId = await deletedBox(t);
		await metrics(t, boxId, 100);

		await t.mutation(internal.boxes.cleanup.deleteRuntimeData, { boxId });

		expect(await scheduledArgs(t, "boxes/cleanup:deleteRuntimeData")).toEqual([
			{ boxId }
		]);
	});
});

// Purging checkout records: a record is kept while the law says so, kept while
// the box it bought still exists, and removed otherwise.
describe("purging checkout records that are due", () => {
	async function intent(t: Harness, fields: Record<string, unknown>) {
		return await t.run(
			async (ctx) =>
				await ctx.db.insert("box_checkout_intents", {
					user_id: "user_buyer",
					slug: "bought",
					plan: "air",
					status: "released",
					purge_at: NOW - 1,
					created_at: 1,
					updated_at: 1,
					...fields
				})
		);
	}

	const rows = (t: Harness) =>
		t.run((ctx) => ctx.db.query("box_checkout_intents").collect());

	const purge = (t: Harness) =>
		t.mutation(internal.boxes.cleanup.purgeExpiredCheckoutRecords, {});

	test("removes a record nothing is keeping", async () => {
		const t = testConvex();
		await intent(t, {});

		await purge(t);

		expect(await rows(t)).toEqual([]);
	});

	// A statutory hold that has not run out yet moves the purge date out to it
	// rather than deleting the record now.
	test("defers a record still inside its statutory hold", async () => {
		const t = testConvex();
		await intent(t, { retain_until: NOW + 1000 });

		await purge(t);

		expect(await rows(t)).toMatchObject([{ purge_at: NOW + 1000 }]);
	});

	// The boundary: a hold that runs out exactly now is over. Keeping it would
	// re-defer the same record to the same instant on every sweep for ever.
	test("lets go of a record whose hold runs out exactly now", async () => {
		const t = testConvex();
		await intent(t, { retain_until: NOW });

		await purge(t);

		expect(await rows(t)).toEqual([]);
	});

	// The box outlives the record's own window while it still exists, because a
	// live box's purchase is what proves it was paid for.
	test("keeps a record whose box is still there, and looks again later", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, { user_id: owner.clerkUserId });
		await intent(t, { box_id: boxId });

		await purge(t);

		expect(await rows(t)).toMatchObject([{ purge_at: NOW + DAY_MS }]);
	});

	test("removes a record whose box is long gone", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, { user_id: owner.clerkUserId });
		await t.run(async (ctx) => await ctx.db.delete(boxId));
		await intent(t, { box_id: boxId });

		await purge(t);

		expect(await rows(t)).toEqual([]);
	});

	test("stops when one page was all of them", async () => {
		const t = testConvex();
		await intent(t, {});

		await purge(t);

		expect(
			await scheduledJobs(t, "boxes/cleanup:purgeExpiredCheckoutRecords")
		).toEqual([]);
	});
});

// The three sweeps that page through one box's history. Each hands the next
// transaction a cursor, and the cursor is the whole of what makes the second
// page different from the first - a sweep that dropped it would re-do page one
// for ever and never reach the rest.
describe("paging through a deleted box's history", () => {
	async function deletedBox(t: Harness) {
		const owner = await seedUser(t);
		return {
			boxId: await seedBox(t, {
				user_id: owner.clerkUserId,
				status: "deleted"
			}),
			userId: owner.clerkUserId
		};
	}

	async function events(t: Harness, boxId: Id<"boxes">, count: number) {
		await t.run(async (ctx) => {
			for (let index = 0; index < count; index += 1) {
				await ctx.db.insert("box_events", {
					box_id: boxId,
					user_id: "user_owner",
					type: "box.repair_failed",
					message: `ssh refused ${index}`,
					created_at: index
				});
			}
		});
	}

	async function operations(t: Harness, boxId: Id<"boxes">, count: number) {
		await t.run(async (ctx) => {
			for (let index = 0; index < count; index += 1) {
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: "repair",
					status: "failed",
					idempotency_key: `key-${index}`,
					last_error: "ssh refused",
					trigger: "owner",
					created_at: index,
					updated_at: index
				});
			}
		});
	}

	// Follow the cursor the first page produced and assert the rows *after* the
	// first page were reached. A cursor that arrived as null would sanitize page
	// one twice and leave these untouched.
	test("a second page of operations starts where the first stopped", async () => {
		const t = testConvex();
		const { boxId } = await deletedBox(t);
		await operations(t, boxId, 101);

		await t.mutation(internal.boxes.cleanup.sanitizeOperations, { boxId });
		const [next] = await scheduledArgs<{ cursor: string | null }>(
			t,
			"boxes/cleanup:sanitizeOperations"
		);
		await t.mutation(internal.boxes.cleanup.sanitizeOperations, {
			boxId,
			cursor: next?.cursor
		});

		const remaining = await t.run((ctx) =>
			ctx.db.query("box_operations").collect()
		);
		expect(remaining.filter((row) => row.last_error !== undefined)).toEqual([]);
	});

	test("a second page of events starts where the first stopped", async () => {
		const t = testConvex();
		const { boxId } = await deletedBox(t);
		await events(t, boxId, 101);

		await t.mutation(internal.boxes.cleanup.sanitizeEvents, { boxId });
		const [next] = await scheduledArgs<{ cursor: string | null }>(
			t,
			"boxes/cleanup:sanitizeEvents"
		);
		await t.mutation(internal.boxes.cleanup.sanitizeEvents, {
			boxId,
			cursor: next?.cursor
		});

		const remaining = await t.run((ctx) =>
			ctx.db.query("box_events").collect()
		);
		expect(
			remaining.filter((row) => row.message?.includes("ssh refused"))
		).toEqual([]);
	});

	test("sanitising operations stops when one page was all of them", async () => {
		const t = testConvex();
		const { boxId } = await deletedBox(t);
		await operations(t, boxId, 2);

		await t.mutation(internal.boxes.cleanup.sanitizeOperations, { boxId });

		expect(await scheduledJobs(t, "boxes/cleanup:sanitizeOperations")).toEqual(
			[]
		);
	});

	test("sanitising events stops when one page was all of them", async () => {
		const t = testConvex();
		const { boxId } = await deletedBox(t);
		await events(t, boxId, 2);

		await t.mutation(internal.boxes.cleanup.sanitizeEvents, { boxId });

		expect(await scheduledJobs(t, "boxes/cleanup:sanitizeEvents")).toEqual([]);
	});

	test("sanitising operations really does clear what it walked", async () => {
		const t = testConvex();
		const { boxId } = await deletedBox(t);
		await operations(t, boxId, 1);

		await t.mutation(internal.boxes.cleanup.sanitizeOperations, { boxId });

		const [operation] = await t.run((ctx) =>
			ctx.db.query("box_operations").collect()
		);
		expect(operation).not.toHaveProperty("last_error");
		expect(operation).not.toHaveProperty("reserved_slug");
	});
});

// The sweep that hands each due tombstone to its own purge transaction.
describe("scheduling the purge of tombstones that are due", () => {
	async function tombstone(t: Harness, seed: Partial<Doc<"boxes">>) {
		const owner = await seedUser(t);
		return await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "deleted",
			purge_at: NOW - 1,
			...seed
		});
	}

	test("stops when one page was all of them", async () => {
		const t = testConvex();
		await tombstone(t, {});

		await t.mutation(internal.boxes.cleanup.scheduleExpiredBoxPurges, {});

		expect(
			await scheduledJobs(t, "boxes/cleanup:scheduleExpiredBoxPurges")
		).toEqual([]);
	});
});

// The purge itself, which is the only irreversible step in this file.
describe("refusing to purge a box that is not due", () => {
	async function boxWith(t: Harness, seed: Partial<Doc<"boxes">>) {
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "deleted",
			purge_at: NOW - 1,
			...seed
		});
		await t.run(
			async (ctx) =>
				await ctx.db.insert("box_events", {
					box_id: boxId,
					user_id: "user_owner",
					type: "box.create_succeeded",
					message: "created",
					created_at: 1
				})
		);
		return boxId;
	}

	const survived = async (t: Harness) =>
		(await t.run((ctx) => ctx.db.query("box_events").collect())).length > 0;

	test("leaves a box that is not a tombstone alone", async () => {
		const t = testConvex();
		const boxId = await boxWith(t, { status: "running" });

		await t.mutation(internal.boxes.cleanup.purgeBox, { boxId });

		expect(await survived(t)).toBe(true);
	});

	test("leaves a box whose window has not run out alone", async () => {
		const t = testConvex();
		const boxId = await boxWith(t, { purge_at: NOW + 1 });

		await t.mutation(internal.boxes.cleanup.purgeBox, { boxId });

		expect(await survived(t)).toBe(true);
	});

	// Never given a purge date is not the same as due: an unset window is
	// treated as infinitely far away, so nothing is destroyed by omission.
	test("leaves a box that was never given a window alone", async () => {
		const t = testConvex();
		const boxId = await boxWith(t, { purge_at: undefined });

		await t.mutation(internal.boxes.cleanup.purgeBox, { boxId });

		expect(await survived(t)).toBe(true);
	});

	// The boundary: a window that runs out exactly now has run out.
	test("purges a box whose window runs out exactly now", async () => {
		const t = testConvex();
		const boxId = await boxWith(t, { purge_at: NOW });

		await t.mutation(internal.boxes.cleanup.purgeBox, { boxId });

		expect(await survived(t)).toBe(false);
	});
});

// The two sweeps whose cursor had only ever been read off the queue. A cursor
// that arrived as null would re-do the first page for ever, which looks like a
// healthy sweep and never reaches the second.
describe("following a sweep's cursor to its second page", () => {
	test("dating a box's checkout records reaches the ones past the first page", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "deleted"
		});
		await t.run(async (ctx) => {
			for (let index = 0; index < 101; index += 1) {
				await ctx.db.insert("box_checkout_intents", {
					user_id: owner.clerkUserId,
					slug: `bought-${index}`,
					plan: "air",
					status: "converted",
					box_id: boxId,
					polar_checkout_url: "https://polar.test/checkout/secret",
					created_at: 1,
					updated_at: 1
				});
			}
		});

		await t.mutation(internal.boxes.cleanup.startCheckoutRetention, {
			boxId,
			deletedAt: NOW
		});
		const [next] = await scheduledArgs<{ cursor: string | null }>(
			t,
			"boxes/cleanup:startCheckoutRetention"
		);
		await t.mutation(internal.boxes.cleanup.startCheckoutRetention, {
			boxId,
			deletedAt: NOW,
			cursor: next?.cursor
		});

		const rows = await t.run((ctx) =>
			ctx.db.query("box_checkout_intents").collect()
		);
		expect(rows.filter((row) => row.polar_checkout_url !== undefined)).toEqual(
			[]
		);
	});

	test("scheduling purges reaches the tombstones past the first page", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		await t.run(async (ctx) => {
			for (let index = 0; index < 101; index += 1) {
				await ctx.db.insert("boxes", {
					user_id: owner.clerkUserId,
					slug: `due-${index}`,
					plan: "air",
					manual_snapshot_cap: 0,
					status: "deleted",
					purge_at: NOW - 1,
					created_at: 1,
					updated_at: 1
				});
			}
		});

		await t.mutation(internal.boxes.cleanup.scheduleExpiredBoxPurges, {});
		const [next] = await scheduledArgs<{ cursor: string | null }>(
			t,
			"boxes/cleanup:scheduleExpiredBoxPurges"
		);
		await t.mutation(internal.boxes.cleanup.scheduleExpiredBoxPurges, {
			cursor: next?.cursor
		});

		expect(await scheduledJobs(t, "boxes/cleanup:purgeBox")).toHaveLength(101);
	});
});
