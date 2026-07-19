import type { PolarWebhookEvent } from "@convex-dev/polar";
import type { HttpRouter } from "convex/server";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { startBoxOperation } from "../boxes/operation/start";
import { CHECKOUT_INTENT_METADATA_KEYS } from "../checkout/checkoutIntents";
import { requiredEnv } from "../env";
import { TERMS_FIELD_SLUG } from "../model/legal";
import {
	boxSellableForProductId,
	polarServer,
	revokeAndRefundPolarOrder,
	revokePolarSubscription
} from "./polar";

// What these handlers need from their context, and nothing more: they read and
// they write. Polar dispatches them with either a mutation or an action context,
// and an action's signatures are the narrower pair, so naming those accepts both.
//
// Spelled out rather than borrowed from `startBoxOperation`'s parameter, which is
// what it used to be: that tied every reader here to whatever one helper happened
// to require, so narrowing the helper broke handlers that never called it.
type RouteCtx = {
	runQuery: ActionCtx["runQuery"];
	runMutation: ActionCtx["runMutation"];
};
type PolarOrder = Extract<PolarWebhookEvent, { type: "order.paid" }>["data"];
type PolarRefundedOrder = Extract<
	PolarWebhookEvent,
	{ type: "order.refunded" }
>["data"];
type PolarClosedCheckout = Extract<
	PolarWebhookEvent,
	{ type: "checkout.expired" | "checkout.updated" }
>["data"];

// Nothing here syncs a subscription into the Polar component's tables. Polar
// fires `subscription.updated` alongside every state change - active, canceled,
// revoked, uncanceled, past_due, paused - and `registerRoutes` persists that one
// itself before any handler below runs. A second copy of that write here meant
// a hand-maintained mirror of the component's field list, which is a mirror that
// can only ever fall behind it.

async function intentIdForOrder(
	ctx: RouteCtx,
	metadata: Record<string, unknown>,
	checkoutId: string | null | undefined
) {
	const metadataIntentId = metadata[CHECKOUT_INTENT_METADATA_KEYS.intentId];

	// Only the type is checked here. Whether the text is a usable id is the
	// lookup's own question, and it answers null for anything that is not - an
	// emptiness test alongside it reads as though it were not safe to ask.
	if (typeof metadataIntentId === "string") {
		const intentId = await ctx.runQuery(
			internal.checkout.checkoutIntents.checkoutIntentIdFromString,
			{ intentId: metadataIntentId }
		);
		if (intentId) return intentId;
	}

	if (!checkoutId) return null;

	return await ctx.runQuery(
		internal.checkout.checkoutIntents.checkoutIntentIdByPolarCheckout,
		{ checkoutId }
	);
}

// A paid order this deployment will not turn into a box: money taken for
// nothing. Every one of them ends the same way - tell a person, then give the
// money back and stop the subscription - so it is written once and each caller
// only says what went wrong.
//
// One `key` serves as both the alert's dedupe key and Polar's refund
// idempotency key, so the refund in Polar and the alert in the console name the
// same event. `reason: "other"` throughout: none of these is a service
// disruption, they are orders that should not have completed.
async function refuseOrder(
	ctx: RouteCtx,
	order: { id: string; subscriptionId: string },
	refusal: { comment: string; key: string; subject: string; text: string }
) {
	await ctx.runMutation(internal.staff.alerts.raise, {
		key: refusal.key,
		severity: "critical",
		subject: refusal.subject,
		text: refusal.text
	});
	await revokeAndRefundPolarOrder({
		comment: refusal.comment,
		idempotencyKey: refusal.key,
		orderId: order.id,
		reason: "other",
		subscriptionId: order.subscriptionId
	});
}

// A completed first payment, turned into a box or refused outright. There is no
// third outcome: every early return below either belongs to another event
// entirely (a renewal) or hands the money back, because an `order.paid` this
// code quietly ignores is a customer who has been charged and will never be
// told why nothing arrived.
export async function handlePaidOrder(ctx: RouteCtx, order: PolarOrder) {
	// Renewals and mid-term changes bill an existing box. Only the order that
	// opens a subscription creates one.
	if (order.billingReason !== "subscription_create") return;

	if (!order.subscription) {
		await ctx.runMutation(internal.staff.alerts.raise, {
			key: `paid-order-without-subscription:${order.id}`,
			severity: "critical",
			subject: "Paid Polar order opened no subscription",
			text: `Polar order ${order.id} completed for customer ${order.customerId} with billing reason subscription_create but carries no subscription, so it can neither be fulfilled nor revoked automatically. Refund it in Polar by hand and review the product it was placed against.`
		});
		return;
	}
	const paid = { id: order.id, subscriptionId: order.subscription.id };

	// What was paid for decides which machine gets provisioned, so the plan is
	// read off the order's product rather than off the reservation that preceded
	// it. A product this deployment does not sell means its `POLAR_BOX_*` ids are
	// wrong or Polar's catalogue moved - either way nothing can be provisioned,
	// and silence here would leave a paying customer with no box and no signal.
	const sellable = boxSellableForProductId(order.productId);
	if (!sellable) {
		await refuseOrder(ctx, paid, {
			comment: "Composery does not sell the product this order was placed for.",
			key: `unsellable-product:${order.id}`,
			subject: "Paid Polar order is for a product Composery does not sell",
			text: `Polar order ${order.id} completed for customer ${order.customerId} against product ${order.productId}, which matches none of this deployment's POLAR_BOX_* product ids. Nothing was provisioned; the subscription is being revoked and the order refunded automatically. Check the product ids on this Convex deployment against the Polar catalogue.`
		});
		return;
	}

	const intentId = order.checkoutId
		? await intentIdForOrder(ctx, order.metadata, order.checkoutId)
		: null;
	if (!intentId || !order.checkoutId) {
		await refuseOrder(ctx, paid, {
			comment:
				"The paid order could not be linked to a Composery checkout intent.",
			key: `unmatched-checkout:${order.id}`,
			subject: "Paid Polar order is not linked to a checkout",
			text: `Polar order ${order.id} completed for customer ${order.customerId} and subscription ${paid.subscriptionId}, but no Composery checkout intent matched checkout ${order.checkoutId ?? "(none)"}. Fulfillment did not start. The subscription is being revoked and the order refunded automatically. Review the order and webhook metadata in Polar.`
		});
		return;
	}

	if (order.customFieldData?.[TERMS_FIELD_SLUG] !== true) {
		await refuseOrder(ctx, paid, {
			comment: "Required supplier Terms acceptance was missing.",
			key: `missing-terms:${order.id}`,
			subject: "Paid Polar order is missing Terms acceptance",
			text: `Polar order ${order.id} completed for checkout intent ${intentId}, but the required supplier Terms checkbox was not present. The subscription is being revoked and the order refunded automatically.`
		});
		return;
	}

	const recorded = await ctx.runMutation(
		internal.checkout.checkoutIntents.recordInitialPaidOrder,
		{
			checkoutId: order.checkoutId,
			customerId: order.customerId,
			intentId,
			orderId: order.id,
			subscriptionId: paid.subscriptionId,
			termsAcceptedAt: order.createdAt.getTime()
		}
	);
	if (recorded !== "recorded" && recorded !== "already_fulfilled") {
		await refuseOrder(ctx, paid, {
			comment: `The paid order did not match its Composery checkout intent (${recorded}).`,
			key: `checkout-intent-mismatch:${order.id}`,
			subject: "Paid Polar order does not match its checkout intent",
			text: `Polar order ${order.id} could not be recorded on checkout intent ${intentId} (${recorded}). Fulfillment did not start. The subscription is being revoked and the order refunded automatically.`
		});
		return;
	}

	const conversion = await ctx.runMutation(
		internal.checkout.checkoutConversion.convertCheckoutIntentToBox,
		{
			intentId,
			plan: sellable.plan,
			polarCustomerId: order.customerId,
			polarOrderId: order.id,
			polarSubscriptionId: paid.subscriptionId,
			runtimeImage: requiredEnv("RUNTIME_IMAGE")
		}
	);
	// The conversion raises its own alert before refusing, because only it knows
	// which of capacity or the slug ran out.
	if (conversion.unfulfilled) {
		await revokeAndRefundPolarOrder(conversion.unfulfilled);
	}
}

// A refund that leaves nothing refundable ends the sale. Polar refunds and
// subscriptions are independent, so a full cumulative refund must not leave the
// box running or able to renew - revoking is what then deletes it, through
// `subscription.revoked`.
export async function handleRefundedOrder(
	ctx: RouteCtx,
	order: PolarRefundedOrder
) {
	if (order.refundableAmount !== 0 || !order.subscriptionId) return;

	const intentId = await intentIdForOrder(
		ctx,
		order.metadata,
		order.checkoutId
	);
	const boxId = await ctx.runQuery(internal.boxes.queries.boxIdBySubscription, {
		subscriptionId: order.subscriptionId
	});
	if (!intentId && !boxId) return;

	if (intentId) {
		await ctx.runMutation(
			internal.checkout.checkoutIntents.releaseCheckoutIntent,
			{
				intentId,
				polarCheckoutStatus: "refunded",
				reason: "order_fully_refunded"
			}
		);
	}

	await revokePolarSubscription(order.subscriptionId);
}

export async function handleRevokedSubscription(
	ctx: RouteCtx,
	subscriptionId: string
) {
	const boxId = await ctx.runQuery(internal.boxes.queries.boxIdBySubscription, {
		subscriptionId
	});
	if (!boxId) return;

	await startBoxOperation(ctx, boxId, "delete", {
		idempotencyKey: `delete:${subscriptionId}`,
		trigger: "system:subscription_revoked"
	});
}

// A checkout that ended without paying gives its slug and capacity back. Polar
// reports it twice - the dedicated `checkout.expired` event and the terminal
// status on `checkout.updated` - so both arrive here and the second is a no-op.
const CHECKOUT_RELEASES = {
	expired: { reason: "checkout_expired", status: "expired" },
	failed: { reason: "checkout_failed", status: "released" }
} as const;

export async function handleClosedCheckout(
	ctx: RouteCtx,
	checkout: PolarClosedCheckout
) {
	const release =
		CHECKOUT_RELEASES[checkout.status as keyof typeof CHECKOUT_RELEASES];
	if (!release) return;

	await ctx.runMutation(
		internal.checkout.checkoutIntents.releaseCheckoutIntentByPolarCheckout,
		{
			checkoutId: checkout.id,
			polarCheckoutStatus: checkout.status,
			reason: release.reason,
			status: release.status
		}
	);
}

// A checkout that is still open, reporting what it now sells.
//
// A session offers every product this deployment sells, so the customer can
// change plan inside Polar's checkout as freely as they can change billing
// interval. The reservation has to follow, because its plan is what capacity
// admission counts snapshot slots against - an Air-sized reservation held open
// for a Pro sale is the fleet under-counting what it has promised.
//
// The box itself never depends on this: `handlePaidOrder` reads the plan off the
// product the order was actually paid against. This keeps the commitment honest
// while the checkout is open, which is the only window it can be wrong in.
export async function handleOpenCheckout(
	ctx: RouteCtx,
	checkout: PolarClosedCheckout
) {
	// An unrecognised product is not corrected here. It cannot be provisioned
	// either, and `handlePaidOrder` refuses the money with an alert that says so -
	// two reports of one misconfiguration would just be noise on the sale.
	const sellable = boxSellableForProductId(checkout.productId);
	if (!sellable) return;

	await ctx.runMutation(
		internal.checkout.checkoutIntents.recordCheckoutPlanByPolarCheckout,
		{ checkoutId: checkout.id, plan: sellable.plan }
	);
}

// Polar reports a change and an ending through the same event, so the status
// decides which this is. Both are handled: an update that ends the checkout
// gives the slug back, and one that does not tells us what it now sells.
export async function handleUpdatedCheckout(
	ctx: RouteCtx,
	checkout: PolarClosedCheckout
) {
	// Object.hasOwn, not `in`: the status is free-form text off a webhook, and
	// `in` walks the prototype chain, so "constructor" would read as an ending.
	if (Object.hasOwn(CHECKOUT_RELEASES, checkout.status)) {
		await handleClosedCheckout(ctx, checkout);
		return;
	}
	await handleOpenCheckout(ctx, checkout);
}

export function registerPolarWebhookRoutes(http: HttpRouter) {
	polarServer().registerRoutes(http, {
		events: {
			"order.paid": async (ctx, event) => {
				await handlePaidOrder(ctx, event.data);
			},
			"order.refunded": async (ctx, event) => {
				await handleRefundedOrder(ctx, event.data);
			},
			"subscription.revoked": async (ctx, event) => {
				await handleRevokedSubscription(ctx, event.data.id);
			},
			// `checkout.expired` carries a checkout whose status is already
			// "expired", so it only ever has an ending to report.
			"checkout.expired": async (ctx, event) => {
				await handleClosedCheckout(ctx, event.data);
			},
			"checkout.updated": async (ctx, event) => {
				await handleUpdatedCheckout(ctx, event.data);
			}
		}
	});
}
