import { describe, expect, test } from "vitest";
import { BOX_STATUSES, type BoxStatus } from "@/convex/model/box/status";
import {
	isSlugAvailable,
	SLUG_OCCUPYING_STATUSES,
	type SlugHolder
} from "@/convex/boxes/slugAvailability";

import {
	seedBox,
	seedUser,
	testConvex,
	type Harness
} from "../../../support/convex.ts";

describe("slug lifecycle", () => {
	// Pin the rule, not three examples of it. A slug that stops being reserved is
	// a slug someone else can claim while the box still answers on it, so a status
	// missing from this list fails towards the harmful answer - which is exactly
	// the case a spot-check of "deleting" and "delete_failed" would not notice.
	test("reserves a slug for every box state except deleted", () => {
		const expected = BOX_STATUSES.filter((status) => status !== "deleted");

		expect([...SLUG_OCCUPYING_STATUSES].sort()).toEqual(expected.sort());
		expect(SLUG_OCCUPYING_STATUSES).not.toContain("deleted");
	});
});

// A slug is taken by a live box, an active checkout reservation, or an
// operation that is on its way to using it - and every one of those has a
// caller who is allowed to be the holder. "Is it free" and "insist it is free"
// read the same answer, so a holder this cannot name is a caller refused their
// own slug (see `swapSlug`, which was exactly that).
describe("who is allowed to hold a slug already", () => {
	async function boxOn(
		t: Harness,
		slug: string,
		status: BoxStatus = "running"
	) {
		const owner = await seedUser(t, { clerkUserId: `user_${slug}_${status}` });
		return await seedBox(t, { user_id: owner.clerkUserId, slug, status });
	}

	function available(t: Harness, slug: string, ignore?: SlugHolder) {
		return t.run((ctx) => isSlugAvailable(ctx, slug, ignore));
	}

	test("offers a slug nothing holds", async () => {
		const t = testConvex();
		expect(await available(t, "free")).toBe(true);
	});

	test("refuses a slug that is not a valid slug at all", async () => {
		const t = testConvex();
		expect(await available(t, "Not A Slug")).toBe(false);
	});

	describe("a live box", () => {
		test("holds its slug against everyone else", async () => {
			const t = testConvex();
			await boxOn(t, "taken");
			expect(await available(t, "taken")).toBe(false);
		});

		test("does not hold it against itself", async () => {
			const t = testConvex();
			const boxId = await boxOn(t, "taken");
			expect(await available(t, "taken", { boxId })).toBe(true);
		});

		test("does not hold it against a different box", async () => {
			const t = testConvex();
			await boxOn(t, "taken");
			const other = await boxOn(t, "elsewhere");
			expect(await available(t, "taken", { boxId: other })).toBe(false);
		});
	});

	describe("an active checkout reservation", () => {
		async function intentOn(
			t: Harness,
			slug: string,
			status: "active" | "released" = "active"
		) {
			return await t.run(
				async (ctx) =>
					await ctx.db.insert("box_checkout_intents", {
						user_id: "user_buyer",
						slug,
						plan: "air",
						status,
						created_at: 1,
						updated_at: 1
					})
			);
		}

		test("holds the slug it reserved", async () => {
			const t = testConvex();
			await intentOn(t, "buying");
			expect(await available(t, "buying")).toBe(false);
		});

		test("does not hold it against the reservation being resumed", async () => {
			const t = testConvex();
			const intentId = await intentOn(t, "buying");
			expect(await available(t, "buying", { intentId })).toBe(true);
		});

		test("releases the slug once the reservation is no longer active", async () => {
			const t = testConvex();
			await intentOn(t, "buying", "released");
			expect(await available(t, "buying")).toBe(true);
		});
	});

	describe("an operation on its way to the slug", () => {
		async function operationOn(
			t: Harness,
			slug: string,
			status: "pending" | "running" | "succeeded"
		) {
			const boxId = await boxOn(t, `holder-${status}`);
			return await t.run(
				async (ctx) =>
					await ctx.db.insert("box_operations", {
						box_id: boxId,
						type: "change_slug",
						status,
						idempotency_key: `change-slug:${slug}:${status}`,
						reserved_slug: slug,
						trigger: "owner",
						created_at: 1,
						updated_at: 1
					})
			);
		}

		test.each(["pending", "running"] as const)(
			"holds the slug while the operation is %s",
			async (status) => {
				const t = testConvex();
				await operationOn(t, "moving", status);
				expect(await available(t, "moving")).toBe(false);
			}
		);

		test("releases the slug once the operation has finished", async () => {
			const t = testConvex();
			await operationOn(t, "moving", "succeeded");
			expect(await available(t, "moving")).toBe(true);
		});

		test("does not hold it against the operation performing the rename", async () => {
			const t = testConvex();
			const operationId = await operationOn(t, "moving", "running");
			expect(await available(t, "moving", { operationId })).toBe(true);
		});

		test("still holds it against a different operation", async () => {
			const t = testConvex();
			const mine = await operationOn(t, "moving", "running");
			await operationOn(t, "moving", "pending");
			expect(await available(t, "moving", { operationId: mine })).toBe(false);
		});
	});
});
