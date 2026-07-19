import { ConvexError, v } from "convex/values";
import { internalMutation, type MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { appendBoxEvent } from "../boxes/operation/event";
import { boxEventType } from "../model/box/operation";
import { reconcileCapacityAlert } from "../boxes/capacity";
import { startBoxOperation } from "../boxes/operation/start";
import { isSlugAvailable } from "../boxes/slugAvailability";
import { insertBox } from "../boxes/counts";
import {
	billingRecordPurgeAt,
	terminalCheckoutSecretPatch
} from "../boxes/retention";
import { CHECKOUT_INTENT_METADATA_KEYS } from "./checkoutIntents";
import { capacityBlockMessage, readCapacityUsage } from "../boxes/capacity";
import { readGlobalSettings } from "../settings";
import { raiseAlert } from "../staff/alerts";
import { vBoxPlan } from "../schema";
import { defaultManualSnapshotCap } from "../model/box/plan";

// Every way a paid checkout can end without becoming a box, and what the
// customer is told on the refund.
//
// Keyed by the release reason, so the reason stored on the row, the staff alert
// it raises, and the refund's idempotency key in Polar are one string rather
// than three spellings of one event that can drift apart.
//
// `null` means the money is already back: a fully refunded order needs no
// second refund, and asking Polar for one is the bug this row prevents.
const UNFULFILLABLE = {
	account_deleted:
		"The Composery account was deleted before fulfillment finished.",
	capacity_unavailable:
		"Composery infrastructure capacity was no longer available when the paid checkout arrived.",
	order_fully_refunded: null,
	slug_conflict: "The selected Composery box slug was no longer available."
} as const;

type UnfulfillableReason = keyof typeof UNFULFILLABLE;

// Object.hasOwn, not `in`: the reason is free-form text read back off a stored
// row, and `in` walks the prototype chain, so "constructor" would pass.
function unfulfillableReason(
	reason: string | undefined
): UnfulfillableReason | null {
	return reason && Object.hasOwn(UNFULFILLABLE, reason)
		? (reason as UnfulfillableReason)
		: null;
}

type PaidOrder = {
	polarCustomerId: string;
	polarOrderId: string;
	polarSubscriptionId: string;
};

function unfulfilled(
	intent: Doc<"box_checkout_intents">,
	reason: UnfulfillableReason,
	order: PaidOrder
) {
	const comment = UNFULFILLABLE[reason];
	return {
		boxId: null,
		unfulfilled: comment
			? {
					comment,
					idempotencyKey: `${reason}:${intent._id}`,
					orderId: order.polarOrderId,
					subscriptionId: order.polarSubscriptionId
				}
			: null
	};
}

// End the sale on a paid checkout this deployment cannot deliver: record why,
// tell a person, and hand back what the caller needs to revoke and refund.
//
// The billing evidence is kept on the row rather than discarded, because the
// refund has to be auditable against the order that paid for it. Capacity is
// reconciled on the way out for the same reason in both cases - the reservation
// stops holding a server either way, so an alert raised while it did must not
// outlive it.
async function refuseSale(
	ctx: MutationCtx,
	intent: Doc<"box_checkout_intents">,
	order: PaidOrder,
	reason: UnfulfillableReason,
	alert: { subject: string; text: string }
) {
	const timestamp = Date.now();
	await ctx.db.patch(intent._id, {
		status: "released",
		release_reason: reason,
		released_at: timestamp,
		purge_at: billingRecordPurgeAt(timestamp),
		...terminalCheckoutSecretPatch(),
		polar_customer_id: order.polarCustomerId,
		polar_subscription_id: order.polarSubscriptionId,
		updated_at: timestamp
	});
	await raiseAlert(ctx, {
		key: `${reason}:${intent._id}`,
		severity: "critical",
		subject: alert.subject,
		text: alert.text
	});
	await reconcileCapacityAlert(ctx);

	return unfulfilled(intent, reason, order);
}

export const convertCheckoutIntentToBox = internalMutation({
	args: {
		intentId: v.id("box_checkout_intents"),
		// The plan of the product actually paid for, not the one the reservation
		// was made under. A checkout session offers every product this deployment
		// sells, so the two can legitimately differ right up to the payment - the
		// money is what decides which machine the customer gets, so the box is born
		// agreeing with its own subscription and the plan reconciler has nothing to
		// fix. The reservation's own plan follows the same selection through
		// `checkout.updated`; it is capacity accounting, never the sale.
		plan: vBoxPlan,
		polarCustomerId: v.string(),
		polarOrderId: v.string(),
		polarSubscriptionId: v.string(),
		runtimeImage: v.string()
	},
	handler: async (ctx, args) => {
		const intent = await ctx.db.get(args.intentId);
		if (!intent) throw new ConvexError("Checkout intent not found.");

		if (intent.box_id) {
			return { boxId: intent.box_id, unfulfilled: null };
		}

		// A terminal release must never be resurrected by a re-delivered webhook:
		// it already decided this sale's outcome, and the refund it named is
		// idempotent, so repeating the answer is the whole point.
		const released = unfulfillableReason(intent.release_reason);
		if (released) return unfulfilled(intent, released, args);

		// An active intent already owns one server and its full snapshot allowance.
		// A late paid event for an expired/released intent has lost that reservation,
		// so it must atomically reacquire capacity before becoming a box.
		if (intent.status !== "active") {
			const settings = await readGlobalSettings(ctx);
			const capacity = await readCapacityUsage(ctx, settings);
			if (!capacity.checkoutAvailable) {
				return await refuseSale(ctx, intent, args, "capacity_unavailable", {
					subject: `Paid checkout for "${intent.slug}" exceeded capacity`,
					text: `A late payment completed for checkout intent ${intent._id} after its capacity reservation ended. ${capacityBlockMessage(capacity.blockReason) ?? "No capacity remained."} Subscription ${args.polarSubscriptionId} is being revoked and its order refunded automatically in Polar.`
				});
			}
		}

		// This mutation only runs off order.paid, which is proof of payment, so a
		// lapsed reservation ("expired"/"released" without a box) still converts.
		// The slug is the product's identity: if it was taken while the payment
		// completed, the sale fails - the subscription is revoked and the order
		// refunded - rather than creating a box under a name the customer didn't
		// choose. Automatically; this is another initial-fulfillment failure, not a
		// support TODO.
		if (!(await isSlugAvailable(ctx, intent.slug, { intentId: intent._id }))) {
			return await refuseSale(ctx, intent, args, "slug_conflict", {
				subject: `Checkout for slug "${intent.slug}" could not be fulfilled`,
				text: `A payment completed for checkout intent ${intent._id} (user ${intent.user_id}), but slug "${intent.slug}" was taken before fulfillment. Subscription ${args.polarSubscriptionId} is being revoked and its order refunded automatically in Polar.`
			});
		}

		const timestamp = Date.now();
		const boxId = await insertBox(ctx, {
			user_id: intent.user_id,
			slug: intent.slug,
			plan: args.plan,
			manual_snapshot_cap: defaultManualSnapshotCap(args.plan),
			status: "creating",
			polar_customer_id: args.polarCustomerId,
			polar_subscription_id: args.polarSubscriptionId,
			runtime_image: args.runtimeImage,
			created_at: timestamp,
			updated_at: timestamp
		});

		await ctx.db.patch(intent._id, {
			status: "converted",
			polar_customer_id: args.polarCustomerId,
			polar_subscription_id: args.polarSubscriptionId,
			converted_at: timestamp,
			box_id: boxId,
			purge_at: billingRecordPurgeAt(timestamp),
			...terminalCheckoutSecretPatch(),
			updated_at: timestamp
		});
		await reconcileCapacityAlert(ctx);

		const box = await ctx.db.get(boxId);
		if (!box) throw new ConvexError("Box creation failed.");

		const operationId = await startBoxOperation(ctx, boxId, "create", {
			idempotencyKey: `create:${boxId}`,
			metadata: {
				[CHECKOUT_INTENT_METADATA_KEYS.intentId]: intent._id
			},
			trigger: "owner"
		});
		// Stryker disable next-line ConditionalExpression,StringLiteral: unreachable - the key names the box inserted two statements above, so no operation can already hold it. Kept because it is the assertion, not the handling: the alternative is returning a box nothing is building.
		if (!operationId)
			throw new ConvexError("Provision operation already exists.");

		await appendBoxEvent(ctx, box, boxEventType("create", "started"), {
			metadata: { operationId }
		});

		return { boxId, unfulfilled: null };
	}
});
