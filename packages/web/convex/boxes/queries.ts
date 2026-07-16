import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalQuery, type QueryCtx } from "../_generated/server";
import { sanitizeSlug } from "../model/box/slug";
import { vBoxStatus } from "../schema";
import { boxStatusesExcept } from "../model/box/status";
import { suspensionReason } from "./retention";

// Resolve a (sanitized) slug to its box for query and mutation handlers. The
// owner and staff read paths all start here instead of repeating the index scan.
export async function findBoxBySlug(ctx: QueryCtx, slug: string) {
	return await ctx.db
		.query("boxes")
		.withIndex("slug_status", (query) => query.eq("slug", sanitizeSlug(slug)))
		.filter((query) => query.neq(query.field("status"), "deleted"))
		.first();
}

// The same resolution, narrowed to one owner. Every owner-facing entry point
// goes through here rather than comparing `user_id` itself, so "is this your
// box" is answered in one place - and answered the same way whether the caller
// then returns null, an empty list, or an error.
export async function findOwnedBoxBySlug(
	ctx: QueryCtx,
	userId: string,
	slug: string
) {
	const box = await findBoxBySlug(ctx, slug);
	return box && box.user_id === userId ? box : null;
}

// Which statuses a subscription is reconciled against: everything except a box
// that is already on its way out. Derived rather than spelled out so a new
// status is reconciled by default - a box silently skipped by reconciliation is
// a box whose billing state stops being checked.
//
// `delete_failed` is excluded for the same reason as `deleting`, not a different
// one: the box is already committed to deletion, so asking again what its
// subscription says cannot change the answer. Finishing that deletion is owned
// end-to-end by `finishFailedDeletions`, which handles comp boxes too - this
// sweep only ever reached the paid ones.
export const SUBSCRIPTION_RECONCILIATION_STATUSES = boxStatusesExcept(
	"deleting",
	"delete_failed",
	"deleted"
);

const SUBSCRIPTION_RECONCILIATION_PAGE_SIZE = 200;
const USER_SUSPENSION_BOX_PAGE_SIZE = 100;

// The reason recorded on a box's most recent suspend operation (box-level
// suspension keeps it in the operation metadata, not on the box row). Shared by
// the owner and staff box-detail queries.
export function hasCurrentSuspension(status: string) {
	return status === "suspending" || status === "suspended";
}

export async function currentSuspensionReason(
	ctx: QueryCtx,
	box: { _id: Id<"boxes">; status: string }
) {
	if (!hasCurrentSuspension(box.status)) return null;
	const operation = await ctx.db
		.query("box_operations")
		.withIndex("box_id_type_created_at", (builder) =>
			builder.eq("box_id", box._id).eq("type", "suspend")
		)
		.order("desc")
		.first();
	// The same narrowing the suspension email and the deletion tombstone use, not
	// a third copy of it: whether a reason is usable prose is one question, and
	// two answers to it is how one surface comes to show "[object Object]".
	return suspensionReason(operation?.metadata) ?? null;
}

export const boxIdBySubscription = internalQuery({
	args: {
		subscriptionId: v.string()
	},
	handler: async (ctx, args) => {
		const box = await ctx.db
			.query("boxes")
			.withIndex("polar_subscription_id", (query) =>
				query.eq("polar_subscription_id", args.subscriptionId)
			)
			.first();

		if (!box || box.status === "deleted") return null;
		return box._id;
	}
});

export const boxBySlug = internalQuery({
	args: {
		slug: v.string()
	},
	handler: async (ctx, args) => {
		return await findBoxBySlug(ctx, args.slug);
	}
});

export const boxByOwnerSlug = internalQuery({
	args: {
		slug: v.string(),
		userId: v.string()
	},
	handler: async (ctx, args) =>
		await findOwnedBoxBySlug(ctx, args.userId, args.slug)
});

export const getBoxLifecycleSnapshot = internalQuery({
	args: {
		boxId: v.id("boxes")
	},
	handler: async (ctx, args) => {
		const box = await ctx.db.get(args.boxId);
		if (!box) throw new Error("Box not found.");
		return box;
	}
});

export const boxesForUserStatusPage = internalQuery({
	args: {
		clerkUserId: v.string(),
		cursor: v.union(v.string(), v.null()),
		status: v.union(v.literal("running"), v.literal("suspended"))
	},
	handler: async (ctx, args) => {
		return await ctx.db
			.query("boxes")
			.withIndex("user_id_status", (query) =>
				query.eq("user_id", args.clerkUserId).eq("status", args.status)
			)
			.paginate({
				cursor: args.cursor,
				numItems: USER_SUSPENSION_BOX_PAGE_SIZE
			});
	}
});

export const boxesForSubscriptionReconciliationPage = internalQuery({
	args: {
		cursor: v.union(v.string(), v.null()),
		status: vBoxStatus
	},
	handler: async (ctx, args) => {
		return await ctx.db
			.query("boxes")
			.withIndex("status", (query) => query.eq("status", args.status))
			.paginate({
				cursor: args.cursor,
				numItems: SUBSCRIPTION_RECONCILIATION_PAGE_SIZE
			});
	}
});

// The same question asked of a snapshot: whose box does it belong to?
//
// A snapshot has no owner of its own - it belongs to whoever owns its box - so
// this resolves through `box_id` rather than comparing a copy of the owner kept
// on the row. The row used to keep one, written once at capture and never read;
// a copy like that is right until the day a box changes hands, and then it is
// authorization answering with yesterday's owner.
//
// Failing identically for a snapshot that does not exist and one that belongs to
// somebody else is the point of the shared message: the two must not be
// distinguishable from outside.
export async function requireOwnedSnapshot(
	ctx: QueryCtx,
	userId: string,
	snapshotRowId: Id<"box_snapshots">
) {
	const snapshot = await ctx.db.get(snapshotRowId);
	if (!snapshot) throw new ConvexError("Snapshot not found.");
	const box = await ctx.db.get(snapshot.box_id);
	if (!box || box.user_id !== userId) {
		throw new ConvexError("Snapshot not found.");
	}
	return { box, snapshot };
}

// Whether this box is one the caller may be shown at all. The narrowest read
// gate there is, and a type predicate so a caller that passes it stops holding a
// nullable box. Deliberately beside the two resolvers above: "which box is
// this" and "may they see it" are one question asked twice, and they were in two
// files, one of which held nothing else.
export function ownerCanReadBox<T extends { status: string; user_id: string }>(
	box: T | null,
	userId: string
): box is T {
	return box !== null && box.user_id === userId && box.status !== "deleted";
}
