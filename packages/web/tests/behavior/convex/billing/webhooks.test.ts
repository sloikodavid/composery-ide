import type { FunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Polar's own API is the one thing here that cannot be exercised - revoking and
// refunding are outbound calls - so those two are stubbed and everything else is
// the real handler against a real deployment. What is asserted is the decision:
// which paid orders become boxes, which are handed back, and that none is
// silently dropped, because an `order.paid` this code ignores is a customer who
// has been charged and will never be told why nothing arrived.
const revokeAndRefundPolarOrder = vi.fn();
const revokePolarSubscription = vi.fn();
vi.mock("@/convex/billing/polar", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/convex/billing/polar")>();
	return { ...actual, revokeAndRefundPolarOrder, revokePolarSubscription };
});

const {
	handleClosedCheckout,
	handlePaidOrder,
	handleRefundedOrder,
	handleRevokedSubscription,
	handleUpdatedCheckout
} = await import("@/convex/billing/webhooks");
const { CHECKOUT_INTENT_METADATA_KEYS } =
	await import("@/convex/checkout/checkoutIntents");
// The real slug, because a fixture spelling it by hand would keep passing after
// the field was renamed in Polar and here.
const { TERMS_FIELD_SLUG } = await import("@/convex/model/legal");
const {
	boxOperations,
	readBox,
	seedBox,
	seedSettings,
	seedUser,
	staffAlerts,
	stubDeploymentEnv,
	testConvex
} = await import("../../../support/convex.ts");
type Harness = Awaited<
	ReturnType<typeof import("../../../support/convex.ts").testConvex>
>;

const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	stubDeploymentEnv();
	vi.stubEnv("RUNTIME_IMAGE", "ghcr.io/example/composery@sha256:abc");
	revokeAndRefundPolarOrder.mockReset();
	revokePolarSubscription.mockReset();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

// Polar dispatches its handlers with a context that can only run functions, so
// that is exactly what a test gives them. No `db`: a handler that reached for
// one would be doing work the webhook route cannot do.
function routeCtx(t: Harness) {
	return {
		runQuery: (reference: FunctionReference<"query">, args: never) =>
			t.query(reference, args),
		runMutation: (reference: FunctionReference<"mutation">, args: never) =>
			t.mutation(reference, args)
	} as unknown as Parameters<typeof handlePaidOrder>[0];
}

// Only the fields a handler reads. Written out rather than built from Polar's
// full Order so that adding a read to the handler shows up here as a missing
// field instead of passing on a fixture nobody checked.
function paidOrder(overrides: Record<string, unknown> = {}) {
	return {
		billingReason: "subscription_create",
		checkoutId: "checkout_1",
		createdAt: new Date(NOW - 1000),
		customFieldData: { [TERMS_FIELD_SLUG]: true },
		customerId: "cus_1",
		id: "order_1",
		metadata: {},
		productId: "air-monthly",
		subscription: { id: "sub_1" },
		...overrides
	} as unknown as Parameters<typeof handlePaidOrder>[1];
}

async function seedIntent(
	t: Harness,
	userId: string,
	overrides: Record<string, unknown> = {}
) {
	return await t.run(
		async (ctx) =>
			await ctx.db.insert("box_checkout_intents", {
				user_id: userId,
				slug: "mine",
				plan: "air",
				status: "active",
				polar_checkout_id: "checkout_1",
				created_at: NOW - 1000,
				updated_at: NOW - 1000,
				...overrides
			})
	);
}

describe("a paid Polar order", () => {
	test("provisions the box on the plan the order names", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		const intentId = await seedIntent(t, owner.clerkUserId);

		await handlePaidOrder(routeCtx(t), paidOrder({ productId: "pro-annual" }));

		const intent = await t.run(async (ctx) => await ctx.db.get(intentId));
		expect(intent).toMatchObject({ status: "converted" });
		expect(await readBox(t, intent!.box_id!)).toMatchObject({
			plan: "pro",
			slug: "mine",
			status: "creating",
			polar_subscription_id: "sub_1"
		});
		expect(revokeAndRefundPolarOrder).not.toHaveBeenCalled();
		expect(await staffAlerts(t)).toEqual([]);
	});

	// The reservation is found by the intent id carried in checkout metadata as
	// well as by the checkout id, so a checkout Polar renumbered still converts.
	test("matches its reservation through checkout metadata", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		const intentId = await seedIntent(t, owner.clerkUserId, {
			polar_checkout_id: undefined
		});

		await handlePaidOrder(
			routeCtx(t),
			paidOrder({
				metadata: { [CHECKOUT_INTENT_METADATA_KEYS.intentId]: intentId }
			})
		);

		expect(
			await t.run(async (ctx) => await ctx.db.get(intentId))
		).toMatchObject({ status: "converted" });
	});

	// A renewal bills a box that already exists. Reading it as a first payment
	// would provision a second one on the same subscription.
	test.each(["subscription_cycle", "subscription_update", "purchase"])(
		"ignores an order billed as %s",
		async (billingReason) => {
			const t = testConvex();
			await seedSettings(t);
			const owner = await seedUser(t);
			await seedIntent(t, owner.clerkUserId);

			await handlePaidOrder(routeCtx(t), paidOrder({ billingReason }));

			expect(
				await t.run(async (ctx) => await ctx.db.query("boxes").first())
			).toBeNull();
			expect(revokeAndRefundPolarOrder).not.toHaveBeenCalled();
			expect(await staffAlerts(t)).toEqual([]);
		}
	);

	// The failure this file exists for. An unconfigured or repointed product id
	// used to end the handler on its first line: the customer was charged, no box
	// was made, and nothing anywhere said so.
	test("refunds and reports an order for a product it does not sell", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		await seedIntent(t, owner.clerkUserId);

		await handlePaidOrder(
			routeCtx(t),
			paidOrder({ productId: "prod_from_another_catalogue" })
		);

		expect(
			await t.run(async (ctx) => await ctx.db.query("boxes").first())
		).toBeNull();
		expect(revokeAndRefundPolarOrder).toHaveBeenCalledWith(
			expect.objectContaining({
				idempotencyKey: "unsellable-product:order_1",
				orderId: "order_1",
				subscriptionId: "sub_1"
			})
		);
		expect(await staffAlerts(t)).toMatchObject([
			{
				key: "unsellable-product:order_1",
				severity: "critical",
				subject: "Paid Polar order is for a product Composery does not sell"
			}
		]);
	});

	test("refunds and reports an order no reservation matches", async () => {
		const t = testConvex();
		await seedSettings(t);

		await handlePaidOrder(routeCtx(t), paidOrder());

		expect(revokeAndRefundPolarOrder).toHaveBeenCalledWith(
			expect.objectContaining({ idempotencyKey: "unmatched-checkout:order_1" })
		);
		expect(await staffAlerts(t)).toMatchObject([
			{ subject: "Paid Polar order is not linked to a checkout" }
		]);
	});

	// The supplier Terms checkbox is the acceptance evidence. Without it there is
	// no contract to fulfil, whatever was paid.
	test.each([{}, { [TERMS_FIELD_SLUG]: false }])(
		"refunds and reports an order whose Terms checkbox is %o",
		async (customFieldData) => {
			const t = testConvex();
			await seedSettings(t);
			const owner = await seedUser(t);
			await seedIntent(t, owner.clerkUserId);

			await handlePaidOrder(routeCtx(t), paidOrder({ customFieldData }));

			expect(
				await t.run(async (ctx) => await ctx.db.query("boxes").first())
			).toBeNull();
			expect(revokeAndRefundPolarOrder).toHaveBeenCalledWith(
				expect.objectContaining({ idempotencyKey: "missing-terms:order_1" })
			);
			expect(await staffAlerts(t)).toMatchObject([
				{ subject: "Paid Polar order is missing Terms acceptance" }
			]);
		}
	);

	// A reservation already carrying a different order is not this order's, so
	// recording would overwrite one sale's evidence with another's.
	test("refunds and reports an order that contradicts its reservation", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		await seedIntent(t, owner.clerkUserId, {
			polar_initial_order_id: "order_earlier",
			polar_subscription_id: "sub_earlier"
		});

		await handlePaidOrder(routeCtx(t), paidOrder());

		expect(revokeAndRefundPolarOrder).toHaveBeenCalledWith(
			expect.objectContaining({
				idempotencyKey: "checkout-intent-mismatch:order_1"
			})
		);
		expect(await staffAlerts(t)).toMatchObject([
			{ subject: "Paid Polar order does not match its checkout intent" }
		]);
	});

	// Polar retries a webhook it did not get a 2xx for, so every one of these
	// arrives twice sooner or later.
	test("buys one box for a webhook delivered twice", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		const intentId = await seedIntent(t, owner.clerkUserId);

		await handlePaidOrder(routeCtx(t), paidOrder());
		await handlePaidOrder(routeCtx(t), paidOrder());

		const boxes = await t.run(
			async (ctx) => await ctx.db.query("boxes").collect()
		);
		expect(boxes).toHaveLength(1);
		expect(await boxOperations(t, boxes[0]!._id)).toHaveLength(1);
		expect(revokeAndRefundPolarOrder).not.toHaveBeenCalled();
		expect(
			await t.run(async (ctx) => await ctx.db.get(intentId))
		).toMatchObject({ status: "converted" });
	});

	// Nothing to revoke means the automatic path cannot run at all, which is
	// precisely when a person has to be told rather than the event dropped.
	test("reports an order that opened no subscription without refunding blind", async () => {
		const t = testConvex();
		await seedSettings(t);

		await handlePaidOrder(routeCtx(t), paidOrder({ subscription: null }));

		expect(revokeAndRefundPolarOrder).not.toHaveBeenCalled();
		expect(await staffAlerts(t)).toMatchObject([
			{ subject: "Paid Polar order opened no subscription" }
		]);
	});
});

describe("a fully refunded order", () => {
	test("revokes the subscription behind it", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		await seedBox(t, {
			user_id: owner.clerkUserId,
			polar_subscription_id: "sub_1"
		});

		await handleRefundedOrder(
			routeCtx(t),
			paidOrder({ refundableAmount: 0, subscriptionId: "sub_1" })
		);

		expect(revokePolarSubscription).toHaveBeenCalledWith("sub_1");
	});

	// A partial refund is a price adjustment, not the end of the sale.
	test("leaves a partly refunded order alone", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		await seedBox(t, {
			user_id: owner.clerkUserId,
			polar_subscription_id: "sub_1"
		});

		await handleRefundedOrder(
			routeCtx(t),
			paidOrder({ refundableAmount: 500, subscriptionId: "sub_1" })
		);

		expect(revokePolarSubscription).not.toHaveBeenCalled();
	});

	test("releases a reservation that never became a box", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const intentId = await seedIntent(t, owner.clerkUserId);

		await handleRefundedOrder(
			routeCtx(t),
			paidOrder({ refundableAmount: 0, subscriptionId: "sub_1" })
		);

		expect(
			await t.run(async (ctx) => await ctx.db.get(intentId))
		).toMatchObject({
			release_reason: "order_fully_refunded",
			status: "released"
		});
	});
});

describe("a revoked subscription", () => {
	test("starts deleting the box it paid for", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			polar_subscription_id: "sub_1"
		});

		await handleRevokedSubscription(routeCtx(t), "sub_1");

		expect(await readBox(t, boxId)).toMatchObject({ status: "deleting" });
	});

	test("does nothing for a subscription no box is on", async () => {
		const t = testConvex();

		await expect(
			handleRevokedSubscription(routeCtx(t), "sub_unknown")
		).resolves.toBeUndefined();
	});
});

describe("a checkout that ended without paying", () => {
	test.each([
		["expired", "expired", "checkout_expired"],
		["failed", "released", "checkout_failed"]
	])(
		"releases the reservation behind a %s checkout",
		async (status, intentStatus, reason) => {
			const t = testConvex();
			const owner = await seedUser(t);
			const intentId = await seedIntent(t, owner.clerkUserId, {
				polar_checkout_url: "https://polar.test/checkout_1"
			});

			await handleClosedCheckout(routeCtx(t), {
				id: "checkout_1",
				status
			} as unknown as Parameters<typeof handleClosedCheckout>[1]);

			const intent = await t.run(async (ctx) => await ctx.db.get(intentId));
			expect(intent).toMatchObject({
				release_reason: reason,
				status: intentStatus
			});
			// The live checkout link is a capability anyone holding it could act on,
			// and it means nothing once the reservation is gone.
			expect(intent?.polar_checkout_url).toBeUndefined();
		}
	);

	// `checkout.updated` fires on every change, and most of them are a customer
	// still filling the form in. Through the handler the route actually registers,
	// so a status that stopped counting as an ending would show up here.
	test.each(["open", "confirmed", "succeeded"])(
		"holds the reservation while a checkout is %s",
		async (status) => {
			const t = testConvex();
			await seedSettings(t);
			const owner = await seedUser(t);
			const intentId = await seedIntent(t, owner.clerkUserId);

			await handleUpdatedCheckout(routeCtx(t), {
				id: "checkout_1",
				productId: "air-monthly",
				status
			} as unknown as Parameters<typeof handleUpdatedCheckout>[1]);

			expect(
				await t.run(async (ctx) => await ctx.db.get(intentId))
			).toMatchObject({ status: "active" });
		}
	);
});

// A checkout session offers every product Composery sells, so the customer can
// change plan inside Polar's own checkout. The reservation's plan is what
// capacity admission counts snapshot slots against, so it has to follow - an
// Air-sized reservation held open for a Pro sale is the fleet under-counting
// what it has promised.
describe("a checkout that changed what it sells", () => {
	async function updateSelection(t: Harness, productId: string | null) {
		await handleUpdatedCheckout(routeCtx(t), {
			id: "checkout_1",
			productId,
			status: "open"
		} as unknown as Parameters<typeof handleUpdatedCheckout>[1]);
	}

	test("moves the reservation onto the plan now selected", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		const intentId = await seedIntent(t, owner.clerkUserId);

		await updateSelection(t, "pro-annual");

		expect(
			await t.run(async (ctx) => await ctx.db.get(intentId))
		).toMatchObject({ plan: "pro", status: "active" });
	});

	// Switching billing interval is not a change of plan, and must not read as one.
	test("leaves the plan alone when only the interval changed", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		const intentId = await seedIntent(t, owner.clerkUserId);

		await updateSelection(t, "air-annual");

		expect(
			await t.run(async (ctx) => await ctx.db.get(intentId))
		).toMatchObject({ plan: "air" });
	});

	// Nothing to correct it to, and `handlePaidOrder` already refuses the money
	// with an alert naming the misconfiguration. A second report would be noise.
	test.each([null, "someone-elses-product"])(
		"leaves the plan alone for product %p",
		async (productId) => {
			const t = testConvex();
			await seedSettings(t);
			const owner = await seedUser(t);
			const intentId = await seedIntent(t, owner.clerkUserId);

			await updateSelection(t, productId);

			expect(
				await t.run(async (ctx) => await ctx.db.get(intentId))
			).toMatchObject({ plan: "air" });
		}
	);

	// The ending still wins: one event carries both, and a terminal status has to
	// give the slug back rather than record what it was selling on the way out.
	test("releases the reservation when the update ends the checkout", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		const intentId = await seedIntent(t, owner.clerkUserId);

		await handleUpdatedCheckout(routeCtx(t), {
			id: "checkout_1",
			productId: "pro-annual",
			status: "expired"
		} as unknown as Parameters<typeof handleUpdatedCheckout>[1]);

		expect(
			await t.run(async (ctx) => await ctx.db.get(intentId))
		).toMatchObject({ plan: "air", status: "expired" });
	});

	// A reservation that already ended holds no capacity, so nothing about it may
	// be moved by a late update.
	test("ignores an update for a reservation that already ended", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		const intentId = await seedIntent(t, owner.clerkUserId, {
			status: "released"
		});

		await updateSelection(t, "pro-annual");

		expect(
			await t.run(async (ctx) => await ctx.db.get(intentId))
		).toMatchObject({ plan: "air", status: "released" });
	});
});

// Matching a paid order back to the reservation it belongs to.
//
// Two independent routes to the same answer, tried in order: the intent id
// Composery wrote into the checkout's metadata, then the Polar checkout id the
// reservation recorded. Two, because either can be missing - metadata does not
// survive every way a checkout can be recreated, and a checkout id is not
// written until Polar has one - and matching the wrong reservation would convert
// somebody else's.
//
// The metadata route reads a field Polar hands back as unknown JSON, so the
// cases below are the shapes an outside system can actually put there, not
// hypotheticals: absent, empty, and not-a-string all have to fall through to the
// second route rather than throw or match nothing.
describe("matching a paid order to its reservation", () => {
	const metadata = (value: unknown) => ({
		[CHECKOUT_INTENT_METADATA_KEYS.intentId]: value
	});

	test.each([
		["an empty string", ""],
		["a number", 7],
		["null", null]
	])(
		"falls back to the checkout id when the metadata id is %s",
		async (_name, value) => {
			const t = testConvex();
			await seedSettings(t);
			const owner = await seedUser(t);
			const intentId = await seedIntent(t, owner.clerkUserId);

			await handlePaidOrder(
				routeCtx(t),
				paidOrder({ metadata: metadata(value) })
			);

			expect(
				await t.run(async (ctx) => await ctx.db.get(intentId))
			).toMatchObject({ status: "converted" });
			expect(revokeAndRefundPolarOrder).not.toHaveBeenCalled();
		}
	);

	// A metadata id that is well-formed but names no reservation falls through
	// too, rather than being taken as proof there is none.
	test("falls back when the metadata id matches no reservation", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		const intentId = await seedIntent(t, owner.clerkUserId);
		const stale = await t.run(async (ctx) => {
			const id = await ctx.db.insert("box_checkout_intents", {
				user_id: owner.clerkUserId,
				slug: "gone",
				plan: "air",
				status: "released",
				created_at: 1,
				updated_at: 1
			});
			await ctx.db.delete(id);
			return id;
		});

		await handlePaidOrder(
			routeCtx(t),
			paidOrder({ metadata: metadata(stale) })
		);

		expect(
			await t.run(async (ctx) => await ctx.db.get(intentId))
		).toMatchObject({ status: "converted" });
	});

	// The metadata id wins when both routes are available and disagree: it names
	// this order's reservation, while a checkout id can be shared by a checkout
	// that was recreated.
	test("prefers the metadata id over the checkout id", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		const byCheckout = await seedIntent(t, owner.clerkUserId);
		const byMetadata = await t.run(
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

		await handlePaidOrder(
			routeCtx(t),
			paidOrder({ metadata: metadata(byMetadata) })
		);

		expect(
			await t.run(async (ctx) => await ctx.db.get(byMetadata))
		).toMatchObject({ status: "converted" });
		expect(
			await t.run(async (ctx) => await ctx.db.get(byCheckout))
		).toMatchObject({ status: "active" });
	});

	// No route at all. The order is still refused loudly rather than dropped -
	// somebody has been charged.
	test("refuses an order carrying neither route", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		await seedIntent(t, owner.clerkUserId);

		await handlePaidOrder(
			routeCtx(t),
			paidOrder({ checkoutId: null, metadata: {} })
		);

		expect(revokeAndRefundPolarOrder).toHaveBeenCalledWith(
			expect.objectContaining({ idempotencyKey: "unmatched-checkout:order_1" })
		);
	});

	// Polar sends no custom-field object at all when a checkout has no custom
	// fields, which is not the same as a Terms box left unticked - but it is the
	// same answer, and reading it must not throw on the way there.
	test("refuses an order carrying no custom fields at all", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		await seedIntent(t, owner.clerkUserId);

		await handlePaidOrder(
			routeCtx(t),
			paidOrder({ customFieldData: undefined })
		);

		expect(revokeAndRefundPolarOrder).toHaveBeenCalledWith(
			expect.objectContaining({ idempotencyKey: "missing-terms:order_1" })
		);
	});
});

// What a refused order tells the people who have to fix it.
//
// Every refusal here has already taken somebody's money and given it back
// automatically, so the alert is not a warning - it is the record of a completed
// financial event that nobody chose. It has to carry the order, the customer and
// the reason, because reconciling it in Polar afterwards needs all three, and
// the comment goes onto the refund itself where the customer's own receipt shows
// it.
describe("what a refused order tells the people who have to fix it", () => {
	test("names the order, the customer and the subscription when nothing matched", async () => {
		const t = testConvex();
		await seedSettings(t);

		await handlePaidOrder(routeCtx(t), paidOrder());

		const [alert] = await staffAlerts(t);
		expect(alert.text).toContain("order_1");
		expect(alert.text).toContain("cus_1");
		expect(alert.text).toContain("sub_1");
		// Says the money is already back, so nobody refunds it a second time by
		// hand.
		expect(alert.text).toContain("refunded automatically");
	});

	// The comment rides on the refund in Polar, so it is what the finance record
	// says this refund was for.
	test("says on the refund itself why it was made", async () => {
		const t = testConvex();
		await seedSettings(t);

		await handlePaidOrder(routeCtx(t), paidOrder());

		expect(revokeAndRefundPolarOrder).toHaveBeenCalledWith(
			expect.objectContaining({
				comment:
					"The paid order could not be linked to a Composery checkout intent."
			})
		);
	});

	test("gives a missing Terms acceptance its own reason on the refund", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		const intentId = await seedIntent(t, owner.clerkUserId);

		await handlePaidOrder(routeCtx(t), paidOrder({ customFieldData: {} }));

		expect(revokeAndRefundPolarOrder).toHaveBeenCalledWith(
			expect.objectContaining({
				comment: "Required supplier Terms acceptance was missing."
			})
		);
		const [alert] = await staffAlerts(t);
		expect(alert.text).toContain(String(intentId));
	});

	// A refund arriving for an order Composery never linked to anything is not an
	// error to report - there is nothing to release and nothing to delete.
	test("does nothing for a full refund it can match to neither", async () => {
		const t = testConvex();
		await seedSettings(t);

		await handleRefundedOrder(
			routeCtx(t),
			paidOrder({
				checkoutId: null,
				metadata: {},
				refundableAmount: 0,
				subscriptionId: "sub_x"
			})
		);

		expect(await staffAlerts(t)).toEqual([]);
	});
});
