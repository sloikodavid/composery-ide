import { describe, expect, test } from "vitest";
import { ownerCanReadBox } from "@/convex/boxes/queries";
import { internal } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
	currentSuspensionReason,
	findBoxBySlug,
	findOwnedBoxBySlug,
	hasCurrentSuspension
} from "@/convex/boxes/queries";

import {
	seedBox,
	seedUser,
	testConvex,
	type Harness
} from "../../../support/convex.ts";

describe("hasCurrentSuspension", () => {
	test("shows a reason only while suspension is current", () => {
		expect(hasCurrentSuspension("suspending")).toBe(true);
		expect(hasCurrentSuspension("suspended")).toBe(true);
		expect(hasCurrentSuspension("unsuspending")).toBe(false);
		expect(hasCurrentSuspension("running")).toBe(false);
		expect(hasCurrentSuspension("deleted")).toBe(false);
	});
});

// Resolving a slug is the first step of every owner and staff read path, and a
// deleted box must never be what it resolves to: its slug is released, so the
// name can already belong to somebody else.
describe("resolving a box by slug", () => {
	test("finds a live box by its slug", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "mine"
		});

		expect(await t.run((ctx) => findBoxBySlug(ctx, "mine"))).toMatchObject({
			_id: boxId
		});
	});

	test("never resolves a deleted box, whose slug is free again", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "gone",
			status: "deleted"
		});

		expect(await t.run((ctx) => findBoxBySlug(ctx, "gone"))).toBeNull();
	});

	test("accepts the slug in whatever shape the caller had it", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		await seedBox(t, { user_id: owner.clerkUserId, slug: "mine" });

		expect(await t.run((ctx) => findBoxBySlug(ctx, "  MINE  "))).toMatchObject({
			slug: "mine"
		});
	});

	// "Is this your box" is answered here and nowhere else, so that every owner
	// entry point refuses somebody else's box the same way.
	test("hides another owner's box rather than reporting it", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const stranger = await seedUser(t, { clerkUserId: "user_stranger" });
		await seedBox(t, { user_id: owner.clerkUserId, slug: "mine" });

		expect(
			await t.run((ctx) =>
				findOwnedBoxBySlug(ctx, stranger.clerkUserId, "mine")
			)
		).toBeNull();
		expect(
			await t.run((ctx) => findOwnedBoxBySlug(ctx, owner.clerkUserId, "mine"))
		).toMatchObject({ slug: "mine" });
	});
});

// Billing webhooks arrive keyed by subscription, so this is how a Polar event
// finds its box - and a tombstone must not answer, or a cancellation would
// re-drive the deletion of a box that is already gone.
describe("resolving a box by subscription", () => {
	test("finds the live box a subscription pays for", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			polar_subscription_id: "sub_1"
		});

		expect(
			await t.query(internal.boxes.queries.boxIdBySubscription, {
				subscriptionId: "sub_1"
			})
		).toBe(boxId);
	});

	test("does not answer with a box that is already deleted", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		await seedBox(t, {
			user_id: owner.clerkUserId,
			polar_subscription_id: "sub_1",
			status: "deleted"
		});

		expect(
			await t.query(internal.boxes.queries.boxIdBySubscription, {
				subscriptionId: "sub_1"
			})
		).toBeNull();
	});

	test("answers with nothing for a subscription no box holds", async () => {
		const t = testConvex();

		expect(
			await t.query(internal.boxes.queries.boxIdBySubscription, {
				subscriptionId: "sub_unknown"
			})
		).toBeNull();
	});
});

// Box-level suspension keeps its reason on the operation, not the box row, so
// this is what both detail pages read to explain a suspension to its owner.
describe("the reason a box is currently suspended", () => {
	async function seedSuspend(
		t: Harness,
		boxId: Id<"boxes">,
		metadata: Record<string, unknown> | undefined,
		createdAt = 1
	) {
		await t.run(
			async (ctx) =>
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: "suspend",
					status: "succeeded",
					idempotency_key: `suspend:${createdAt}`,
					trigger: "system:abuse_suspension",
					metadata,
					created_at: createdAt,
					updated_at: createdAt
				})
		);
	}

	test("reports the reason the latest suspension recorded", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "suspended"
		});
		await seedSuspend(t, boxId, { reason: "an older reason" }, 1);
		await seedSuspend(t, boxId, { reason: "Sustained egress" }, 2);

		expect(
			await t.run(async (ctx) => {
				const box = await ctx.db.get(boxId);
				return await currentSuspensionReason(ctx, box!);
			})
		).toBe("Sustained egress");
	});

	// A box that is no longer suspended must not still explain why it once was.
	test("says nothing once the box is running again", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "running"
		});
		await seedSuspend(t, boxId, { reason: "Sustained egress" });

		expect(
			await t.run(async (ctx) => {
				const box = await ctx.db.get(boxId);
				return await currentSuspensionReason(ctx, box!);
			})
		).toBeNull();
	});

	test.each([
		["no metadata", undefined],
		["whitespace", { reason: "   " }],
		["a value that is not prose", { reason: { text: "nope" } }]
	])(
		"says nothing when the suspension recorded %s",
		async (_name, metadata) => {
			const t = testConvex();
			const owner = await seedUser(t);
			const boxId = await seedBox(t, {
				user_id: owner.clerkUserId,
				status: "suspended"
			});
			await seedSuspend(t, boxId, metadata);

			expect(
				await t.run(async (ctx) => {
					const box = await ctx.db.get(boxId);
					return await currentSuspensionReason(ctx, box!);
				})
			).toBeNull();
		}
	);

	test("says nothing when no suspension was ever recorded", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "suspended"
		});

		expect(
			await t.run(async (ctx) => {
				const box = await ctx.db.get(boxId);
				return await currentSuspensionReason(ctx, box!);
			})
		).toBeNull();
	});
});

// The internal queries the workflows and sweeps reach for. Each is a thin
// wrapper, which is exactly why nothing had run one: thin code still decides
// whether a workflow starts against the right box or throws.
describe("the internal box lookups", () => {
	test("resolves a slug for a caller that holds no session", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "mine"
		});

		expect(
			await t.query(internal.boxes.queries.boxBySlug, { slug: "mine" })
		).toMatchObject({ _id: boxId });
	});

	test("resolves an owner's slug and refuses a stranger's", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		await seedBox(t, { user_id: owner.clerkUserId, slug: "mine" });

		expect(
			await t.query(internal.boxes.queries.boxByOwnerSlug, {
				slug: "mine",
				userId: owner.clerkUserId
			})
		).toMatchObject({ slug: "mine" });
		expect(
			await t.query(internal.boxes.queries.boxByOwnerSlug, {
				slug: "mine",
				userId: "user_stranger"
			})
		).toBeNull();
	});

	// Every workflow opens with this, so it throws rather than returning null: a
	// workflow that carried on against a box that is not there would do its work
	// against nothing and report success.
	test("hands a workflow its box, and throws when there is none", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, { user_id: owner.clerkUserId });

		expect(
			await t.query(internal.boxes.queries.getBoxLifecycleSnapshot, { boxId })
		).toMatchObject({ _id: boxId });

		await t.run(async (ctx) => await ctx.db.delete(boxId));
		await expect(
			t.query(internal.boxes.queries.getBoxLifecycleSnapshot, { boxId })
		).rejects.toThrow("Box not found.");
	});

	// Paged by owner and status, because account suspension walks one person's
	// boxes rather than the fleet's.
	test("pages one owner's boxes in one status", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const stranger = await seedUser(t, { clerkUserId: "user_stranger" });
		const running = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "running-box"
		});
		await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "suspended-box",
			status: "suspended"
		});
		await seedBox(t, { user_id: stranger.clerkUserId, slug: "theirs" });

		const page = await t.query(internal.boxes.queries.boxesForUserStatusPage, {
			clerkUserId: owner.clerkUserId,
			cursor: null,
			status: "running"
		});

		expect(page.page.map((box) => box._id)).toEqual([running]);
	});
});

describe("ownerCanReadBox", () => {
	test("allows the owner to read a live box", () => {
		expect(
			ownerCanReadBox({ status: "running", user_id: "user-1" }, "user-1")
		).toBe(true);
	});

	test("hides deleted boxes even from their former owner", () => {
		expect(
			ownerCanReadBox({ status: "deleted", user_id: "user-1" }, "user-1")
		).toBe(false);
	});

	test("never exposes another user's box", () => {
		expect(
			ownerCanReadBox({ status: "running", user_id: "user-2" }, "user-1")
		).toBe(false);
	});
});
