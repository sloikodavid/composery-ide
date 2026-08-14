import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { BOX_PLANS } from "@/convex/model/box/plan";

import {
	boxOperations,
	readBox,
	seedBox,
	seedUser,
	stubDeploymentEnv,
	testConvex,
	type Caller,
	type Harness
} from "../../../support/convex.ts";

// The owner-facing surface. Nearly every test here is an access-control test
// asked as a behaviour question: what does the API return to someone who is not
// the owner? The answer has to be indistinguishable from "no such box", because
// anything else confirms the box exists to a caller who may only be guessing
// slugs.
//
// Time is frozen for the same reason as in operations.test.ts - these mutations
// start real workflows - and because the reissue budget is a window measured
// from now.
const NOW = Date.UTC(2026, 2, 3, 4, 5, 6);

// Any well-formed page request: the access-control tests never read it.
const PAGE = { cursor: null, numItems: 10 };
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	stubDeploymentEnv();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

async function twoOwners(t: Harness) {
	const mine = await seedUser(t, {
		clerkUserId: "owner",
		email: "owner@example.com"
	});
	const theirs = await seedUser(t, {
		clerkUserId: "stranger",
		email: "stranger@example.com"
	});
	return { mine, theirs };
}

describe("reading a box", () => {
	test("gives the owner their own box", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);
		const boxId = await seedBox(t, {
			user_id: mine.clerkUserId,
			slug: "mine"
		});

		const result = await mine.as.query(api.owner.boxes.getById, { boxId });

		expect(result?.box).toMatchObject({ id: boxId, slug: "mine" });
	});

	test("hides a box from everyone but its owner", async () => {
		const t = testConvex();
		const { mine, theirs } = await twoOwners(t);
		const boxId = await seedBox(t, { user_id: mine.clerkUserId });

		expect(
			await theirs.as.query(api.owner.boxes.getById, { boxId })
		).toBeNull();
	});

	test("hides a deleted box from its former owner", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);
		const boxId = await seedBox(t, {
			user_id: mine.clerkUserId,
			status: "deleted"
		});

		expect(await mine.as.query(api.owner.boxes.getById, { boxId })).toBeNull();
	});

	// A malformed id must read as "no box", not as an error that says the id was
	// the wrong shape.
	test("reports no box for an id that is not a box id", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);

		expect(
			await mine.as.query(api.owner.boxes.getById, { boxId: "not-an-id" })
		).toBeNull();
	});

	test("refuses an unauthenticated reader", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);
		const boxId = await seedBox(t, { user_id: mine.clerkUserId });

		await expect(t.query(api.owner.boxes.getById, { boxId })).rejects.toThrow(
			/Authentication required/
		);
	});

	// A suspended owner is told why rather than shown an empty account, so the
	// interface can explain itself.
	test("tells a suspended owner the reason instead of hiding their box", async () => {
		const t = testConvex();
		const suspended = await seedUser(t, {
			clerkUserId: "banned",
			suspended: true,
			suspendedReason: "abuse report"
		});
		const boxId = await seedBox(t, { user_id: suspended.clerkUserId });

		await expect(
			suspended.as.query(api.owner.boxes.getById, { boxId })
		).rejects.toMatchObject({
			data: {
				kind: "account_unavailable",
				title: "Your account is suspended",
				detail: "abuse report"
			}
		});
	});
});

describe("listing boxes", () => {
	test("lists only the caller's own boxes", async () => {
		const t = testConvex();
		const { mine, theirs } = await twoOwners(t);
		await seedBox(t, { user_id: mine.clerkUserId, slug: "mine" });
		await seedBox(t, { user_id: theirs.clerkUserId, slug: "theirs" });

		const page = await mine.as.query(api.owner.boxes.list, {
			paginationOpts: { cursor: null, numItems: 10 }
		});

		expect(page.page.map((box) => box.slug)).toEqual(["mine"]);
	});

	test("leaves deleted boxes out of the list", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);
		await seedBox(t, { user_id: mine.clerkUserId, slug: "live" });
		await seedBox(t, {
			user_id: mine.clerkUserId,
			slug: "gone",
			status: "deleted"
		});

		const page = await mine.as.query(api.owner.boxes.list, {
			paginationOpts: { cursor: null, numItems: 10 }
		});

		expect(page.page.map((box) => box.slug)).toEqual(["live"]);
	});

	// A signed-in identity with no user row yet is a real state - the row is
	// created by a mutation the app fires alongside its first queries.
	test("returns an empty page to an identity with no user row yet", async () => {
		const t = testConvex();

		const page = await t
			.withIdentity({ subject: "brand_new", email: "new@example.com" })
			.query(api.owner.boxes.list, {
				paginationOpts: { cursor: null, numItems: 10 }
			});

		expect(page).toMatchObject({ isDone: true, page: [] });
	});
});

describe("acting on a box", () => {
	test("stops a box the caller owns", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);
		const boxId = await seedBox(t, {
			user_id: mine.clerkUserId,
			slug: "mine",
			status: "running"
		});

		await mine.as.mutation(api.owner.boxes.stop, { slug: "mine" });

		expect(await readBox(t, boxId)).toMatchObject({ status: "stopping" });
	});

	test("refuses to act on a box the caller does not own", async () => {
		const t = testConvex();
		const { mine, theirs } = await twoOwners(t);
		const boxId = await seedBox(t, {
			user_id: mine.clerkUserId,
			slug: "mine",
			status: "running"
		});

		await expect(
			theirs.as.mutation(api.owner.boxes.stop, { slug: "mine" })
		).rejects.toThrow(/Box not found/);
		expect(await readBox(t, boxId)).toMatchObject({ status: "running" });
	});

	// Same message either way, so a stranger cannot learn which slugs exist by
	// comparing the errors.
	test("says the same thing about someone else's box as about no box at all", async () => {
		const t = testConvex();
		const { mine, theirs } = await twoOwners(t);
		await seedBox(t, {
			user_id: mine.clerkUserId,
			slug: "mine",
			status: "running"
		});

		const forOthers = await theirs.as
			.mutation(api.owner.boxes.stop, { slug: "mine" })
			.catch((error: unknown) => String((error as { data: string }).data));
		const forMissing = await theirs.as
			.mutation(api.owner.boxes.stop, { slug: "nothing-here" })
			.catch((error: unknown) => String((error as { data: string }).data));

		expect(forOthers).toBe(forMissing);
	});

	test("refuses a reset whose confirmation does not match the slug", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);
		const boxId = await seedBox(t, {
			user_id: mine.clerkUserId,
			slug: "mine",
			status: "running"
		});

		await expect(
			mine.as.mutation(api.owner.boxes.reset, {
				confirmation: "Mine",
				slug: "mine"
			})
		).rejects.toThrow(/Type the box slug/);
		expect(await boxOperations(t, boxId)).toEqual([]);
	});

	test("resets when the confirmation matches", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);
		const boxId = await seedBox(t, {
			user_id: mine.clerkUserId,
			slug: "mine",
			status: "running"
		});

		await mine.as.mutation(api.owner.boxes.reset, {
			confirmation: "mine",
			slug: "mine"
		});

		expect(await readBox(t, boxId)).toMatchObject({ status: "resetting" });
	});
});

// Every reissuing operation spends from CLOUD_DOMAIN's weekly Let's Encrypt
// budget, which is shared by the whole fleet, so one box cannot be allowed to
// burn it.
describe("the certificate reissue budget", () => {
	async function pastReissues(
		t: Harness,
		boxId: Id<"boxes">,
		entries: { at: number; type: "reset" | "change_slug" | "restore" }[]
	) {
		await t.run(async (ctx) => {
			for (const [index, entry] of entries.entries()) {
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: entry.type,
					status: "succeeded",
					idempotency_key: `past-${index}`,
					trigger: "owner",
					created_at: entry.at,
					updated_at: entry.at
				});
			}
		});
	}

	test("refuses a reset once the week's reissues are spent", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);
		const boxId = await seedBox(t, {
			user_id: mine.clerkUserId,
			slug: "mine",
			status: "running"
		});
		await pastReissues(
			t,
			boxId,
			Array.from({ length: 5 }, () => ({
				at: NOW - 1000,
				type: "reset" as const
			}))
		);

		await expect(
			mine.as.mutation(api.owner.boxes.reset, {
				confirmation: "mine",
				slug: "mine"
			})
		).rejects.toThrow(/too often this week/);
	});

	// The two operations share one budget, so five renames also exhaust resets.
	test("counts renames and resets against the same budget", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);
		const boxId = await seedBox(t, {
			user_id: mine.clerkUserId,
			slug: "mine",
			status: "running"
		});
		await pastReissues(t, boxId, [
			{ at: NOW - 1000, type: "change_slug" },
			{ at: NOW - 1000, type: "change_slug" },
			{ at: NOW - 1000, type: "change_slug" },
			{ at: NOW - 1000, type: "reset" },
			{ at: NOW - 1000, type: "reset" }
		]);

		await expect(
			mine.as.mutation(api.owner.boxes.reset, {
				confirmation: "mine",
				slug: "mine"
			})
		).rejects.toThrow(/too often this week/);
	});

	// A restored disk carries the certificate that was on it when the snapshot was
	// taken, so restoring one older than the renewal window makes the box ask for
	// a new certificate the moment it boots. That spends from the same weekly
	// budget as a rename or a reset, and it is now refused by it too.
	test("spends the same budget on restoring a snapshot", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);
		const boxId = await seedBox(t, {
			user_id: mine.clerkUserId,
			slug: "mine",
			status: "running"
		});
		const snapshotId = await t.run(
			async (ctx) =>
				await ctx.db.insert("box_snapshots", {
					box_id: boxId,
					class: "manual",
					status: "complete",
					hetzner_image_id: 4242,
					created_at: NOW - 1000
				})
		);
		await pastReissues(
			t,
			boxId,
			Array.from({ length: 5 }, () => ({
				at: NOW - 1000,
				type: "restore" as const
			}))
		);

		await expect(
			mine.as.mutation(api.owner.boxes.restoreSnapshot, { snapshotId })
		).rejects.toThrow(/too often this week/);
	});

	// The window has to roll, or a box that was reset five times a year ago could
	// never be reset again.
	test("ignores reissues older than the window", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);
		const boxId = await seedBox(t, {
			user_id: mine.clerkUserId,
			slug: "mine",
			status: "running"
		});
		await pastReissues(
			t,
			boxId,
			Array.from({ length: 5 }, () => ({
				at: NOW - WEEK_MS - 1,
				type: "reset" as const
			}))
		);

		await mine.as.mutation(api.owner.boxes.reset, {
			confirmation: "mine",
			slug: "mine"
		});

		expect(await readBox(t, boxId)).toMatchObject({ status: "resetting" });
	});

	test("still allows the fifth reissue of the week", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);
		const boxId = await seedBox(t, {
			user_id: mine.clerkUserId,
			slug: "mine",
			status: "running"
		});
		await pastReissues(
			t,
			boxId,
			Array.from({ length: 4 }, () => ({
				at: NOW - 1000,
				type: "reset" as const
			}))
		);

		await mine.as.mutation(api.owner.boxes.reset, {
			confirmation: "mine",
			slug: "mine"
		});

		expect(await readBox(t, boxId)).toMatchObject({ status: "resetting" });
	});
});

describe("changing a box's address", () => {
	test("reserves the new slug on the operation that will take it", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);
		const boxId = await seedBox(t, {
			user_id: mine.clerkUserId,
			slug: "old",
			status: "running"
		});

		const result = await mine.as.mutation(api.owner.boxes.changeSlug, {
			newSlug: "new",
			slug: "old"
		});

		expect(result).toEqual({ slug: "new" });
		expect(await boxOperations(t, boxId)).toMatchObject([
			{ type: "change_slug", reserved_slug: "new", status: "pending" }
		]);
	});

	test("normalises the requested slug before reserving it", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);
		const boxId = await seedBox(t, {
			user_id: mine.clerkUserId,
			slug: "old",
			status: "running"
		});

		const result = await mine.as.mutation(api.owner.boxes.changeSlug, {
			newSlug: "  New-Slug  ",
			slug: "old"
		});

		expect(result).toEqual({ slug: "new-slug" });
		expect(await boxOperations(t, boxId)).toMatchObject([
			{ reserved_slug: "new-slug" }
		]);
	});

	test("refuses a slug another box already holds", async () => {
		const t = testConvex();
		const { mine, theirs } = await twoOwners(t);
		await seedBox(t, { user_id: mine.clerkUserId, slug: "old" });
		await seedBox(t, { user_id: theirs.clerkUserId, slug: "taken" });

		await expect(
			mine.as.mutation(api.owner.boxes.changeSlug, {
				newSlug: "taken",
				slug: "old"
			})
		).rejects.toThrow(/unavailable/i);
	});

	test("refuses a slug that is not a legal address", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);
		await seedBox(t, { user_id: mine.clerkUserId, slug: "old" });

		await expect(
			mine.as.mutation(api.owner.boxes.changeSlug, {
				newSlug: "-",
				slug: "old"
			})
		).rejects.toThrow(/unavailable/i);
	});
});

describe("snapshots", () => {
	async function completeSnapshot(
		t: Harness,
		boxId: Id<"boxes">,
		userId: string,
		status: "complete" | "failed" = "complete"
	) {
		return await t.run(
			async (ctx) =>
				await ctx.db.insert("box_snapshots", {
					box_id: boxId,
					class: "manual",
					status,
					hetzner_image_id: 42,
					created_at: NOW - 10_000
				})
		);
	}

	test("shows the owner their box's snapshots", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);
		const boxId = await seedBox(t, { user_id: mine.clerkUserId, slug: "mine" });
		const snapshotId = await completeSnapshot(t, boxId, mine.clerkUserId);

		const rows = await mine.as.query(api.owner.boxes.snapshots, {
			slug: "mine"
		});

		expect(rows).toMatchObject([{ id: snapshotId, status: "complete" }]);
	});

	test("shows a stranger nothing for a box they do not own", async () => {
		const t = testConvex();
		const { mine, theirs } = await twoOwners(t);
		const boxId = await seedBox(t, { user_id: mine.clerkUserId, slug: "mine" });
		await completeSnapshot(t, boxId, mine.clerkUserId);

		expect(
			await theirs.as.query(api.owner.boxes.snapshots, { slug: "mine" })
		).toEqual([]);
	});

	test("refuses to restore a snapshot belonging to someone else's box", async () => {
		const t = testConvex();
		const { mine, theirs } = await twoOwners(t);
		const boxId = await seedBox(t, {
			user_id: mine.clerkUserId,
			slug: "mine",
			status: "running"
		});
		const snapshotId = await completeSnapshot(t, boxId, mine.clerkUserId);

		await expect(
			theirs.as.mutation(api.owner.boxes.restoreSnapshot, { snapshotId })
		).rejects.toThrow(/Snapshot not found/);
	});

	// The other half of the same refusal, and the reason both are worth having:
	// a snapshot that is gone and one that was never theirs must be
	// indistinguishable from outside, or the error text answers "does this id
	// exist" for anybody who asks. Without this, dropping the guard entirely
	// leaves the ownership check reading a null row and failing with whatever
	// TypeError comes out of it.
	test("refuses a snapshot that no longer exists, in the same words", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);
		const boxId = await seedBox(t, {
			user_id: mine.clerkUserId,
			slug: "mine",
			status: "running"
		});
		const snapshotId = await completeSnapshot(t, boxId, mine.clerkUserId);
		await t.run(async (ctx) => await ctx.db.delete(snapshotId));

		await expect(
			mine.as.mutation(api.owner.boxes.restoreSnapshot, { snapshotId })
		).rejects.toThrow("Snapshot not found.");
	});

	test("refuses to restore a snapshot that never finished", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);
		const boxId = await seedBox(t, {
			user_id: mine.clerkUserId,
			slug: "mine",
			status: "running"
		});
		const snapshotId = await completeSnapshot(
			t,
			boxId,
			mine.clerkUserId,
			"failed"
		);

		await expect(
			mine.as.mutation(api.owner.boxes.restoreSnapshot, { snapshotId })
		).rejects.toThrow(/finished snapshot/);
	});

	test("restores a finished snapshot for its owner", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);
		const boxId = await seedBox(t, {
			user_id: mine.clerkUserId,
			slug: "mine",
			status: "running"
		});
		const snapshotId = await completeSnapshot(t, boxId, mine.clerkUserId);

		await mine.as.mutation(api.owner.boxes.restoreSnapshot, { snapshotId });

		expect(await readBox(t, boxId)).toMatchObject({ status: "restoring" });
	});

	test("refuses to delete a snapshot belonging to someone else's box", async () => {
		const t = testConvex();
		const { mine, theirs } = await twoOwners(t);
		const boxId = await seedBox(t, { user_id: mine.clerkUserId, slug: "mine" });
		const snapshotId = await completeSnapshot(t, boxId, mine.clerkUserId);

		await expect(
			theirs.as.mutation(api.owner.boxes.deleteSnapshot, { snapshotId })
		).rejects.toThrow(/Snapshot not found/);
		expect(
			await t.run(async (ctx) => await ctx.db.get(snapshotId))
		).toMatchObject({ status: "complete" });
	});

	test("marks the owner's snapshot for deletion", async () => {
		const t = testConvex();
		const { mine } = await twoOwners(t);
		const boxId = await seedBox(t, { user_id: mine.clerkUserId, slug: "mine" });
		const snapshotId = await completeSnapshot(t, boxId, mine.clerkUserId);

		await mine.as.mutation(api.owner.boxes.deleteSnapshot, { snapshotId });

		expect(
			await t.run(async (ctx) => await ctx.db.get(snapshotId))
		).toMatchObject({ status: "deleting" });
	});
});

// Subscription management is Polar's portal, and a box on its way out has no
// subscription left to manage - sending its owner there would show them a
// portal for something that is being cancelled.
//
// Two layers refuse, and only one of them is reachable from here: the slug
// lookup already excludes a `deleted` box, so the block list's other entry is
// defence against a caller that resolves a box some other way. Both refusals are
// asserted, because "refused" and "refused for the right reason" are different
// facts and only one of them survives a change to either layer.
describe("opening the subscription portal", () => {
	async function ownedBox(t: Harness, status: Doc<"boxes">["status"]) {
		const owner = await seedUser(t);
		await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas",
			status,
			polar_subscription_id: "sub_1"
		});
		return owner;
	}

	test("refuses a box that is being torn down", async () => {
		const t = testConvex();
		const owner = await ownedBox(t, "deleting");

		await expect(
			owner.as.action(api.owner.boxes.customerPortalUrl, { slug: "atlas" })
		).rejects.toThrow("Subscription management is unavailable");
	});

	// A tombstone is not the owner's box any more - the slug is free, and it may
	// already belong to somebody else - so it is refused before the portal rule
	// is ever consulted.
	test("does not admit a deleted box even exists", async () => {
		const t = testConvex();
		const owner = await ownedBox(t, "deleted");

		await expect(
			owner.as.action(api.owner.boxes.customerPortalUrl, { slug: "atlas" })
		).rejects.toThrow("Box not found.");
	});
});

// Every owner-facing endpoint, reached by somebody who does not own the box.
//
// This is the boundary between two paying customers. Each endpoint resolves the
// box by (owner, slug) rather than by id alone, so the ownership check is not a
// separate guard that could be forgotten - it is the lookup. That makes it easy
// to get right and easy to regress in one line, and there is nothing behind it:
// past this point the handler stops, resets or renames the box.
//
// The refusal is deliberately "Box not found." rather than "not yours": a
// stranger must not be able to learn that a slug exists by the shape of the
// error.
//
// A table rather than eighteen tests, pinned by
// `tests/invariants/convex/owner-authorization.test.ts` so an endpoint added
// later cannot quietly miss it.
// What one row of the endpoint table may carry, beyond the arguments an
// endpoint takes. Every field is optional because most rows need none of them.
type EndpointFlags = {
	byId?: boolean;
	kind: "action" | "mutation" | "query";
	needsSnapshot?: boolean;
	noBox?: boolean;
	readsEmpty?: boolean;
	skipStranger?: boolean;
};

describe("an owner-facing endpoint reached by somebody else", () => {
	// Named as they are called, with the arguments each needs. `noBox` marks the
	// two that take no box at all.
	//
	// `flags` reads one entry as the full shape rather than as its own literal
	// type. Indexing the table directly gives the union of the entries, and only
	// some of them carry `readsEmpty` or `skipStranger` - so `ENDPOINTS[name].
	// readsEmpty` does not typecheck even though it is exactly the question being
	// asked. The table keeps its literal keys either way, which is what `names`
	// and the authorization invariant are built from.
	const ENDPOINTS = {
		changeSlug: { kind: "mutation", newSlug: "renamed" },
		createSnapshot: { kind: "mutation" },
		customerPortalUrl: { kind: "action" },
		deleteSnapshot: { kind: "mutation", noBox: true, needsSnapshot: true },
		getById: { kind: "query", noBox: true, byId: true, readsEmpty: true },
		list: {
			kind: "query",
			noBox: true,
			paginationOpts: PAGE,
			skipStranger: true
		},
		metricsSeries: { kind: "query", readsEmpty: true },
		recoveryStatus: { kind: "action" },
		repair: { kind: "action" },
		reset: { kind: "mutation", confirmation: "atlas" },
		restoreSnapshot: { kind: "mutation", noBox: true, needsSnapshot: true },
		revokeSshDevice: { kind: "action", serial: 1 },
		retryCreate: { kind: "mutation" },
		runtimeLogs: { kind: "action" },
		setCustomDomain: { kind: "action", domain: null },
		setSnapshotSplit: { kind: "mutation", manualCap: 1 },
		snapshots: { kind: "query", readsEmpty: true },
		sshDevices: { kind: "action" },
		sshSetup: { kind: "action", name: "my laptop" },
		start: { kind: "mutation" },
		stop: { kind: "mutation" },
		update: { kind: "action" }
	} as const;

	type Owned = {
		boxId: Id<"boxes">;
		owner: Awaited<ReturnType<typeof seedUser>>;
		snapshotId: Id<"box_snapshots">;
	};

	async function owned(t: Harness): Promise<Owned> {
		const owner = await seedUser(t, { clerkUserId: "owner" });
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas",
			plan: "pro",
			manual_snapshot_cap: BOX_PLANS.pro.snapshotManualDefault,
			status: "running"
		});
		const snapshotId = await t.run(
			async (ctx) =>
				await ctx.db.insert("box_snapshots", {
					box_id: boxId,
					class: "manual",
					status: "complete",
					created_at: NOW - 1000
				})
		);
		return { boxId, owner, snapshotId };
	}

	// Convex validates arguments before the handler runs, so the ids here are
	// real ones - a malformed argument would be refused by the validator and the
	// ownership lookup, the thing under test, would never be reached.
	function call(
		as: Caller,
		name: keyof typeof ENDPOINTS,
		box: Owned
	): Promise<unknown> {
		const {
			byId,
			kind,
			needsSnapshot,
			noBox,
			readsEmpty,
			skipStranger,
			...rest
		} = ENDPOINTS[name] as {
			byId?: boolean;
			kind: "action" | "mutation" | "query";
			needsSnapshot?: boolean;
			noBox?: boolean;
			readsEmpty?: boolean;
			skipStranger?: boolean;
		} & Record<string, unknown>;
		const args = {
			...(noBox ? {} : { slug: "atlas" }),
			...(byId ? { boxId: String(box.boxId) } : {}),
			...(needsSnapshot ? { snapshotId: box.snapshotId } : {}),
			...rest
		};
		const reference = api.owner.boxes[name];
		// One dynamic dispatch over a table of endpoints, which no signature can
		// follow: the reference and its arguments are chosen at run time. Cast once,
		// at the call, rather than giving each argument the `never` type and
		// leaving the checker a tuple it then refuses.
		const call = as[kind] as (
			reference: unknown,
			args: unknown
		) => Promise<unknown>;
		return call(reference, args);
	}

	const names = Object.keys(ENDPOINTS) as (keyof typeof ENDPOINTS)[];

	test.each(names)("%s refuses a signed-out caller", async (name) => {
		const t = testConvex();
		const box = await owned(t);

		await expect(call(t, name, box)).rejects.toThrow(
			/Authentication required\.|Not signed in/
		);
	});

	// The one that matters most: another paying customer, signed in, who knows
	// the slug.
	//
	// The two halves answer differently on purpose. Anything that would change
	// the box refuses, and says only "not found" - never "not yours", which would
	// confirm the slug to somebody guessing. The reads answer with nothing at
	// all, which tells a guesser even less.
	const flags = (name: keyof typeof ENDPOINTS): EndpointFlags =>
		ENDPOINTS[name];
	const strangers = names.filter((name) => !flags(name).skipStranger);

	test.each(strangers.filter((name) => !flags(name).readsEmpty))(
		"%s refuses another customer's box without confirming it exists",
		async (name) => {
			const t = testConvex();
			const box = await owned(t);
			const stranger = await seedUser(t, {
				clerkUserId: "stranger",
				email: "stranger@example.com"
			});

			await expect(call(stranger.as, name, box)).rejects.toThrow(
				/Box not found\.|Snapshot not found\./
			);
		}
	);

	test.each(strangers.filter((name) => flags(name).readsEmpty))(
		"%s shows another customer's box as nothing at all",
		async (name) => {
			const t = testConvex();
			const box = await owned(t);
			const stranger = await seedUser(t, {
				clerkUserId: "stranger",
				email: "stranger@example.com"
			});

			const answer = await call(stranger.as, name, box);

			expect(Array.isArray(answer) ? answer : [answer].filter(Boolean)).toEqual(
				[]
			);
		}
	);

	// Nothing the stranger did may have started an operation on somebody else's
	// box - a refusal that still queued the work would be the worst outcome.
	test("leaves the box untouched after a stranger has tried everything", async () => {
		const t = testConvex();
		const box = await owned(t);
		const stranger = await seedUser(t, {
			clerkUserId: "stranger",
			email: "stranger@example.com"
		});

		for (const name of names) {
			await call(stranger.as, name, box).catch(() => undefined);
		}

		expect(await boxOperations(t, box.boxId)).toEqual([]);
		expect(await readBox(t, box.boxId)).toMatchObject({
			slug: "atlas",
			status: "running"
		});
	});

	// `list` is the one endpoint that takes no box, so its isolation is what it
	// returns rather than what it refuses.
	test("lists only the caller's own boxes", async () => {
		const t = testConvex();
		await owned(t);
		const stranger = await seedUser(t, {
			clerkUserId: "stranger",
			email: "stranger@example.com"
		});

		const page = (await stranger.as.query(api.owner.boxes.list, {
			paginationOpts: PAGE
		})) as { page: unknown[] };

		expect(page.page).toEqual([]);
	});
});

// What an owner's own buttons do.
//
// The table above proves nobody else reaches these; these are what happens when
// the owner does. The property running through all of them is that "started" is
// true: every one opens an operation the interface then reports on, and telling
// somebody their box is being repaired when nothing was queued is the failure
// mode that leaves them waiting on a box nobody is fixing.
describe("what an owner's own buttons do", () => {
	async function myBox(t: Harness, over: Partial<Doc<"boxes">> = {}) {
		const owner = await seedUser(t, { clerkUserId: "owner" });
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "mine",
			plan: "pro",
			manual_snapshot_cap: BOX_PLANS.pro.snapshotManualDefault,
			status: "running",
			...over
		});
		return { boxId, owner };
	}

	describe("repairing", () => {
		test("opens a repair the owner asked for", async () => {
			const t = testConvex();
			const { boxId, owner } = await myBox(t);

			await owner.as.action(api.owner.boxes.repair, { slug: "mine" });

			expect(await boxOperations(t, boxId)).toMatchObject([
				{ type: "repair", trigger: "owner" }
			]);
		});

		// Two presses are one repair, and the second is told so rather than being
		// reported as a fresh start.
		test("tells the owner when a repair is already running", async () => {
			const t = testConvex();
			const { boxId, owner } = await myBox(t);
			await owner.as.action(api.owner.boxes.repair, { slug: "mine" });

			await expect(
				owner.as.action(api.owner.boxes.repair, { slug: "mine" })
			).rejects.toThrow(/already in flight|busy/);
			expect(await boxOperations(t, boxId)).toHaveLength(1);
		});

		// The name is sanitised before the lookup, so the box is found whatever
		// case or padding the interface sent.
		test.each(["MINE", "  mine  "])(
			"finds the box asked for as %p",
			async (slug) => {
				const t = testConvex();
				const { boxId, owner } = await myBox(t);

				await owner.as.action(api.owner.boxes.repair, { slug });

				expect(await boxOperations(t, boxId)).toHaveLength(1);
			}
		);
	});

	describe("updating", () => {
		test("opens an update the owner asked for", async () => {
			const t = testConvex();
			const { boxId, owner } = await myBox(t);

			await owner.as.action(api.owner.boxes.update, { slug: "mine" });

			expect(await boxOperations(t, boxId)).toMatchObject([
				{ type: "update", trigger: "owner" }
			]);
		});

		// Keyed per box rather than per target image: two presses must not queue a
		// second container recreate behind the first.
		test("tells the owner when an update is already running", async () => {
			const t = testConvex();
			const { boxId, owner } = await myBox(t);
			await owner.as.action(api.owner.boxes.update, { slug: "mine" });

			await expect(
				owner.as.action(api.owner.boxes.update, { slug: "mine" })
			).rejects.toThrow(/already in flight|busy/);
			expect(await boxOperations(t, boxId)).toHaveLength(1);
		});
	});

	describe("retrying a create that failed", () => {
		test("opens a create the owner asked for", async () => {
			const t = testConvex();
			const { boxId, owner } = await myBox(t, { status: "create_failed" });

			await owner.as.mutation(api.owner.boxes.retryCreate, { slug: "mine" });

			expect(await boxOperations(t, boxId)).toMatchObject([
				{ type: "create", trigger: "owner" }
			]);
		});

		// One box, one create. A second press must not build a second machine the
		// customer would be billed for.
		test("does not open a second create for the same box", async () => {
			const t = testConvex();
			const { boxId, owner } = await myBox(t, { status: "create_failed" });

			await owner.as.mutation(api.owner.boxes.retryCreate, { slug: "mine" });
			await owner.as
				.mutation(api.owner.boxes.retryCreate, { slug: "mine" })
				.catch(() => undefined);

			expect(await boxOperations(t, boxId)).toHaveLength(1);
		});
	});

	describe("renaming", () => {
		test("opens a rename holding the new name and remembering the old", async () => {
			const t = testConvex();
			const { boxId, owner } = await myBox(t);

			expect(
				await owner.as.mutation(api.owner.boxes.changeSlug, {
					newSlug: "renamed",
					slug: "mine"
				})
			).toEqual({ slug: "renamed" });
			expect(await boxOperations(t, boxId)).toMatchObject([
				{
					type: "change_slug",
					trigger: "owner",
					reserved_slug: "renamed",
					metadata: { oldSlug: "mine", newSlug: "renamed" }
				}
			]);
		});

		// What the owner typed is normalised before it is judged and before it is
		// held, so the name they get is the name the rest of the system sees.
		test("normalises the name it reserves", async () => {
			const t = testConvex();
			const { boxId, owner } = await myBox(t);

			expect(
				await owner.as.mutation(api.owner.boxes.changeSlug, {
					newSlug: "  Renamed  ",
					slug: "mine"
				})
			).toEqual({ slug: "renamed" });
			expect(await boxOperations(t, boxId)).toMatchObject([
				{ reserved_slug: "renamed" }
			]);
		});

		test.each(["", "  ", "!!", "-nope-"])(
			"refuses %p as a new name",
			async (newSlug) => {
				const t = testConvex();
				const { boxId, owner } = await myBox(t);

				await expect(
					owner.as.mutation(api.owner.boxes.changeSlug, {
						newSlug,
						slug: "mine"
					})
				).rejects.toThrow("Slug is unavailable.");
				expect(await boxOperations(t, boxId)).toEqual([]);
			}
		);

		// The name is checked before the box is even looked up, so a stranger
		// cannot use a malformed name to learn whether a slug exists.
		test("judges the new name before it finds the box", async () => {
			const t = testConvex();
			await myBox(t);
			const stranger = await seedUser(t, {
				clerkUserId: "stranger",
				email: "stranger@example.com"
			});

			await expect(
				stranger.as.mutation(api.owner.boxes.changeSlug, {
					newSlug: "!!",
					slug: "mine"
				})
			).rejects.toThrow("Slug is unavailable.");
		});

		test("refuses a name another box already holds", async () => {
			const t = testConvex();
			const { owner } = await myBox(t);
			await seedBox(t, { user_id: owner.clerkUserId, slug: "taken" });

			await expect(
				owner.as.mutation(api.owner.boxes.changeSlug, {
					newSlug: "taken",
					slug: "mine"
				})
			).rejects.toThrow();
		});
	});

	describe("reading a box's metrics", () => {
		test("gives the owner their own box's samples", async () => {
			const t = testConvex();
			const { boxId, owner } = await myBox(t);
			await t.run(async (ctx) => {
				await ctx.db.insert("box_metrics", {
					box_id: boxId,
					sampled_at: NOW - 60_000,
					cpu_percent: 42,
					ingress_bps: 1,
					egress_bps: 1,
					ingress_pps: 1,
					egress_pps: 1,
					disk_read_bps: 1,
					disk_write_bps: 1
				});
			});

			const samples = await owner.as.query(api.owner.boxes.metricsSeries, {
				slug: "mine"
			});

			expect(samples).toMatchObject([
				{ slug: "mine", samples: [{ cpuPercent: 42 }] }
			]);
		});

		test("gives an empty series for a box with no samples yet", async () => {
			const t = testConvex();
			const { owner } = await myBox(t);

			expect(
				await owner.as.query(api.owner.boxes.metricsSeries, { slug: "mine" })
			).toEqual([{ slug: "mine", samples: [] }]);
		});
	});
});

// Pressing a button twice.
//
// Every one of these endpoints keys its operation on the box and the kind of
// work, and that key is consulted before anything else: a matching key means
// "the same request", so the second press is absorbed rather than queued behind
// the first. It is one interpolated string per endpoint - the kind of line
// copied into a new endpoint and left naming the wrong box - so each is pressed
// twice on one box, and once on each of two.
//
// The key is not the only thing holding this line, and the tests must not read
// as though it were. A request that is genuinely different, arriving while the
// box is busy, is refused by a second guard behind the key. Both are wanted: the
// key alone cannot keep two unlike operations off one machine.
//
// The answer to a repeat differs per endpoint on purpose. Where the button stays
// on the page a repeat is silent; where the page has already said the work
// began, a repeat says so, because a second "started" over a request that
// started nothing is a lie the owner would act on.
describe("pressing a button twice", () => {
	async function box(t: Harness, over: Record<string, unknown> = {}) {
		const owner = await seedUser(t, { clerkUserId: "owner" });
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas",
			plan: "pro",
			manual_snapshot_cap: BOX_PLANS.pro.snapshotManualDefault,
			status: "running",
			...over
		});
		return { boxId, owner };
	}

	// Endpoint -> the status its operation is allowed to start from, and what
	// the owner is told for a repeat (null where the repeat is silent).
	const REPEATS = {
		createSnapshot: { kind: "mutation", from: "running", repeat: /already/ },
		repair: { kind: "action", from: "running", repeat: /already in flight/ },
		reset: { kind: "mutation", from: "running", repeat: null },
		retryCreate: { kind: "mutation", from: "create_failed", repeat: null },
		start: { kind: "mutation", from: "stopped", repeat: null },
		stop: { kind: "mutation", from: "running", repeat: null },
		update: { kind: "action", from: "running", repeat: /already in flight/ }
	} as const;

	// Reset asks for the slug typed back as confirmation; nothing else takes an
	// argument beyond the slug.
	const press = (
		owner: Awaited<ReturnType<typeof seedUser>>,
		name: keyof typeof REPEATS,
		slug = "atlas"
	) => {
		const reference = api.owner.boxes[name];
		const payload = {
			slug,
			...(name === "reset" ? { confirmation: slug } : {})
		};
		// The same dynamic dispatch as the endpoint table above, cast once.
		const call = owner.as[REPEATS[name].kind] as (
			reference: unknown,
			payload: unknown
		) => Promise<unknown>;
		return call(reference, payload);
	};

	const names = Object.keys(REPEATS) as (keyof typeof REPEATS)[];

	test.each(names)("%s starts one operation for one press", async (name) => {
		const t = testConvex();
		const { boxId, owner } = await box(t, { status: REPEATS[name].from });

		await press(owner, name);

		expect(await boxOperations(t, boxId)).toHaveLength(1);
	});

	test.each(names)(
		"%s starts nothing more for a second press",
		async (name) => {
			const t = testConvex();
			const { boxId, owner } = await box(t, { status: REPEATS[name].from });

			await press(owner, name);
			const { repeat } = REPEATS[name];
			const second = press(owner, name);
			if (repeat) await expect(second).rejects.toThrow(repeat);
			else await second;

			expect(await boxOperations(t, boxId)).toHaveLength(1);
		}
	);

	// The key names the box, so one box's press is never mistaken for another
	// box's. Two boxes pressed in turn are two pieces of work - a key that had
	// stopped varying with the box would absorb the second and leave one of them
	// waiting on work nobody started.
	test.each(names)("%s keys its work per box", async (name) => {
		const t = testConvex();
		const { boxId, owner } = await box(t, { status: REPEATS[name].from });
		const otherId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "beta",
			plan: "pro",
			manual_snapshot_cap: BOX_PLANS.pro.snapshotManualDefault,
			status: REPEATS[name].from
		});

		await press(owner, name);
		await press(owner, name, "beta");

		expect(await boxOperations(t, boxId)).toHaveLength(1);
		expect(await boxOperations(t, otherId)).toHaveLength(1);
	});

	// Renaming keys on the destination as well as the box, because asking for a
	// second, different name is a different request - not the same one repeated.
	describe("renaming, which keys on the new name too", () => {
		test("absorbs the same rename asked for twice", async () => {
			const t = testConvex();
			const { boxId, owner } = await box(t);

			await owner.as.mutation(api.owner.boxes.changeSlug, {
				slug: "atlas",
				newSlug: "renamed"
			});
			await owner.as.mutation(api.owner.boxes.changeSlug, {
				slug: "atlas",
				newSlug: "renamed"
			});

			expect(await boxOperations(t, boxId)).toHaveLength(1);
		});

		// A different target is a different request, so the key does not absorb it
		// - and the guard behind the key refuses it rather than queueing a second
		// rename behind the first.
		test("refuses a different new name while the first is running", async () => {
			const t = testConvex();
			const { boxId, owner } = await box(t);

			await owner.as.mutation(api.owner.boxes.changeSlug, {
				slug: "atlas",
				newSlug: "first"
			});

			await expect(
				owner.as.mutation(api.owner.boxes.changeSlug, {
					slug: "atlas",
					newSlug: "second"
				})
			).rejects.toThrow("This box is busy with another operation.");
			expect(await boxOperations(t, boxId)).toHaveLength(1);
		});
	});

	// Restoring keys on the snapshot for the same reason: restoring yesterday's
	// snapshot and last week's are two different pieces of work.
	describe("restoring, which keys on the snapshot too", () => {
		async function snapshot(t: Harness, boxId: Id<"boxes">, createdAt: number) {
			return await t.run(
				async (ctx) =>
					await ctx.db.insert("box_snapshots", {
						box_id: boxId,
						class: "manual",
						status: "complete",
						created_at: createdAt
					})
			);
		}

		test("refuses the same restore asked for twice", async () => {
			const t = testConvex();
			const { boxId, owner } = await box(t);
			const snapshotId = await snapshot(t, boxId, NOW - 1000);

			await owner.as.mutation(api.owner.boxes.restoreSnapshot, { snapshotId });

			await expect(
				owner.as.mutation(api.owner.boxes.restoreSnapshot, { snapshotId })
			).rejects.toThrow(/already in flight/);
			expect(await boxOperations(t, boxId)).toHaveLength(1);
		});

		// Only a finished snapshot has anything to restore from; one still being
		// taken would restore a half-written disk.
		test.each(["pending", "failed"] as const)(
			"refuses to restore a %s snapshot",
			async (status) => {
				const t = testConvex();
				const { boxId, owner } = await box(t);
				const snapshotId = await t.run(
					async (ctx) =>
						await ctx.db.insert("box_snapshots", {
							box_id: boxId,
							class: "manual",
							status,
							created_at: NOW - 1000
						})
				);

				await expect(
					owner.as.mutation(api.owner.boxes.restoreSnapshot, { snapshotId })
				).rejects.toThrow("Only a finished snapshot can be restored.");
				expect(await boxOperations(t, boxId)).toEqual([]);
			}
		);
	});
});

// Reading a box's logs, which is the one owner call that reaches the machine.
describe("reading a box's logs", () => {
	async function box(t: Harness, status: Doc<"boxes">["status"]) {
		const owner = await seedUser(t, { clerkUserId: "owner" });
		await seedBox(t, { user_id: owner.clerkUserId, slug: "atlas", status });
		return owner;
	}

	// A box that is not running has no container to read from, and saying so
	// beats an SSH attempt against a host that is off.
	test.each([
		"stopped",
		"suspended",
		"creating",
		"create_failed",
		"repairing"
	] as const)("answers with no logs for a %s box", async (status) => {
		const t = testConvex();
		const owner = await box(t, status);

		expect(
			await owner.as.action(api.owner.boxes.runtimeLogs, { slug: "atlas" })
		).toEqual({ logs: null });
	});

	test("refuses a slug the owner does not have", async () => {
		const t = testConvex();
		const owner = await box(t, "running");

		await expect(
			owner.as.action(api.owner.boxes.runtimeLogs, { slug: "nothing-here" })
		).rejects.toThrow("Box not found.");
	});
});
