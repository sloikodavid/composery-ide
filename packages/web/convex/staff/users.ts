import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { action, internalMutation } from "../_generated/server";
import { sendAccountNotice } from "../notice/account";
import { startBoxSuspension } from "../boxes/operation/start";
import {
	findUserByClerkId,
	isInternalRole,
	requireCapabilityInAction
} from "../users";

const USER_BOX_ACTION_FAILURE_EXAMPLES = 5;

export const setUserSuspension = internalMutation({
	args: {
		callerClerkUserId: v.string(),
		clerkUserId: v.string(),
		reason: v.optional(v.string()),
		suspended: v.boolean()
	},
	handler: async (ctx, args) => {
		const user = await findUserByClerkId(ctx, args.clerkUserId);

		if (!user) throw new ConvexError("User not found.");

		// Suspension moderates customers, not staff. Blocking it stops a self-
		// lockout and one admin disabling another.
		if (args.suspended) {
			if (user.clerk_user_id === args.callerClerkUserId) {
				throw new ConvexError("You cannot suspend your own account.");
			}
			if (isInternalRole(user.role)) {
				throw new ConvexError("Staff accounts cannot be suspended.");
			}
		}

		await ctx.db.patch(user._id, {
			suspended: args.suspended,
			suspended_reason: args.suspended ? args.reason : undefined,
			suspended_at: args.suspended ? Date.now() : undefined,
			updated_at: Date.now()
		});

		// Told once, when it actually changes.
		//
		// Gated on the previous value rather than sent unconditionally, because this
		// mutation is idempotent by design - the console re-suspends an already
		// suspended account without complaint, and the sweep-like retries around it
		// mean the same call can legitimately arrive twice. An email is the one
		// effect here that a person notices, so re-sending it turns a harmless
		// no-op into "Composery suspended my account again".
		//
		// `user` is the row as it was before the patch above, which is what makes
		// the comparison possible; nothing this email reads from it was changed.
		if (user.suspended !== args.suspended) {
			await sendAccountNotice(
				ctx,
				user,
				args.suspended
					? { type: "suspended", reason: args.reason?.trim() || undefined }
					: { type: "unsuspended" }
			);
		}
	}
});

export const setUserSuspended = action({
	args: {
		clerkUserId: v.string(),
		reason: v.optional(v.string()),
		suspended: v.boolean()
	},
	handler: async (ctx, args) => {
		const staffUser = await requireCapabilityInAction(ctx, "user_moderation");
		await ctx.runMutation(internal.staff.users.setUserSuspension, {
			callerClerkUserId: staffUser.clerk_user_id,
			clerkUserId: args.clerkUserId,
			reason: args.reason,
			suspended: args.suspended
		});

		const failures: string[] = [];
		let failureCount = 0;
		let cursor: string | null = null;
		const status = args.suspended ? "running" : "suspended";

		for (;;) {
			const page: {
				continueCursor: string;
				isDone: boolean;
				page: Doc<"boxes">[];
			} = await ctx.runQuery(internal.boxes.queries.boxesForUserStatusPage, {
				clerkUserId: args.clerkUserId,
				cursor,
				status
			});

			for (const box of page.page) {
				await startBoxSuspension(ctx, {
					boxId: box._id,
					idempotencyKeyPrefix: args.suspended
						? "user-suspend"
						: "user-unsuspend",
					reason: args.suspended ? args.reason : undefined,
					suspend: args.suspended,
					trigger: "staff"
				}).catch((error) => {
					failureCount += 1;
					if (failures.length < USER_BOX_ACTION_FAILURE_EXAMPLES) {
						failures.push(
							`${box.slug}: ${error instanceof Error ? error.message : String(error)}`
						);
					}
				});
			}

			if (page.isDone) break;
			cursor = page.continueCursor;
		}

		if (failureCount > 0) {
			const omitted = failureCount - failures.length;
			throw new ConvexError(
				`User suspension updated, but ${failureCount} box action(s) failed: ${failures.join("; ")}${omitted > 0 ? `; ${omitted} more` : ""}`
			);
		}
	}
});
