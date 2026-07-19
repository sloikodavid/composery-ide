import { ConvexError, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import {
	internalMutation,
	internalQuery,
	type MutationCtx
} from "../_generated/server";
import { assertSlugAvailable } from "../boxes/slugAvailability";
import {
	billingRecordPurgeAt,
	terminalCheckoutSecretPatch,
	unpaidCheckoutPurgeAt
} from "../boxes/retention";
import { readGlobalSettings } from "../settings";
import { MAX_ACTIVE_CHECKOUT_INTENTS_PER_USER } from "../model/settings";
import { LEGAL_VERSION } from "../model/legal";
import { capacityBlockMessage, readCapacityUsage } from "../boxes/capacity";
import { reconcileCapacityAlert } from "../boxes/capacity";
import { vBoxPlan } from "../schema";
import { HOUR_MS } from "../time";

// Polar checkout metadata keys. Set when creating a checkout and read back from
// paid orders to reconnect a completed payment to the reserved intent.
export const CHECKOUT_INTENT_METADATA_KEYS = {
	// What the pricing page was set to when the session was opened, not what was
	// bought: Polar checkout offers every product and the customer may switch
	// either axis. Both are analytics only - the sold plan is the order's product
	// and the sold interval is the subscription's recurringInterval. The live
	// selection is on the reservation's own `plan`, which follows the checkout.
	selectedBillingInterval: "composery_selected_billing_interval",
	selectedPlan: "composery_selected_plan",
	intentId: "composery_checkout_intent_id",
	slug: "composery_box_slug",
	userId: "composery_clerk_user_id"
} as const;

// How long a reservation holds its slug and capacity before a Polar checkout is
// attached to it.
//
// Only the crash window: `createCheckout` releases the reservation itself when
// Polar refuses, so this is the floor under the action dying between reserving
// and attaching. Once a checkout exists, the reservation runs to that checkout's
// expiry - Polar sets it and its API offers no way to choose it, so this is not
// the reservation's lifetime and must not be documented as one.
// window: Unattached checkout reservation
export const CHECKOUT_ATTACH_GRACE_MS = HOUR_MS;

export function paidOrderRecordingStatus(
	intent: Pick<
		Doc<"box_checkout_intents">,
		| "box_id"
		| "polar_checkout_id"
		| "polar_initial_order_id"
		| "polar_subscription_id"
	> | null,
	args: { checkoutId: string; orderId: string; subscriptionId: string }
) {
	if (!intent) return "missing" as const;
	if (
		intent.polar_checkout_id &&
		intent.polar_checkout_id !== args.checkoutId
	) {
		return "checkout_mismatch" as const;
	}
	if (
		(intent.polar_initial_order_id &&
			intent.polar_initial_order_id !== args.orderId) ||
		(intent.polar_subscription_id &&
			intent.polar_subscription_id !== args.subscriptionId)
	) {
		return "order_mismatch" as const;
	}
	if (intent.box_id) return "already_fulfilled" as const;
	return "recorded" as const;
}

// How many of a user's oldest active reservations must yield so a new one fits
// under the cap. Zero while there is room.
export function reservationsToRelease(activeCount: number, cap: number) {
	if (
		!Number.isInteger(activeCount) ||
		activeCount < 0 ||
		activeCount > MAX_ACTIVE_CHECKOUT_INTENTS_PER_USER
	) {
		throw new RangeError("Active checkout reservation count is out of bounds");
	}
	if (
		!Number.isInteger(cap) ||
		cap < 1 ||
		cap > MAX_ACTIVE_CHECKOUT_INTENTS_PER_USER
	) {
		throw new RangeError("Checkout reservation limit is out of bounds");
	}
	return Math.max(0, activeCount - cap + 1);
}

// Every terminal transition of an unpaid intent looks the same: stop holding the
// slug and capacity, keep why, and schedule the purge. Exported because account
// deletion ends reservations too, and a second hand-written copy of this patch
// is how one of them ends up keeping a slug or missing a purge date.
export async function releaseIntentDoc(
	ctx: MutationCtx,
	intent: Doc<"box_checkout_intents">,
	release: {
		polarCheckoutStatus?: string;
		reason: string;
		status: "expired" | "released";
	}
) {
	const timestamp = Date.now();
	await ctx.db.patch(intent._id, {
		status: release.status,
		polar_checkout_status: release.polarCheckoutStatus,
		released_at: timestamp,
		release_reason: release.reason,
		purge_at: unpaidCheckoutPurgeAt(timestamp),
		...terminalCheckoutSecretPatch(),
		updated_at: timestamp
	});
}

// The Polar session a reservation can still be sent back to, and why not when
// there is none.
//
// Polar decides all three answers and none of them is negotiable: a checkout's
// product list is fixed at creation, a checkout cannot be voided, and a checkout
// past its expiry or already confirmed cannot be updated. So the only honest
// question is whether the stored session is still open and unpaid - anything
// else needs a session this reservation does not have yet.
//
// "paid" is kept apart from "none" deliberately. Both lack a session to reuse,
// but one of them must never be given a second one: the customer has already
// been charged, the order webhook is on its way, and opening another checkout
// against the same reservation is how they get charged twice for one slug.
export function checkoutResumption(
	intent: Pick<
		Doc<"box_checkout_intents">,
		| "polar_checkout_expires_at"
		| "polar_checkout_id"
		| "polar_checkout_url"
		| "polar_initial_order_id"
	>,
	now: number
) {
	if (intent.polar_initial_order_id) return { type: "paid" } as const;
	if (!intent.polar_checkout_id || !intent.polar_checkout_url) {
		return { type: "none" } as const;
	}
	// An expired session is unusable and unpayable, so replacing it strands
	// nothing. This is the same instant the sweep reads, so a reservation cannot
	// be resumable here and expired there.
	if ((intent.polar_checkout_expires_at ?? 0) <= now) {
		return { type: "none" } as const;
	}
	return {
		type: "session",
		checkoutId: intent.polar_checkout_id,
		checkoutUrl: intent.polar_checkout_url
	} as const;
}

// Point a reservation at the plan its Polar checkout now sells.
//
// The reservation's plan is what capacity admission counts snapshot slots
// against, so it has to follow the checkout rather than lead it - the visitor
// can change the selection from either pricing card or inside Polar's own
// checkout, and only Polar knows which product is selected now. Writing it here,
// after Polar has accepted the selection, is what keeps the row from claiming a
// plan the session cannot sell.
export async function applyCheckoutPlan(
	ctx: MutationCtx,
	intent: Doc<"box_checkout_intents">,
	plan: Doc<"box_checkout_intents">["plan"]
) {
	if (intent.plan === plan) return;
	await ctx.db.patch(intent._id, { plan, updated_at: Date.now() });
	await reconcileCapacityAlert(ctx);
}

// Reserve this user's slug, or hand back the reservation they already hold for
// it.
//
// One mutation for both, because the caller cannot tell them apart without
// racing: a reservation whose Polar session was never attached - the action died
// between reserving and attaching - is invisible to any "do I have a live
// checkout" question, and reserving again then reports the user's own slug as
// unavailable and locks them out of it until the grace expires. Resuming here
// makes that unrepresentable rather than guarded against.
//
// `checkout` is the Polar session to send them back to, or null when this
// reservation still needs one.
export const reserveCheckoutIntent = internalMutation({
	args: {
		plan: vBoxPlan,
		slug: v.string(),
		userId: v.string()
	},
	handler: async (ctx, args) => {
		const held = await ctx.db
			.query("box_checkout_intents")
			.withIndex("user_id_slug_status", (query) =>
				query
					.eq("user_id", args.userId)
					.eq("slug", args.slug)
					.eq("status", "active")
			)
			.first();
		// The caller's own reservation is the one thing that must not read as
		// taken - they are the person it is being held for.
		await assertSlugAvailable(ctx, args.slug, { intentId: held?._id });

		if (held) {
			// A reservation is held per slug, not per plan, so a visitor who reopens
			// checkout from the other card resumes this one. Capacity is not re-asked:
			// this reservation already holds a server and its snapshot slots, and
			// refusing a visitor their own open checkout because the fleet filled up
			// since would abandon a commitment already made.
			//
			// The plan is deliberately not written here. It used to be, before the
			// caller had asked Polar for anything, which left the row claiming a plan
			// its live checkout could not sell whenever Polar then refused - and the
			// resume path has no rollback to undo it with. It is written once Polar
			// has accepted the selection, by `recordCheckoutPlan` or by
			// `attachPolarCheckout`, so the row and the session change together.
			return {
				intentId: held._id,
				resumption: checkoutResumption(held, Date.now())
			};
		}

		const settings = await readGlobalSettings(ctx);
		const capacity = await readCapacityUsage(ctx, settings);
		if (!capacity.checkoutAvailable) {
			throw new ConvexError(
				capacityBlockMessage(capacity.blockReason) ??
					"New box checkout is temporarily unavailable."
			);
		}

		// A user reserving a slug removes it from everyone else's namespace and
		// commits one complete infrastructure package until checkout converts or
		// lapses. The per-user cap bounds how many a user holds at once; it is not a
		// limit on paid boxes, and reaching it does not block the sale. Nothing lets
		// a user cancel a reservation, and an abandoned one is exactly what the cap
		// exists to reclaim, so the oldest yields to the new one. Payment arriving
		// late on a released intent still converts or refunds, as when the expiry
		// sweep releases it.
		const cap = settings.maxActiveCheckoutIntentsPerUser;
		const active = await ctx.db
			.query("box_checkout_intents")
			.withIndex("user_id_status", (query) =>
				query.eq("user_id", args.userId).eq("status", "active")
			)
			.take(MAX_ACTIVE_CHECKOUT_INTENTS_PER_USER + 1);
		// Index order is oldest first, so these are the stalest reservations. A cap
		// lowered below the live count is enforced before the replacement is added.
		for (const stale of active.slice(
			0,
			reservationsToRelease(active.length, cap)
		)) {
			await releaseIntentDoc(ctx, stale, {
				reason: "superseded_by_new_reservation",
				status: "released"
			});
		}

		const timestamp = Date.now();
		const intentId = await ctx.db.insert("box_checkout_intents", {
			user_id: args.userId,
			slug: args.slug,
			plan: args.plan,
			status: "active",
			polar_checkout_expires_at: timestamp + CHECKOUT_ATTACH_GRACE_MS,
			created_at: timestamp,
			updated_at: timestamp
		});
		await reconcileCapacityAlert(ctx);
		return { intentId, resumption: { type: "none" } as const };
	}
});

// Bind a Polar session to a reservation, together with the plan that session was
// opened selling. One patch for both, because a row naming a session and a plan
// that disagree is the state this whole path exists to prevent.
export const attachPolarCheckout = internalMutation({
	args: {
		checkoutId: v.string(),
		checkoutStatus: v.optional(v.string()),
		checkoutUrl: v.string(),
		expiresAt: v.number(),
		intentId: v.id("box_checkout_intents"),
		plan: vBoxPlan,
		polarCustomerId: v.optional(v.string())
	},
	handler: async (ctx, args) => {
		await ctx.db.patch(args.intentId, {
			plan: args.plan,
			polar_checkout_id: args.checkoutId,
			polar_checkout_url: args.checkoutUrl,
			polar_checkout_status: args.checkoutStatus,
			polar_checkout_expires_at: args.expiresAt,
			polar_customer_id: args.polarCustomerId,
			updated_at: Date.now()
		});
		// The plan can differ from the one the row was inserted with: a reservation
		// whose session had expired gets a new one for whatever is being bought now.
		// Reconciled unconditionally rather than on a comparison, because the
		// comparison is only ever false on the path that just wrote the same value.
		await reconcileCapacityAlert(ctx);
	}
});

// The reservation follows a selection Polar has already accepted: the visitor
// reopened checkout from the other pricing card, or changed the product inside
// Polar's own checkout and the `checkout.updated` webhook said so.
export const recordCheckoutPlan = internalMutation({
	args: {
		intentId: v.id("box_checkout_intents"),
		plan: vBoxPlan
	},
	handler: async (ctx, args) => {
		const intent = await ctx.db.get(args.intentId);
		if (!intent || intent.status !== "active" || intent.box_id) return;
		await applyCheckoutPlan(ctx, intent, args.plan);
	}
});

// The same move, reached from a webhook that knows the checkout but not the
// reservation.
export const recordCheckoutPlanByPolarCheckout = internalMutation({
	args: {
		checkoutId: v.string(),
		plan: vBoxPlan
	},
	handler: async (ctx, args) => {
		const intent = await ctx.db
			.query("box_checkout_intents")
			.withIndex("polar_checkout_id", (query) =>
				query.eq("polar_checkout_id", args.checkoutId)
			)
			.first();
		if (!intent || intent.status !== "active" || intent.box_id) return;
		await applyCheckoutPlan(ctx, intent, args.plan);
	}
});

export const releaseCheckoutIntent = internalMutation({
	args: {
		intentId: v.id("box_checkout_intents"),
		polarCheckoutStatus: v.optional(v.string()),
		reason: v.string()
	},
	handler: async (ctx, args) => {
		const intent = await ctx.db.get(args.intentId);
		if (!intent || intent.status !== "active" || intent.box_id) return false;

		await releaseIntentDoc(ctx, intent, {
			polarCheckoutStatus: args.polarCheckoutStatus,
			reason: args.reason,
			status: "released"
		});
		await reconcileCapacityAlert(ctx);

		return true;
	}
});

// The same transition, reached from a Polar webhook that knows the checkout but
// not the intent. The terminal status is stated by the caller rather than
// inferred from `reason`: a free-form string deciding stored state means a
// reworded reason silently changes what the row says happened.
export const releaseCheckoutIntentByPolarCheckout = internalMutation({
	args: {
		checkoutId: v.string(),
		polarCheckoutStatus: v.optional(v.string()),
		reason: v.string(),
		status: v.union(v.literal("expired"), v.literal("released"))
	},
	handler: async (ctx, args) => {
		const intent = await ctx.db
			.query("box_checkout_intents")
			.withIndex("polar_checkout_id", (query) =>
				query.eq("polar_checkout_id", args.checkoutId)
			)
			.first();

		if (!intent || intent.status !== "active" || intent.box_id) return false;

		await releaseIntentDoc(ctx, intent, {
			polarCheckoutStatus: args.polarCheckoutStatus,
			reason: args.reason,
			status: args.status
		});
		await reconcileCapacityAlert(ctx);

		return true;
	}
});

export const checkoutIntentIdByPolarCheckout = internalQuery({
	args: { checkoutId: v.string() },
	handler: async (ctx, args) => {
		const intent = await ctx.db
			.query("box_checkout_intents")
			.withIndex("polar_checkout_id", (query) =>
				query.eq("polar_checkout_id", args.checkoutId)
			)
			.first();

		return intent?._id ?? null;
	}
});

export const checkoutIntentIdFromString = internalQuery({
	args: { intentId: v.string() },
	handler: async (ctx, args) => {
		// Webhook metadata is untrusted text. Invalid ids resolve to null instead
		// of making Polar retry the webhook forever on a validation error.
		const intentId = ctx.db.normalizeId("box_checkout_intents", args.intentId);
		if (!intentId) return null;
		return (await ctx.db.get(intentId)) ? intentId : null;
	}
});

// Store the paid order before provisioning. It is the order refunded if the
// initial service cannot be delivered, and `terms_accepted_at` dates the
// supplier-Terms checkbox Polar checkout collected - the webhook refuses an
// order without it before reaching here, so this only records when it happened.
export const recordInitialPaidOrder = internalMutation({
	args: {
		checkoutId: v.string(),
		customerId: v.string(),
		intentId: v.id("box_checkout_intents"),
		orderId: v.string(),
		subscriptionId: v.string(),
		termsAcceptedAt: v.number()
	},
	handler: async (ctx, args) => {
		const intent = await ctx.db.get(args.intentId);
		// Payment may legitimately arrive after the local/Polar expiry event. Keep
		// its billing evidence on any unconverted intent; conversion will atomically
		// reacquire capacity and the slug or refund it as unfulfilled.
		if (!intent) return "missing" as const;
		const recordingStatus = paidOrderRecordingStatus(intent, args);
		if (recordingStatus !== "recorded") return recordingStatus;
		const timestamp = Date.now();
		await ctx.db.patch(intent._id, {
			polar_checkout_id: intent.polar_checkout_id ?? args.checkoutId,
			polar_customer_id: args.customerId,
			polar_subscription_id: args.subscriptionId,
			polar_initial_order_id: intent.polar_initial_order_id ?? args.orderId,
			terms_accepted_at: intent.terms_accepted_at ?? args.termsAcceptedAt,
			terms_version: intent.terms_version ?? LEGAL_VERSION,
			purge_at: billingRecordPurgeAt(timestamp),
			updated_at: timestamp
		});

		return "recorded" as const;
	}
});

export const paidOrderForBox = internalQuery({
	args: { boxId: v.id("boxes") },
	handler: async (ctx, args) => {
		const intent = await ctx.db
			.query("box_checkout_intents")
			.withIndex("box_id", (query) => query.eq("box_id", args.boxId))
			.first();
		if (!intent?.polar_initial_order_id || !intent.polar_subscription_id) {
			return null;
		}
		return {
			orderId: intent.polar_initial_order_id,
			subscriptionId: intent.polar_subscription_id
		};
	}
});

export const releaseExpiredCheckoutIntents = internalMutation({
	args: {},
	handler: async (ctx) => {
		const timestamp = Date.now();
		const expired = await ctx.db
			.query("box_checkout_intents")
			.withIndex("status_expires", (query) =>
				query
					.eq("status", "active")
					.gt("polar_checkout_expires_at", 0)
					.lte("polar_checkout_expires_at", timestamp)
			)
			.take(100);

		for (const intent of expired) {
			await releaseIntentDoc(ctx, intent, {
				reason: "checkout_expired_sweep",
				status: "expired"
			});
		}
		if (expired.length > 0) await reconcileCapacityAlert(ctx);

		return expired.length;
	}
});
