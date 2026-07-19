import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { mutation, query, type QueryCtx } from "../_generated/server";
import {
	findUserByClerkId,
	findUserByEmail,
	requireCapability
} from "../users";
import { isValidSlug, sanitizeSlug } from "../model/box/slug";

const STAFF_INTENT_LIST_LIMIT = 50;
const STAFF_INTENT_SEARCH_SCAN_LIMIT = 500;

async function usersByClerkIds(ctx: QueryCtx, clerkUserIds: Iterable<string>) {
	const users = new Map<string, Doc<"users">>();
	for (const clerkUserId of new Set(clerkUserIds)) {
		const user = await findUserByClerkId(ctx, clerkUserId);
		if (user) users.set(clerkUserId, user);
	}
	return users;
}

function addIntentCandidate(
	candidates: Map<
		Doc<"box_checkout_intents">["_id"],
		Doc<"box_checkout_intents">
	>,
	intent: Doc<"box_checkout_intents"> | null | undefined
) {
	if (intent?.status === "active") candidates.set(intent._id, intent);
}

function intentMatchesSearch(
	intent: Doc<"box_checkout_intents">,
	user: Doc<"users"> | undefined,
	term: string
) {
	return (
		intent.slug.includes(term) ||
		intent.user_id.toLowerCase().includes(term) ||
		(user?.email ?? "").toLowerCase().includes(term) ||
		(intent.polar_checkout_id ?? "").toLowerCase().includes(term)
	);
}

export const activeCheckoutIntents = query({
	args: {
		query: v.optional(v.string())
	},
	handler: async (ctx, args) => {
		await requireCapability(ctx, "staff_console");
		const rawTerm = (args.query ?? "").trim();
		const term = rawTerm.toLowerCase();
		const candidates = new Map<
			Doc<"box_checkout_intents">["_id"],
			Doc<"box_checkout_intents">
		>();

		const recentLimit = term
			? STAFF_INTENT_SEARCH_SCAN_LIMIT
			: STAFF_INTENT_LIST_LIMIT;
		const recent = await ctx.db
			.query("box_checkout_intents")
			.withIndex("status_created_at", (query) => query.eq("status", "active"))
			.order("desc")
			.take(recentLimit);
		for (const intent of recent) addIntentCandidate(candidates, intent);

		if (term) {
			const slug = sanitizeSlug(rawTerm);
			if (isValidSlug(slug)) {
				const slugIntents = await ctx.db
					.query("box_checkout_intents")
					.withIndex("slug_status", (query) =>
						query.eq("slug", slug).eq("status", "active")
					)
					.take(STAFF_INTENT_LIST_LIMIT);
				for (const intent of slugIntents)
					addIntentCandidate(candidates, intent);
			}

			addIntentCandidate(
				candidates,
				await ctx.db
					.query("box_checkout_intents")
					.withIndex("polar_checkout_id", (query) =>
						query.eq("polar_checkout_id", rawTerm)
					)
					.first()
			);

			const user = await findUserByEmail(ctx, term);
			const userIds = new Set([rawTerm]);
			if (user) userIds.add(user.clerk_user_id);
			for (const userId of userIds) {
				const userIntents = await ctx.db
					.query("box_checkout_intents")
					.withIndex("user_id_created_at", (query) =>
						query.eq("user_id", userId)
					)
					.order("desc")
					.take(STAFF_INTENT_LIST_LIMIT);
				for (const intent of userIntents) {
					addIntentCandidate(candidates, intent);
				}
			}
		}

		const intents = [...candidates.values()];
		const usersById = await usersByClerkIds(
			ctx,
			intents.map((intent) => intent.user_id)
		);

		return intents
			.filter((intent) => {
				if (!term) return true;
				const user = usersById.get(intent.user_id);
				return intentMatchesSearch(intent, user, term);
			})
			.sort((first, second) => second.created_at - first.created_at)
			.slice(0, STAFF_INTENT_LIST_LIMIT)
			.map((intent) => ({
				id: intent._id,
				userId: intent.user_id,
				userEmail: usersById.get(intent.user_id)?.email ?? "",
				slug: intent.slug,
				polarCheckoutId: intent.polar_checkout_id,
				polarCheckoutUrl: intent.polar_checkout_url,
				polarCheckoutStatus: intent.polar_checkout_status,
				expiresAt: intent.polar_checkout_expires_at,
				createdAt: intent.created_at
			}));
	}
});

export const releaseCheckoutIntent = mutation({
	args: {
		intentId: v.id("box_checkout_intents"),
		reason: v.string()
	},
	handler: async (ctx, args) => {
		await requireCapability(ctx, "checkout_management");
		await ctx.runMutation(
			internal.checkout.checkoutIntents.releaseCheckoutIntent,
			{
				intentId: args.intentId,
				reason: args.reason
			}
		);
	}
});
