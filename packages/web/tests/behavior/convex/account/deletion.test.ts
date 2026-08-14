import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "@/convex/_generated/api";
import { ACCOUNT_DELETION_ALERT_AFTER_MS } from "@/convex/account/deletion";
import type { Doc, Id } from "@/convex/_generated/dataModel";

import {
	boxOperations,
	scheduledJobs,
	staffAlerts,
	seedBox,
	seedUser,
	stubDeploymentEnv,
	testConvex,
	type Harness
} from "../../../support/convex.ts";

// Deleting an account is the one operation here that destroys a customer's work
// on purpose, and the whole of it runs unattended behind a webhook - nobody
// watches it, and there is no undo to reach for if a step is skipped. So what is
// asserted is the state each step leaves behind, not that it ran.

const NOW = Date.UTC(2026, 6, 29, 10, 0, 0);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	stubDeploymentEnv();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

function users(t: Harness) {
	return t.run(async (ctx) => await ctx.db.query("users").collect());
}

function intents(t: Harness) {
	return t.run(
		async (ctx) => await ctx.db.query("box_checkout_intents").collect()
	);
}

async function seedIntent(
	t: Harness,
	seed: Partial<Doc<"box_checkout_intents">> & { user_id: string }
) {
	return await t.run(
		async (ctx) =>
			await ctx.db.insert("box_checkout_intents", {
				slug: "reserved",
				plan: "air",
				status: "active",
				created_at: 1,
				updated_at: 1,
				...seed
			})
	);
}

describe("marking an account for deletion", () => {
	test("frees the slug a half-finished checkout was still holding", async () => {
		const t = testConvex();
		const user = await seedUser(t);
		await seedIntent(t, { user_id: user.clerkUserId });

		await t.mutation(internal.account.deletion.markAccountDeletionPending, {
			clerkUserId: user.clerkUserId
		});

		expect(await intents(t)).toEqual([
			expect.objectContaining({
				status: "released",
				release_reason: "account_deleted"
			})
		]);
		expect((await users(t))[0]).toMatchObject({ deletion_pending: true });
	});

	// A reservation that already became a box is that box's billing record. The
	// box is torn down by its own delete operation; releasing the record it was
	// sold under would throw away the evidence behind a possible refund.
	test("leaves a converted reservation alone", async () => {
		const t = testConvex();
		const user = await seedUser(t);
		const boxId = await seedBox(t, { user_id: user.clerkUserId });
		await seedIntent(t, {
			user_id: user.clerkUserId,
			status: "converted",
			box_id: boxId
		});

		await t.mutation(internal.account.deletion.markAccountDeletionPending, {
			clerkUserId: user.clerkUserId
		});

		expect((await intents(t))[0]).toMatchObject({ status: "converted" });
	});

	test("says nothing happened for an identity with no row", async () => {
		const t = testConvex();

		expect(
			await t.mutation(internal.account.deletion.markAccountDeletionPending, {
				clerkUserId: "never-signed-in"
			})
		).toBeNull();
	});
});

describe("the webhook's own action", () => {
	// A comp box: the paid path revokes a Polar subscription first, which is a
	// network call, and what this asserts is the teardown it orders locally.
	test("marks the account and orders every box torn down", async () => {
		const t = testConvex();
		const user = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: user.clerkUserId,
			comped_at: 1,
			comped_by: "staff"
		});

		await t.action(
			internal.account.deletion.requestAccountDeletionForClerkUser,
			{ clerkUserId: user.clerkUserId }
		);

		expect((await users(t))[0]).toMatchObject({ deletion_pending: true });
		expect(await boxOperations(t, boxId)).toEqual([
			expect.objectContaining({
				type: "delete",
				trigger: "system:account_deletion"
			})
		]);
		expect(
			await scheduledJobs(t, "account/deletion:finalizeAccountDeletion")
		).toHaveLength(1);
	});

	// Clerk sends `user.deleted` for every identity it removes, including ones
	// that never reached Convex. Nothing to delete is not an error.
	test("does nothing for an identity that has no account here", async () => {
		const t = testConvex();

		await t.action(
			internal.account.deletion.requestAccountDeletionForClerkUser,
			{ clerkUserId: "never-signed-in" }
		);

		expect(await users(t)).toEqual([]);
	});
});

describe("finishing a deletion", () => {
	test("waits while a box is still standing", async () => {
		const t = testConvex();
		const user = await seedUser(t, { deletionPending: true });
		await seedBox(t, { user_id: user.clerkUserId, status: "stopped" });

		await t.action(internal.account.deletion.finalizeAccountDeletion, {
			clerkUserId: user.clerkUserId
		});

		expect((await users(t))[0].deletion_finished_at).toBeUndefined();
		expect(
			await scheduledJobs(t, "account/deletion:finalizeAccountDeletion")
		).toHaveLength(1);
	});

	test("finishes once every box is gone", async () => {
		const t = testConvex();
		const user = await seedUser(t, {
			deletionPending: true,
			email: "person@example.com"
		});
		await seedBox(t, { user_id: user.clerkUserId, status: "deleted" });

		await t.action(internal.account.deletion.finalizeAccountDeletion, {
			clerkUserId: user.clerkUserId
		});

		const [row] = await users(t);
		expect(row.deletion_finished_at).toEqual(expect.any(Number));
		expect(row.deletion_pending).toBe(false);
		expect(row.purge_at).toEqual(expect.any(Number));
		// The address is what identifies a person, so it goes. `@deleted.invalid`
		// can never be delivered to, which is what stops a later mailing from
		// reaching whoever inherits a recycled domain.
		expect(row.email).not.toContain("person@example.com");
		expect(row.email).toMatch(/@deleted\.invalid$/);
		// The Clerk id is rewritten too, so the row can no longer be reached by the
		// identity it belonged to - a re-signup with the same subject is a new
		// account rather than a resurrection of this one.
		expect(row.clerk_user_id).toMatch(/^deleted:/);
		expect(row.suspended).toBe(true);
	});

	test("refuses to scrub a row nobody asked to delete", async () => {
		const t = testConvex();
		const user = await seedUser(t, { email: "live@example.com" });

		await t.mutation(internal.account.deletion.finishAccountDeletion, {
			clerkUserId: user.clerkUserId
		});

		const [row] = await users(t);
		expect(row.email).toBe("live@example.com");
		expect(row.deletion_finished_at).toBeUndefined();
	});

	// The box row outlives the account by its own retention window, so what is
	// left behind must no longer name the person it belonged to.
	test("pseudonymizes the records that outlive the account", async () => {
		const t = testConvex();
		const user = await seedUser(t);
		const boxId = await seedBox(t, { user_id: user.clerkUserId });
		await t.run(async (ctx) => {
			await ctx.db.insert("box_events", {
				box_id: boxId,
				user_id: user.clerkUserId,
				type: "box.create_started",
				created_at: 1
			});
			await ctx.db.insert("legal_notice_recipients", {
				notice_id: "terms-2027-01-01",
				user_id: user.clerkUserId,
				email: "live@example.com",
				email_id: "email-1",
				queue_status: "queued",
				created_at: 1,
				purge_at: 2
			});
		});

		await t.mutation(
			internal.account.deletion.pseudonymizeDeletedAccountRecords,
			{
				clerkUserId: user.clerkUserId,
				deletedEmail: "deleted-user-x@deleted.invalid",
				deletedUserId: "deleted:x"
			}
		);

		const [box, events, notices] = await t.run(async (ctx) => [
			await ctx.db.get(boxId),
			await ctx.db.query("box_events").collect(),
			await ctx.db.query("legal_notice_recipients").collect()
		]);
		expect(box?.user_id).toBe("deleted:x");
		expect(events.map((event) => event.user_id)).toEqual(["deleted:x"]);
		// The proof that this person was told survives; the address it was sent to
		// does not. A notice record that kept the address would be an erasure
		// request we did not honour, and one that was deleted outright would throw
		// away the evidence the six-year retention exists to hold.
		expect(notices.map((notice) => [notice.user_id, notice.email])).toEqual([
			["deleted:x", "deleted-user-x@deleted.invalid"]
		]);
		expect(notices[0]?.notice_id).toBe("terms-2027-01-01");
	});
});

describe("purging a finished deletion", () => {
	async function seedFinished(t: Harness, purgeAt: number) {
		return await t.run(
			async (ctx) =>
				await ctx.db.insert("users", {
					clerk_user_id: "deleted:1",
					email: "deleted-1@deleted.invalid",
					role: "user",
					suspended: true,
					deletion_pending: false,
					deletion_finished_at: 1,
					purge_at: purgeAt,
					created_at: 1,
					updated_at: 1
				})
		);
	}

	test("removes the tombstone once nothing points at it", async () => {
		const t = testConvex();
		await seedFinished(t, NOW - 1);

		await t.mutation(internal.account.deletion.purgeExpiredDeletedAccounts, {});

		expect(await users(t)).toEqual([]);
	});

	// Billing evidence outlives the account, and the tombstone is what those rows
	// still resolve against. Purging it early would orphan them.
	test("waits while a retained record still refers to it", async () => {
		const t = testConvex();
		const userId = await seedFinished(t, NOW - 1);
		await seedBox(t, { user_id: "deleted:1", status: "deleted" });

		await t.mutation(internal.account.deletion.purgeExpiredDeletedAccounts, {});

		const row = await t.run(async (ctx) => await ctx.db.get(userId));
		expect(row?.purge_at).toBeGreaterThan(NOW);
	});

	// A live account carrying a purge date is stray state, and the sweep's index
	// range will keep selecting it. Clearing it is what stops a hand-edited or
	// half-migrated row from being deleted by a job that only ever meant to
	// collect tombstones.
	test("clears a purge date that landed on a live account", async () => {
		const t = testConvex();
		const user = await seedUser(t);
		await t.run(
			async (ctx) =>
				await ctx.db.patch(user.userId as Id<"users">, {
					purge_at: NOW - 1
				})
		);

		await t.mutation(internal.account.deletion.purgeExpiredDeletedAccounts, {});

		const [row] = await users(t);
		expect(row.purge_at).toBeUndefined();
		expect(row.clerk_user_id).toBe(user.clerkUserId);
	});
});

// The finalizer, which is the part of a deletion nobody watches.
//
// It runs behind a webhook, reschedules itself until every box is gone, and is
// the only thing standing between "the customer asked to be forgotten" and it
// actually happening. None of its own decisions had been executed: whether it
// stops when the work is done, whether it keeps coming back when it is not, and
// whether anyone is told when it has been stuck for a day.
describe("the finalizer that has to finish or say why", () => {
	async function pendingUser(t: Harness, over: Partial<Doc<"users">> = {}) {
		const owner = await seedUser(t, { clerkUserId: "user_going" });
		await t.run(
			async (ctx) =>
				await ctx.db.patch(owner.userId, {
					deletion_pending: true,
					deletion_requested_at: NOW,
					...over
				})
		);
		return owner;
	}

	const finalize = (t: Harness, clerkUserId = "user_going") =>
		t.action(internal.account.deletion.finalizeAccountDeletion, {
			clerkUserId
		});

	const finalizers = (t: Harness) =>
		scheduledJobs(t, "account/deletion:finalizeAccountDeletion");

	test("finishes the deletion once no box is left", async () => {
		const t = testConvex();
		const owner = await pendingUser(t);

		await finalize(t);

		expect(
			(await users(t)).find((user) => user._id === owner.userId)
		).toMatchObject({ deletion_finished_at: NOW });
	});

	// A box still being torn down is not a finished deletion. Stopping here would
	// scrub the account while its server is still running and still billing.
	test("comes back later while a box is still standing", async () => {
		const t = testConvex();
		const owner = await pendingUser(t);
		await seedBox(t, { user_id: owner.clerkUserId, status: "running" });

		await finalize(t);

		expect(
			(await users(t)).find((user) => user._id === owner.userId)
		).not.toHaveProperty("deletion_finished_at");
		expect(await finalizers(t)).toHaveLength(1);
	});

	// Idempotent by construction: the sweep and the webhook can both reach it.
	test("does nothing for an account whose deletion already finished", async () => {
		const t = testConvex();
		await pendingUser(t, { deletion_finished_at: NOW - 1000 });

		await finalize(t);

		expect(await finalizers(t)).toEqual([]);
	});

	test("does nothing for an account nobody asked to delete", async () => {
		const t = testConvex();
		await seedUser(t, { clerkUserId: "user_staying" });

		await finalize(t, "user_staying");

		expect(await finalizers(t)).toEqual([]);
	});

	test("does nothing for a user who is not there at all", async () => {
		const t = testConvex();

		await expect(finalize(t, "user_missing")).resolves.not.toThrow();
	});

	// The alert is the only signal a deletion is stuck. Without it an account
	// that never finishes stays pending for ever and nobody is told - which for a
	// deletion request is a compliance failure, not just a stalled job.
	test("tells staff once a deletion has been pending for a day", async () => {
		const t = testConvex();
		const owner = await pendingUser(t);
		await seedBox(t, { user_id: owner.clerkUserId, status: "running" });

		vi.setSystemTime(NOW + ACCOUNT_DELETION_ALERT_AFTER_MS);
		await finalize(t);

		expect(await staffAlerts(t)).toMatchObject([
			{
				severity: "critical",
				subject: "Account deletion has been pending for over 24 hours"
			}
		]);
	});

	test("says nothing while a deletion is still inside its window", async () => {
		const t = testConvex();
		const owner = await pendingUser(t);
		await seedBox(t, { user_id: owner.clerkUserId, status: "running" });

		vi.setSystemTime(NOW + ACCOUNT_DELETION_ALERT_AFTER_MS - 1);
		await finalize(t);

		expect(await staffAlerts(t)).toEqual([]);
	});

	// Keyed by the request, so a deletion stuck for a week is one alert rather
	// than one per finalizer run.
	test("raises one alert however often the finalizer runs", async () => {
		const t = testConvex();
		const owner = await pendingUser(t);
		await seedBox(t, { user_id: owner.clerkUserId, status: "running" });

		vi.setSystemTime(NOW + ACCOUNT_DELETION_ALERT_AFTER_MS);
		await finalize(t);
		vi.setSystemTime(NOW + ACCOUNT_DELETION_ALERT_AFTER_MS + 60_000);
		await finalize(t);

		expect(await staffAlerts(t)).toHaveLength(1);
	});

	// An account with no recorded request time cannot be judged stuck, and
	// treating a missing timestamp as "long ago" would alert on every deletion.
	test("does not call a deletion stuck when nothing recorded when it started", async () => {
		const t = testConvex();
		const owner = await pendingUser(t, { deletion_requested_at: undefined });
		await seedBox(t, { user_id: owner.clerkUserId, status: "running" });

		vi.setSystemTime(NOW + ACCOUNT_DELETION_ALERT_AFTER_MS * 10);
		await finalize(t);

		expect(await staffAlerts(t)).toEqual([]);
	});
});

// The sweep that picks up deletions the webhook's own finalizer lost - a Convex
// restart, a scheduler drop. It is the backstop, so it has to walk every pending
// account rather than the first page of them.
describe("sweeping up deletions that lost their finalizer", () => {
	test("queues a finalizer for every pending account", async () => {
		const t = testConvex();
		for (let index = 0; index < 3; index += 1) {
			const owner = await seedUser(t, {
				clerkUserId: `user_${index}`,
				email: `user${index}@example.com`
			});
			await t.run(
				async (ctx) =>
					await ctx.db.patch(owner.userId, {
						deletion_pending: true,
						deletion_requested_at: NOW
					})
			);
		}

		await t.action(internal.account.deletion.sweepPendingAccountDeletions, {});

		expect(
			await scheduledJobs(t, "account/deletion:finalizeAccountDeletion")
		).toHaveLength(3);
	});

	test("leaves accounts nobody asked to delete alone", async () => {
		const t = testConvex();
		await seedUser(t, { clerkUserId: "user_staying" });

		await t.action(internal.account.deletion.sweepPendingAccountDeletions, {});

		expect(
			await scheduledJobs(t, "account/deletion:finalizeAccountDeletion")
		).toEqual([]);
	});

	// More pending accounts than one page. A sweep that stopped after the first
	// would leave the rest pending for ever, and nothing else would notice.
	test("walks past the first page of pending accounts", async () => {
		const t = testConvex();
		await t.run(async (ctx) => {
			for (let index = 0; index < 101; index += 1) {
				await ctx.db.insert("users", {
					clerk_user_id: `bulk_${index}`,
					email: `bulk${index}@example.com`,
					role: "user",
					suspended: false,
					deletion_pending: true,
					deletion_requested_at: NOW,
					created_at: 1,
					updated_at: 1
				});
			}
		});

		await t.action(internal.account.deletion.sweepPendingAccountDeletions, {});

		expect(
			await scheduledJobs(t, "account/deletion:finalizeAccountDeletion")
		).toHaveLength(101);
	});
});

// Marking an account pending is the first irreversible step, and it has to free
// the customer's open checkout immediately: a payment that completes afterwards
// must not become a box owned by an account that asked to be forgotten.
describe("what marking an account pending releases", () => {
	test("releases an open reservation so a late payment cannot land", async () => {
		const t = testConvex();
		const owner = await seedUser(t, { clerkUserId: "user_going" });
		await t.run(
			async (ctx) =>
				await ctx.db.insert("box_checkout_intents", {
					user_id: owner.clerkUserId,
					slug: "reserved",
					plan: "air",
					status: "active",
					created_at: 1,
					updated_at: 1
				})
		);

		await t.mutation(internal.account.deletion.markAccountDeletionPending, {
			clerkUserId: owner.clerkUserId
		});

		expect(await intents(t)).toMatchObject([
			{ status: "released", release_reason: "account_deleted" }
		]);
	});

	// A reservation that already became a box is that box's record, and the box
	// teardown is what deals with it.
	test("leaves a reservation that already became a box alone", async () => {
		const t = testConvex();
		const owner = await seedUser(t, { clerkUserId: "user_going" });
		const boxId = await seedBox(t, { user_id: owner.clerkUserId });
		await t.run(
			async (ctx) =>
				await ctx.db.insert("box_checkout_intents", {
					user_id: owner.clerkUserId,
					slug: "bought",
					plan: "air",
					status: "active",
					box_id: boxId,
					created_at: 1,
					updated_at: 1
				})
		);

		await t.mutation(internal.account.deletion.markAccountDeletionPending, {
			clerkUserId: owner.clerkUserId
		});

		expect(await intents(t)).toMatchObject([{ status: "active" }]);
	});

	// Asking twice is one request. Re-stamping the time would push the stuck
	// alert's deadline out on every retry, so a deletion that never finishes
	// would never be reported either.
	test("keeps the time of the first request when asked twice", async () => {
		const t = testConvex();
		const owner = await seedUser(t, { clerkUserId: "user_going" });
		const mark = () =>
			t.mutation(internal.account.deletion.markAccountDeletionPending, {
				clerkUserId: owner.clerkUserId
			});

		await mark();
		vi.setSystemTime(NOW + 60_000);
		await mark();

		expect(
			(await users(t)).find((user) => user._id === owner.userId)
		).toMatchObject({ deletion_requested_at: NOW });
	});

	test("says nothing about a user who is not there", async () => {
		const t = testConvex();

		expect(
			await t.mutation(internal.account.deletion.markAccountDeletionPending, {
				clerkUserId: "user_missing"
			})
		).toBeNull();
	});
});
