import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "@/convex/_generated/api";
import {
	checkoutResumption,
	paidOrderRecordingStatus,
	reservationsToRelease
} from "@/convex/checkout/checkoutIntents";
import type { Id } from "@/convex/_generated/dataModel";

import {
	seedBox,
	seedSettings,
	seedUser,
	stubDeploymentEnv,
	testConvex,
	type Harness
} from "../../../support/convex";

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

const paidOrder = {
	checkoutId: "checkout-new",
	orderId: "order-new",
	subscriptionId: "subscription-new"
};

// Whether a reservation's stored Polar session can be sent back to.
//
// Polar decides every answer and none is negotiable: a session's product list is
// fixed at creation, a session cannot be voided, and one past its expiry or
// already paid cannot be updated. Asked directly, because "reuse it" and "make a
// new one" send the customer to different places and the wrong answer either
// strands a live checkout or charges them twice.
describe("checkoutResumption", () => {
	const live = {
		polar_checkout_expires_at: NOW + 1000,
		polar_checkout_id: "checkout_1",
		polar_checkout_url: "https://polar.test/checkout_1",
		polar_initial_order_id: undefined
	};

	test("reuses a session that is open and unpaid", () => {
		expect(checkoutResumption(live, NOW)).toEqual({
			checkoutId: "checkout_1",
			checkoutUrl: "https://polar.test/checkout_1",
			type: "session"
		});
	});

	// A reservation the action died on before attaching a session, and a row that
	// somehow kept only half of one. Both need a session rather than a repair.
	test.each([
		[
			"neither",
			{ polar_checkout_id: undefined, polar_checkout_url: undefined }
		],
		["no id", { polar_checkout_id: undefined }],
		["no url", { polar_checkout_url: undefined }]
	])("asks for a new session with %s", (_case, missing) => {
		expect(checkoutResumption({ ...live, ...missing }, NOW)).toEqual({
			type: "none"
		});
	});

	// The instant of expiry counts as expired, matching the sweep's own `lte`.
	test.each([NOW - 1, NOW])(
		"asks for a new session once the old one expired at %i",
		(expiresAt) => {
			expect(
				checkoutResumption(
					{ ...live, polar_checkout_expires_at: expiresAt },
					NOW
				)
			).toEqual({ type: "none" });
		}
	);

	// A row that never recorded an expiry holds nothing resumable either.
	test("asks for a new session when no expiry was recorded", () => {
		expect(
			checkoutResumption({ ...live, polar_checkout_expires_at: undefined }, NOW)
		).toEqual({ type: "none" });
	});

	// Paid outranks every other answer, including an expired session: the money is
	// already taken, so the one thing that must not happen is a second checkout.
	test.each([NOW + 1000, NOW - 1])(
		"reports a paid reservation expiring at %i as paid",
		(expiresAt) => {
			expect(
				checkoutResumption(
					{
						...live,
						polar_checkout_expires_at: expiresAt,
						polar_initial_order_id: "order_1"
					},
					NOW
				)
			).toEqual({ type: "paid" });
		}
	);
});

describe("reservationsToRelease", () => {
	test("enforces a lowered cap against every live reservation before adding its replacement", async () => {
		const t = testConvex();
		await seedSettings(t, { max_active_checkout_intents_per_user: 1 });
		await t.run(async (ctx) => {
			for (let index = 0; index < 50; index++) {
				await ctx.db.insert("box_checkout_intents", {
					created_at: index,
					plan: "air",
					slug: `old-${index}`,
					status: "active",
					updated_at: index,
					user_id: "owner"
				});
			}
		});

		await t.mutation(internal.checkout.checkoutIntents.reserveCheckoutIntent, {
			plan: "air",
			slug: "replacement",
			userId: "owner"
		});

		const intents = await t.run(
			async (ctx) =>
				await ctx.db
					.query("box_checkout_intents")
					.withIndex("user_id_created_at", (query) =>
						query.eq("user_id", "owner")
					)
					.collect()
		);
		expect(
			intents
				.filter((intent) => intent.status === "released")
				.sort((left, right) => left.created_at - right.created_at)
				.map((intent) => [intent.slug, intent.release_reason])
		).toEqual(
			Array.from({ length: 50 }, (_, index) => [
				`old-${index}`,
				"superseded_by_new_reservation"
			])
		);
		expect(
			intents
				.filter((intent) => intent.status === "active")
				.map((intent) => intent.slug)
		).toEqual(["replacement"]);

		const lowered = testConvex();
		await seedSettings(lowered, {
			max_active_checkout_intents_per_user: 3
		});
		await lowered.run(async (ctx) => {
			for (let index = 0; index < 5; index++) {
				await ctx.db.insert("box_checkout_intents", {
					created_at: index,
					plan: "air",
					slug: `lowered-${index}`,
					status: "active",
					updated_at: index,
					user_id: "owner"
				});
			}
		});
		await lowered.mutation(
			internal.checkout.checkoutIntents.reserveCheckoutIntent,
			{
				plan: "air",
				slug: "lowered-replacement",
				userId: "owner"
			}
		);
		const loweredIntents = await lowered.run(
			async (ctx) =>
				await ctx.db
					.query("box_checkout_intents")
					.withIndex("user_id_created_at", (query) =>
						query.eq("user_id", "owner")
					)
					.collect()
		);
		expect(
			loweredIntents
				.filter((intent) => intent.status === "active")
				.map((intent) => intent.slug)
				.sort()
		).toEqual(["lowered-3", "lowered-4", "lowered-replacement"]);
	});

	test("keeps every reservation while there is room under the cap", () => {
		expect(reservationsToRelease(0, 3)).toBe(0);
		expect(reservationsToRelease(2, 3)).toBe(0);
	});

	test("releases the oldest reservation at the cap", () => {
		expect(reservationsToRelease(3, 3)).toBe(1);
	});

	test("works off a cap lowered below the live count", () => {
		expect(reservationsToRelease(5, 3)).toBe(3);
		expect(reservationsToRelease(50, 1)).toBe(50);
	});

	test("rejects corrupt settings and unbounded stored state", () => {
		expect(() => reservationsToRelease(-1, 3)).toThrow(/out of bounds/);
		expect(() => reservationsToRelease(1.5, 3)).toThrow(/out of bounds/);
		expect(() => reservationsToRelease(51, 3)).toThrow(/out of bounds/);
		expect(() => reservationsToRelease(3, 0)).toThrow(/out of bounds/);
		expect(() => reservationsToRelease(3, 1.5)).toThrow(/out of bounds/);
		expect(() => reservationsToRelease(3, 51)).toThrow(/out of bounds/);
		expect(reservationsToRelease(0, 50)).toBe(0);
	});
});

describe("paidOrderRecordingStatus", () => {
	test("reports a missing checkout intent", () => {
		expect(paidOrderRecordingStatus(null, paidOrder)).toBe("missing");
	});

	test("accepts a matching unfulfilled checkout", () => {
		expect(
			paidOrderRecordingStatus(
				{
					box_id: undefined,
					polar_checkout_id: "checkout-new",
					polar_initial_order_id: undefined,
					polar_subscription_id: undefined
				},
				paidOrder
			)
		).toBe("recorded");
	});

	test("rejects checkout metadata pointing at a different checkout", () => {
		expect(
			paidOrderRecordingStatus(
				{
					box_id: undefined,
					polar_checkout_id: "checkout-original",
					polar_initial_order_id: undefined,
					polar_subscription_id: undefined
				},
				paidOrder
			)
		).toBe("checkout_mismatch");
	});

	test("rejects a second paid identity on an existing intent", () => {
		expect(
			paidOrderRecordingStatus(
				{
					box_id: undefined,
					polar_checkout_id: "checkout-new",
					polar_initial_order_id: "order-original",
					polar_subscription_id: "subscription-original"
				},
				paidOrder
			)
		).toBe("order_mismatch");
	});

	test("allows an idempotent redelivery for an already fulfilled box", () => {
		expect(
			paidOrderRecordingStatus(
				{
					box_id: "box-id" as never,
					polar_checkout_id: "checkout-new",
					polar_initial_order_id: "order-new",
					polar_subscription_id: "subscription-new"
				},
				paidOrder
			)
		).toBe("already_fulfilled");
	});
});

// A checkout reservation holds a slug and a slot in the fleet's capacity while
// somebody is on Polar's payment page. Everything below is about the two ways
// that goes wrong: a hold that is never released (a name and a slot lost for
// good) and a payment recorded against the wrong reservation.
describe("holding and releasing a checkout reservation", () => {
	async function buyer(t: Harness) {
		return await seedUser(t, { clerkUserId: "buyer" });
	}

	async function intent(t: Harness, over: Record<string, unknown> = {}) {
		return await t.run(
			async (ctx) =>
				await ctx.db.insert("box_checkout_intents", {
					user_id: "buyer",
					slug: "wanted",
					plan: "air",
					status: "active",
					polar_checkout_expires_at: NOW + 60_000,
					created_at: NOW - 1000,
					updated_at: NOW - 1000,
					...over
				})
		);
	}

	const rows = (t: Harness) =>
		t.run((ctx) => ctx.db.query("box_checkout_intents").collect());

	const sweep = (t: Harness) =>
		t.mutation(
			internal.checkout.checkoutIntents.releaseExpiredCheckoutIntents,
			{}
		);

	// The sweep is the only thing that frees a slug somebody abandoned on Polar's
	// page. Without it the name is held for ever and the fleet slot with it.
	test("releases a reservation whose checkout window has closed", async () => {
		const t = testConvex();
		await buyer(t);
		await intent(t, { polar_checkout_expires_at: NOW - 1 });

		expect(await sweep(t)).toBe(1);
		expect(await rows(t)).toMatchObject([
			{ status: "expired", release_reason: "checkout_expired_sweep" }
		]);
	});

	// The boundary: a window that closes exactly now has closed. Leaving it would
	// re-examine the same reservation on every sweep and never release it.
	test("releases one whose window closes exactly now", async () => {
		const t = testConvex();
		await buyer(t);
		await intent(t, { polar_checkout_expires_at: NOW });

		expect(await sweep(t)).toBe(1);
	});

	test("leaves a reservation whose window is still open", async () => {
		const t = testConvex();
		await buyer(t);
		await intent(t, { polar_checkout_expires_at: NOW + 1 });

		expect(await sweep(t)).toBe(0);
		expect(await rows(t)).toMatchObject([{ status: "active" }]);
	});

	// A reservation with no window is one Polar never gave an expiry for; the
	// sweep is bounded from below so it cannot mistake a missing field for zero
	// and release a live checkout.
	test("leaves a reservation that was never given a window", async () => {
		const t = testConvex();
		await buyer(t);
		await intent(t, { polar_checkout_expires_at: undefined });

		expect(await sweep(t)).toBe(0);
		expect(await rows(t)).toMatchObject([{ status: "active" }]);
	});

	// Only live holds are swept: one already released or already converted is
	// somebody's record, not a hold.
	test.each(["released", "expired", "converted"] as const)(
		"leaves a reservation that is already %s",
		async (status) => {
			const t = testConvex();
			await buyer(t);
			await intent(t, {
				status,
				polar_checkout_expires_at: NOW - 1
			});

			expect(await sweep(t)).toBe(0);
		}
	);

	test("reports how many it released", async () => {
		const t = testConvex();
		await buyer(t);
		for (let index = 0; index < 3; index += 1) {
			await intent(t, {
				slug: `wanted-${index}`,
				polar_checkout_expires_at: NOW - 1
			});
		}

		expect(await sweep(t)).toBe(3);
	});
});

// The billing evidence a paid order leaves on its reservation, and the guards
// that stop it landing on the wrong one. Getting this wrong means a customer's
// subscription recorded against somebody else's box.
describe("recording the order that paid for a box", () => {
	const ORDER = {
		checkoutId: "checkout_1",
		customerId: "customer_1",
		orderId: "order_1",
		subscriptionId: "subscription_1",
		termsAcceptedAt: 1
	};

	async function intent(t: Harness, over: Record<string, unknown> = {}) {
		return await t.run(
			async (ctx) =>
				await ctx.db.insert("box_checkout_intents", {
					user_id: "buyer",
					slug: "wanted",
					plan: "air",
					status: "active",
					created_at: NOW - 1000,
					updated_at: NOW - 1000,
					...over
				})
		);
	}

	const record = (
		t: Harness,
		intentId: Id<"box_checkout_intents">,
		over = {}
	) =>
		t.mutation(internal.checkout.checkoutIntents.recordInitialPaidOrder, {
			intentId,
			...ORDER,
			...over
		});

	test("writes the billing evidence onto the reservation", async () => {
		const t = testConvex();
		const intentId = await intent(t);

		expect(await record(t, intentId)).toBe("recorded");
		expect(await t.run((ctx) => ctx.db.get(intentId))).toMatchObject({
			polar_checkout_id: "checkout_1",
			polar_customer_id: "customer_1",
			polar_subscription_id: "subscription_1",
			polar_initial_order_id: "order_1"
		});
	});

	// Payment can legitimately arrive after the reservation expired - the
	// conversion that follows reacquires capacity or refunds. So the evidence is
	// kept rather than discarded.
	test.each(["expired", "released"] as const)(
		"keeps the evidence on a reservation that already %s",
		async (status) => {
			const t = testConvex();
			const intentId = await intent(t, { status });

			expect(await record(t, intentId)).toBe("recorded");
		}
	);

	// A reservation that already became a box is fulfilled; a second order
	// against it is not this purchase.
	test("refuses an order against a reservation that already became a box", async () => {
		const t = testConvex();
		const owner = await seedUser(t, { clerkUserId: "buyer" });
		const boxId = await seedBox(t, { user_id: owner.clerkUserId });
		const intentId = await intent(t, { box_id: boxId, status: "converted" });

		expect(await record(t, intentId)).toBe("already_fulfilled");
	});

	// The reservation is bound to one Polar checkout. An order from a different
	// one is somebody else's payment.
	test("refuses an order from a different checkout", async () => {
		const t = testConvex();
		const intentId = await intent(t, { polar_checkout_id: "checkout_other" });

		expect(await record(t, intentId)).toBe("checkout_mismatch");
	});

	test.each([
		["order", { polar_initial_order_id: "order_other" }],
		["subscription", { polar_subscription_id: "subscription_other" }]
	])("refuses a second %s on the same reservation", async (_name, held) => {
		const t = testConvex();
		const intentId = await intent(t, held);

		expect(await record(t, intentId)).toBe("order_mismatch");
	});

	// Repeating the identical webhook is the ordinary case - Polar retries - and
	// has to be accepted rather than read as a mismatch.
	test("accepts the same order arriving twice", async () => {
		const t = testConvex();
		const intentId = await intent(t);

		expect(await record(t, intentId)).toBe("recorded");
		expect(await record(t, intentId)).toBe("recorded");
	});

	test("says so when the reservation is gone", async () => {
		const t = testConvex();
		const intentId = await intent(t);
		await t.run(async (ctx) => await ctx.db.delete(intentId));

		expect(await record(t, intentId)).toBe("missing");
	});
});

// What a refund needs to find: the order and subscription that paid for a box.
// Answering with a half-filled pair would have the refund path calling Polar
// with `undefined`.
describe("finding the order that paid for a box", () => {
	const paidOrder = (t: Harness, boxId: Id<"boxes">) =>
		t.query(internal.checkout.checkoutIntents.paidOrderForBox, { boxId });

	async function boxWithIntent(t: Harness, over: Record<string, unknown> = {}) {
		const owner = await seedUser(t, { clerkUserId: "buyer" });
		const boxId = await seedBox(t, { user_id: owner.clerkUserId });
		await t.run(
			async (ctx) =>
				await ctx.db.insert("box_checkout_intents", {
					user_id: owner.clerkUserId,
					slug: "bought",
					plan: "air",
					status: "converted",
					box_id: boxId,
					polar_initial_order_id: "order_1",
					polar_subscription_id: "subscription_1",
					created_at: 1,
					updated_at: 1,
					...over
				})
		);
		return boxId;
	}

	test("gives back the order and subscription that paid", async () => {
		const t = testConvex();
		const boxId = await boxWithIntent(t);

		expect(await paidOrder(t, boxId)).toEqual({
			orderId: "order_1",
			subscriptionId: "subscription_1"
		});
	});

	// A comped box has no purchase behind it, and neither does one whose
	// reservation never recorded both halves.
	test.each([
		["no order id", { polar_initial_order_id: undefined }],
		["no subscription id", { polar_subscription_id: undefined }]
	])("answers with nothing for a box with %s", async (_name, over) => {
		const t = testConvex();
		const boxId = await boxWithIntent(t, over);

		expect(await paidOrder(t, boxId)).toBeNull();
	});

	test("answers with nothing for a box no reservation points at", async () => {
		const t = testConvex();
		const owner = await seedUser(t, { clerkUserId: "buyer" });
		const boxId = await seedBox(t, { user_id: owner.clerkUserId });

		expect(await paidOrder(t, boxId)).toBeNull();
	});
});

// The reservation following a selection Polar has already accepted.
//
// Its plan is what capacity admission counts snapshot slots against, so it is
// written only where Polar holds the matching product - never ahead of the call
// that could refuse it. Two entry points, because the pricing page knows the
// reservation and the `checkout.updated` webhook knows only the checkout.
describe("recording the plan a checkout now sells", () => {
	async function reservation(t: Harness, overrides: Record<string, unknown>) {
		return await t.run(
			async (ctx) =>
				await ctx.db.insert("box_checkout_intents", {
					created_at: NOW - 1000,
					plan: "air",
					polar_checkout_id: "checkout_1",
					slug: "mine",
					status: "active",
					updated_at: NOW - 1000,
					user_id: "owner",
					...overrides
				})
		);
	}

	const planOf = async (t: Harness, intentId: Id<"box_checkout_intents">) =>
		(await t.run(async (ctx) => await ctx.db.get(intentId)))?.plan;

	test("moves an active reservation onto the plan named", async () => {
		const t = testConvex();
		await seedSettings(t);
		const intentId = await reservation(t, {});

		await t.mutation(internal.checkout.checkoutIntents.recordCheckoutPlan, {
			intentId,
			plan: "pro"
		});

		expect(await planOf(t, intentId)).toBe("pro");
	});

	test("finds the same reservation by its Polar checkout", async () => {
		const t = testConvex();
		await seedSettings(t);
		const intentId = await reservation(t, {});

		await t.mutation(
			internal.checkout.checkoutIntents.recordCheckoutPlanByPolarCheckout,
			{ checkoutId: "checkout_1", plan: "pro" }
		);

		expect(await planOf(t, intentId)).toBe("pro");
	});

	// Naming the plan it already holds is not a change, so nothing is written and
	// the fleet's capacity commitment is left exactly where it was.
	test("leaves an unchanged plan untouched", async () => {
		const t = testConvex();
		await seedSettings(t);
		const intentId = await reservation(t, {});

		await t.mutation(internal.checkout.checkoutIntents.recordCheckoutPlan, {
			intentId,
			plan: "air"
		});

		expect(
			await t.run(async (ctx) => await ctx.db.get(intentId))
		).toMatchObject({ plan: "air", updated_at: NOW - 1000 });
	});

	// Both entry points refuse the same reservations, so both are asked. One that
	// ended holds no capacity, and one already converted has a box whose plan came
	// from the money - neither may be moved by a pricing card or a late webhook.
	const byIntent = async (t: Harness, intentId: Id<"box_checkout_intents">) =>
		await t.mutation(internal.checkout.checkoutIntents.recordCheckoutPlan, {
			intentId,
			plan: "pro"
		});
	const byCheckout = async (t: Harness) =>
		await t.mutation(
			internal.checkout.checkoutIntents.recordCheckoutPlanByPolarCheckout,
			{ checkoutId: "checkout_1", plan: "pro" }
		);

	test.each([
		["released", { status: "released" as const }],
		["expired", { status: "expired" as const }],
		["converted", { status: "converted" as const }]
	])("ignores a %s reservation", async (_name, overrides) => {
		const t = testConvex();
		await seedSettings(t);
		const intentId = await reservation(t, overrides);

		await byCheckout(t);
		await byIntent(t, intentId);

		expect(await planOf(t, intentId)).toBe("air");
	});

	test("ignores a reservation that already became a box", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t, { clerkUserId: "owner" });
		const boxId = await seedBox(t, { user_id: owner.clerkUserId });
		const intentId = await reservation(t, { box_id: boxId });

		await byCheckout(t);
		await byIntent(t, intentId);

		expect(await planOf(t, intentId)).toBe("air");
	});

	// Account deletion purges reservations, so an id held across an await can name
	// a row that is gone. Answering rather than throwing keeps the checkout action
	// from failing after Polar has already accepted the selection.
	test("ignores a reservation that no longer exists", async () => {
		const t = testConvex();
		await seedSettings(t);
		const intentId = await reservation(t, {});
		await t.run(async (ctx) => await ctx.db.delete(intentId));

		await expect(byIntent(t, intentId)).resolves.toBeNull();
	});

	test("ignores a Polar checkout no reservation records", async () => {
		const t = testConvex();
		await seedSettings(t);
		const intentId = await reservation(t, {});

		await t.mutation(
			internal.checkout.checkoutIntents.recordCheckoutPlanByPolarCheckout,
			{ checkoutId: "checkout_other", plan: "pro" }
		);

		expect(await planOf(t, intentId)).toBe("air");
	});
});
