import { components, internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { internalAction, type ActionCtx } from "../_generated/server";
import { SUBSCRIPTION_RECONCILIATION_STATUSES } from "../boxes/queries";
import { startBoxOperation } from "../boxes/operation/start";
import { boxSellableForProductId } from "./polar";
import { HOUR_MS } from "../time";

type ReconciliationPage = {
	continueCursor: string;
	isDone: boolean;
	page: Doc<"boxes">[];
};

async function subscriptionForBox(ctx: ActionCtx, box: Doc<"boxes">) {
	// Comp boxes are not backed by a subscription, so there is nothing to
	// reconcile - and no subscription-gone signal should ever tear one down.
	if (!box.polar_subscription_id) return null;
	return await ctx.runQuery(components.polar.lib.getSubscription, {
		id: box.polar_subscription_id
	});
}

async function reconcileBoxDeletion(
	ctx: ActionCtx,
	box: Doc<"boxes">,
	subscription: { endedAt: string | null; status: string }
) {
	if (!box.polar_subscription_id) return;

	const now = new Date().toISOString();
	const revoked =
		subscription.status === "canceled" ||
		subscription.status === "revoked" ||
		subscription.status === "unpaid" ||
		(subscription.endedAt !== null && subscription.endedAt <= now);

	if (!revoked) return;

	try {
		await startBoxOperation(ctx, box._id, "delete", {
			idempotencyKey: `delete:${box.polar_subscription_id}`,
			trigger: "system:subscription_revoked"
		});
	} catch {
		// Box is busy or already tearing down; leave it for the next sweep.
	}
}

// A box's plan is fixed when it is bought and nothing moves it afterwards, so a
// subscription whose product no longer matches its box is not a change to apply
// - it is a state that should not exist.
//
// It can only arise two ways, and both are worth a person's attention rather
// than an automatic response: the plan-change control was switched back on in
// Polar's customer portal and someone used it, or a product id was repointed on
// this deployment. Either leaves a customer paying for one thing and running
// another, and neither has a safe automatic answer - resizing a live box is not
// something this system does at all any more, and silently rebilling them is
// worse. So it says so, once per box and product, and stops.
//
// A product that matches no plan at all is the same failure seen from further
// away: this deployment can no longer say what any of its customers are paying
// for, which is also what `order.paid` would hit on the next sale. It is
// reported rather than skipped, because a sweep that stays quiet about it looks
// healthy for exactly as long as nobody checks.
async function reportPlanMismatch(
	ctx: ActionCtx,
	box: Doc<"boxes">,
	subscription: { productId: string | null | undefined }
) {
	if (!box.polar_subscription_id) return;
	const sold = boxSellableForProductId(subscription.productId);
	if (sold?.plan === box.plan) return;

	if (!sold) {
		await ctx.runMutation(internal.staff.alerts.raise, {
			key: `box-product-unrecognised:${box._id}:${subscription.productId}`,
			severity: "warning",
			subject: "Box subscription is on a product Composery does not sell",
			text: `Box ${box.slug} runs as ${box.plan}, but its Polar subscription names product ${subscription.productId}, which matches none of this deployment's POLAR_BOX_* product ids.

Nothing reconciles this, and the next paid checkout against that product would be refunded automatically. Check the product ids on this Convex deployment against the Polar catalogue.`
		});
		return;
	}

	await ctx.runMutation(internal.staff.alerts.raise, {
		key: `box-plan-mismatch:${box._id}:${sold.plan}`,
		severity: "warning",
		subject: "Box subscription no longer matches its plan",
		text: `Box ${box.slug} runs as ${box.plan} but its Polar subscription is now on a ${sold.plan} product. A box's plan is fixed at purchase, so nothing will reconcile this.

Check that subscription plan changes are disabled in the Polar customer portal, then either move the subscription back or arrange the change with the customer directly.`
	});
}

async function reconcileBox(ctx: ActionCtx, box: Doc<"boxes">) {
	const subscription = await subscriptionForBox(ctx, box);
	if (!subscription) return;

	await reconcileBoxDeletion(ctx, box, subscription);
	await reportPlanMismatch(ctx, box, subscription);
}

// What staff are told when the sweep stops early, kept out of the catch block
// that sends it. Nothing in the harness can make the sweep throw, so a payload
// written inline there could only be checked by reading it - and the two things
// worth checking are exactly the ones reading does worst: whether the message
// carries the cause, and how often an hourly failure is allowed to repeat.
//
// Windowed to six hours rather than deduplicated outright. The sweep runs every
// hour, so an outage that lasts a day would otherwise raise one alert staff
// might miss, or twenty-four they would learn to ignore; four is a number that
// keeps arriving without becoming noise.
export function reconciliationFailureAlert(error: unknown, at: number) {
	const message = error instanceof Error ? error.message : String(error);
	return {
		key: `subscription-reconciliation-failed:${Math.floor(at / (6 * HOUR_MS))}`,
		severity: "critical" as const,
		subject: "Polar subscription reconciliation failed",
		text: `The hourly subscription reconciliation stopped before it could check every box.

${message}

Review the Convex action logs and Polar subscription state.`
	};
}

// The hourly floor under Polar's webhooks: boxes whose subscription has ended get
// deleted, and boxes whose subscription has drifted from the plan they were sold
// on get reported.
export const reconcileBoxSubscriptions = internalAction({
	args: {},
	handler: async (ctx) => {
		try {
			for (const status of SUBSCRIPTION_RECONCILIATION_STATUSES) {
				let cursor: string | null = null;

				for (;;) {
					const page: ReconciliationPage = await ctx.runQuery(
						internal.boxes.queries.boxesForSubscriptionReconciliationPage,
						{ cursor, status }
					);
					for (const box of page.page) {
						await reconcileBox(ctx, box);
					}

					if (page.isDone) break;
					cursor = page.continueCursor;
				}
			}
		} catch (error) {
			await ctx.runMutation(
				internal.staff.alerts.raise,
				reconciliationFailureAlert(error, Date.now())
			);
			throw error;
		}
	}
});
