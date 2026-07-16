import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { isValidSlug } from "../model/box/slug";
import { boxStatusesExcept } from "../model/box/status";
import { ACTIVE_OPERATION_STATUSES } from "../model/box/operation";

type ReadCtx = { db: DatabaseReader };

// "deleted" is the only status excluded, so a slug frees up once its box is
// gone but stays reserved through every active, failed, or suspended state.
export const SLUG_OCCUPYING_STATUSES: readonly Doc<"boxes">["status"][] =
	boxStatusesExcept("deleted");

async function activeBoxWithSlug(
	ctx: ReadCtx,
	slug: string,
	ignoreBoxId?: Id<"boxes">
) {
	for (const status of SLUG_OCCUPYING_STATUSES) {
		const matches = await ctx.db
			.query("boxes")
			.withIndex("slug_status", (query) =>
				query.eq("slug", slug).eq("status", status)
			)
			.take(2);
		const match = matches.find((box) => box._id !== ignoreBoxId);
		if (match) return match;
	}

	return null;
}

async function activeIntentWithSlug(
	ctx: ReadCtx,
	slug: string,
	ignoreIntentId?: Id<"box_checkout_intents">
) {
	const intent = await ctx.db
		.query("box_checkout_intents")
		.withIndex("slug_status", (query) =>
			query.eq("slug", slug).eq("status", "active")
		)
		.first();

	return intent && intent._id !== ignoreIntentId ? intent : null;
}

async function activeSlugOperation(
	ctx: ReadCtx,
	slug: string,
	ignoreOperationId?: Id<"box_operations">
) {
	// The same list every other reader of "is this operation still going" asks,
	// rather than the two literals this spelled out: an active status added to
	// that table but not pasted in here would be an operation holding a slug
	// nothing could see it holding.
	for (const status of ACTIVE_OPERATION_STATUSES) {
		const matches = await ctx.db
			.query("box_operations")
			.withIndex("reserved_slug_status", (query) =>
				query.eq("reserved_slug", slug).eq("status", status)
			)
			.take(2);
		const match = matches.find(
			(operation) => operation._id !== ignoreOperationId
		);
		if (match) return match;
	}

	return null;
}

// What already holds this slug that the caller is allowed to be. One shape for
// both readers, because "is it free" and "insist it is free" must never disagree
// about who is asking - a caller that could name the box it is renaming but not
// the reservation it is resuming would refuse that caller their own slug.
//
// `operationId` is that reservation, and it was the missing one. A slug change
// starts by writing `reserved_slug` on its own operation row, so by the time the
// workflow reached `swapSlug` to commit the rename, the only thing standing
// between the box and its new slug was the operation performing the rename.
// Every slug change failed on its last mutation, after the DNS records were
// created and the proxy reloaded - the owner saw "The slug change did not
// finish" and a box still on its old slug.
export type SlugHolder = {
	boxId?: Id<"boxes">;
	intentId?: Id<"box_checkout_intents">;
	operationId?: Id<"box_operations">;
};

export async function isSlugAvailable(
	ctx: ReadCtx,
	slug: string,
	ignore?: SlugHolder
): Promise<boolean> {
	if (!isValidSlug(slug)) return false;
	if (await activeBoxWithSlug(ctx, slug, ignore?.boxId)) return false;
	if (await activeIntentWithSlug(ctx, slug, ignore?.intentId)) return false;
	if (await activeSlugOperation(ctx, slug, ignore?.operationId)) return false;
	return true;
}

export async function assertSlugAvailable(
	ctx: ReadCtx,
	slug: string,
	ignore?: SlugHolder
) {
	if (!(await isSlugAvailable(ctx, slug, ignore))) {
		throw new ConvexError("Slug is unavailable.");
	}
}
