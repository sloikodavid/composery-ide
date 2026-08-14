import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { internal } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

import {
	boxOperations,
	seedSettings,
	seedUser,
	staffAlerts,
	stubDeploymentEnv,
	testConvex,
	type Harness
} from "../../../support/convex.ts";

// The one mutation that turns money into a box. It is reached only from
// `order.paid`, so by the time it runs a customer has been charged and every
// path out of it either provisions what they bought or gives the money back -
// there is no third option, and the plan it provisions has to be the one the
// order was actually paid against.
const NOW = Date.UTC(2026, 6, 28, 9, 0, 0);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	stubDeploymentEnv();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

async function seedIntent(
	t: Harness,
	userId: string,
	overrides: Partial<{
		plan: "air" | "pro";
		release_reason: string;
		status: "active" | "released" | "expired";
	}> = {}
) {
	return await t.run(
		async (ctx) =>
			await ctx.db.insert("box_checkout_intents", {
				user_id: userId,
				slug: "mine",
				plan: overrides.plan ?? "air",
				status: overrides.status ?? "active",
				release_reason: overrides.release_reason,
				created_at: NOW - 1000,
				updated_at: NOW - 1000
			})
	);
}

async function convert(
	t: Harness,
	intentId: Id<"box_checkout_intents">,
	plan: "air" | "pro"
) {
	return await t.mutation(
		internal.checkout.checkoutConversion.convertCheckoutIntentToBox,
		{
			intentId,
			plan,
			polarCustomerId: "cus_1",
			polarOrderId: "order_1",
			polarSubscriptionId: "sub_1",
			runtimeImage: "ghcr.io/example/composery@sha256:abc"
		}
	);
}

describe("converting a paid checkout into a box", () => {
	test("creates the box on the plan the order was paid against", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		// Reserved as Air, paid as Pro. The money decides, because the machine the
		// customer gets has to be the one they were charged for.
		const intentId = await seedIntent(t, owner.clerkUserId, { plan: "air" });

		const result = await convert(t, intentId, "pro");

		expect(result.unfulfilled).toBeNull();
		expect(result.boxId).not.toBeNull();
		const box = await t.run(async (ctx) => await ctx.db.get(result.boxId!));
		expect(box).toMatchObject({
			plan: "pro",
			slug: "mine",
			status: "creating",
			polar_subscription_id: "sub_1"
		});
	});

	test("starts provisioning and converts the intent", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		const intentId = await seedIntent(t, owner.clerkUserId);

		const result = await convert(t, intentId, "air");

		expect(await boxOperations(t, result.boxId!)).toMatchObject([
			{ type: "create", status: "pending", trigger: "owner" }
		]);
		const intent = await t.run(async (ctx) => await ctx.db.get(intentId));
		expect(intent).toMatchObject({
			status: "converted",
			box_id: result.boxId
		});
	});

	// A re-delivered webhook must not buy the customer a second box.
	test("returns the same box for a webhook delivered twice", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		const intentId = await seedIntent(t, owner.clerkUserId);

		const first = await convert(t, intentId, "air");
		const second = await convert(t, intentId, "air");

		expect(second.boxId).toEqual(first.boxId);
		expect(second.unfulfilled).toBeNull();
		expect(await boxOperations(t, first.boxId!)).toHaveLength(1);
	});

	// The slug is the product's identity, so a sale that cannot deliver it is
	// refunded rather than fulfilled under a name the customer did not choose.
	test("refunds rather than renaming when the slug was taken meanwhile", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		const other = await seedUser(t, {
			clerkUserId: "other",
			email: "other@example.com"
		});
		const intentId = await seedIntent(t, owner.clerkUserId);
		await t.run(async (ctx) => {
			await ctx.db.insert("boxes", {
				user_id: other.clerkUserId,
				slug: "mine",
				plan: "air",
				manual_snapshot_cap: 0,
				status: "running",
				created_at: NOW - 500,
				updated_at: NOW - 500
			});
		});

		const result = await convert(t, intentId, "air");

		expect(result.boxId).toBeNull();
		expect(result.unfulfilled).toMatchObject({
			orderId: "order_1",
			subscriptionId: "sub_1"
		});
	});

	// A terminal release must never be resurrected by a late webhook. Every
	// reason answers the same way, with the refund key naming the reason itself
	// so the row, the alert, and Polar's refund cannot be three different words
	// for one event.
	test.each(["slug_conflict", "capacity_unavailable", "account_deleted"])(
		"refunds a checkout already released for %s",
		async (release_reason) => {
			const t = testConvex();
			await seedSettings(t);
			const owner = await seedUser(t);
			const intentId = await seedIntent(t, owner.clerkUserId, {
				release_reason,
				status: "released"
			});

			const result = await convert(t, intentId, "air");

			expect(result.boxId).toBeNull();
			expect(result.unfulfilled).toMatchObject({
				idempotencyKey: `${release_reason}:${intentId}`,
				orderId: "order_1",
				subscriptionId: "sub_1"
			});
		}
	);

	// The one release that must not refund again: the money is already back, and
	// asking Polar for a second refund is the failure this row prevents.
	test("does not refund again for an order that was already refunded", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		const intentId = await seedIntent(t, owner.clerkUserId, {
			release_reason: "order_fully_refunded",
			status: "released"
		});

		const result = await convert(t, intentId, "air");

		expect(result).toEqual({ boxId: null, unfulfilled: null });
	});

	// A release reason that is not one of ours is not a terminal outcome - a
	// reservation superseded by the customer's next one still converts on
	// payment. Read with Object.hasOwn, so "constructor" is not a reason either.
	test.each(["superseded_by_new_reservation", "constructor", "toString"])(
		"still fulfils a checkout released as %s",
		async (release_reason) => {
			const t = testConvex();
			await seedSettings(t);
			const owner = await seedUser(t);
			const intentId = await seedIntent(t, owner.clerkUserId, {
				release_reason,
				status: "released"
			});

			const result = await convert(t, intentId, "air");

			expect(result.unfulfilled).toBeNull();
			expect(result.boxId).not.toBeNull();
		}
	);

	// A late payment that finds the fleet full is refused, and the reservation it
	// was holding stops counting - so the capacity alert has to be reconciled on
	// the way out, exactly as the slug-conflict refusal does.
	test("refuses and reports a late payment with no capacity left", async () => {
		const t = testConvex();
		await seedSettings(t, { hetzner_server_limit: 0 });
		const owner = await seedUser(t);
		const intentId = await seedIntent(t, owner.clerkUserId, {
			status: "expired"
		});

		const result = await convert(t, intentId, "air");

		expect(result.unfulfilled).toMatchObject({
			idempotencyKey: `capacity_unavailable:${intentId}`
		});
		expect(
			await t.run(async (ctx) => await ctx.db.get(intentId))
		).toMatchObject({
			release_reason: "capacity_unavailable",
			status: "released"
		});
		// Both alerts: the refused sale, and the capacity reconciliation this
		// refusal now runs on its way out - the reservation stopped holding a
		// server, so the fleet's standing had to be re-asked.
		expect((await staffAlerts(t)).map((alert) => alert.key).sort()).toEqual([
			`capacity-exhausted:server_limit:${NOW}`,
			`capacity_unavailable:${intentId}`
		]);
	});
});

// What a live reservation is worth at the moment the payment lands.
//
// An active intent already holds one server and its snapshot allowance - that
// is what reserving means, and it is why checkout blocks when the fleet is full.
// So a paid order against a live reservation converts whatever the fleet's
// standing is: the capacity was taken when the customer started, and re-asking
// for it here would refund somebody who queued correctly because somebody else
// filled the fleet while their card cleared.
//
// The mirror of that is already tested above: a reservation that lapsed has
// given the capacity back and must re-acquire it. Both sides are needed, because
// a check that ran in either case would look right in the other's test.
describe("a paid order against a reservation that is still live", () => {
	test("converts even when the fleet has no room left", async () => {
		const t = testConvex();
		await seedSettings(t, { hetzner_server_limit: 0 });
		const owner = await seedUser(t);
		const intentId = await seedIntent(t, owner.clerkUserId, {
			status: "active"
		});

		const result = await convert(t, intentId, "air");

		expect(result.unfulfilled).toBeNull();
		expect(result.boxId).toBeTruthy();
	});

	// Nothing is refused, so nothing is reported: an alert here would fire on
	// every sale made while the fleet is full, which is the ordinary state of a
	// deployment running near its ceiling.
	test("reports nothing to staff for it", async () => {
		const t = testConvex();
		await seedSettings(t, { hetzner_server_limit: 0 });
		const owner = await seedUser(t);
		const intentId = await seedIntent(t, owner.clerkUserId, {
			status: "active"
		});

		await convert(t, intentId, "air");

		expect(
			(await staffAlerts(t)).filter((alert) =>
				alert.key.startsWith("capacity_unavailable:")
			)
		).toEqual([]);
	});

	// A lapsed reservation converts too when there *is* room - the payment is
	// proof of sale, and losing the reservation is not by itself a reason to
	// refuse somebody who paid.
	test.each(["expired", "released"] as const)(
		"still converts a %s reservation when there is room",
		async (status) => {
			const t = testConvex();
			await seedSettings(t);
			const owner = await seedUser(t);
			const intentId = await seedIntent(t, owner.clerkUserId, { status });

			const result = await convert(t, intentId, "air");

			expect(result.unfulfilled).toBeNull();
			expect(
				await t.run(async (ctx) => await ctx.db.get(intentId))
			).toMatchObject({ box_id: result.boxId });
		}
	);

	// The box it creates is the one the sale is for, and the operation that
	// builds it is keyed to that box so a re-delivered webhook cannot start a
	// second provision.
	test("starts exactly one provision for the box it creates", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		const intentId = await seedIntent(t, owner.clerkUserId);

		const { boxId } = await convert(t, intentId, "air");
		await convert(t, intentId, "air");

		expect(await boxOperations(t, boxId!)).toMatchObject([
			{ type: "create", trigger: "owner" }
		]);
	});
});

// Two sales in a row.
//
// The provision is keyed on the box it creates, which is what stops a
// re-delivered webhook starting a second one. The same key seen from the other
// side has to vary: a key that had stopped naming the box would absorb the
// second sale's provision as a repeat of the first, and that customer's box
// would sit in "creating" with nothing building it - the worst shape of failure
// here, because the sale succeeded and the money was taken.
describe("each sale provisions its own box", () => {
	test("gives two conversions two boxes, each with its own provision", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		const first = await seedIntent(t, owner.clerkUserId);
		const second = await t.run(
			async (ctx) =>
				await ctx.db.insert("box_checkout_intents", {
					user_id: owner.clerkUserId,
					slug: "second",
					plan: "air",
					status: "active",
					created_at: NOW - 500,
					updated_at: NOW - 500
				})
		);

		const one = await convert(t, first, "air");
		const two = await convert(t, second, "air");

		expect(one.boxId).not.toBe(two.boxId);
		expect(await boxOperations(t, one.boxId!)).toHaveLength(1);
		expect(await boxOperations(t, two.boxId!)).toHaveLength(1);
	});
});

// Refusing to convert what it cannot convert.
//
// This mutation runs off a paid order, so every refusal here is a sale that has
// gone through with no box behind it. Each one throws rather than returning
// quietly, because the webhook handler above turns a throw into a Polar retry -
// and a quiet return would let Polar mark the delivery successful with nothing
// done.
describe("refusing to convert what it cannot convert", () => {
	test("refuses a reservation that is no longer there", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		const intentId = await seedIntent(t, owner.clerkUserId);
		await t.run(async (ctx) => await ctx.db.delete(intentId));

		await expect(convert(t, intentId, "air")).rejects.toThrow(
			"Checkout intent not found."
		);
	});

	// Records what built the box, so the box's own history names the sale it came
	// from rather than starting at "created".
	test("records the box's creation against the operation that runs it", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		const intentId = await seedIntent(t, owner.clerkUserId);

		const { boxId } = await convert(t, intentId, "air");

		const [operation] = await boxOperations(t, boxId!);
		const events = await t.run(
			async (ctx) =>
				await ctx.db
					.query("box_events")
					.withIndex("box_id_created_at", (query) => query.eq("box_id", boxId!))
					.collect()
		);
		expect(events).toMatchObject([
			{ type: "box.create_started", metadata: { operationId: operation._id } }
		]);
	});
});
