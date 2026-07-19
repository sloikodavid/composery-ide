import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import {
	internalAction,
	internalMutation,
	internalQuery,
	type ActionCtx
} from "../_generated/server";
import { revokePolarSubscription } from "../billing/polar";
import { startBoxOperation } from "../boxes/operation/start";
import { reconcileCapacityAlert } from "../boxes/capacity";
import {
	billingRecordPurgeAt,
	deletedCheckoutSlug,
	terminalCheckoutSecretPatch
} from "../boxes/retention";
import { releaseIntentDoc } from "../checkout/checkoutIntents";
import { findUserByClerkId } from "../users";
import {
	accountDeletionBoxTargets,
	accountDeletionReady,
	boxDeletionIdempotencyKey,
	scrubbedAccountEmail,
	scrubbedUserId
} from "./deletionLogic";
import { DAY_MS, MINUTE_MS } from "../time";

const ACCOUNT_DELETION_FINALIZER_DELAY_MS = 15 * MINUTE_MS;
const ACCOUNT_DELETION_PAGE_SIZE = 100;
const ACCOUNT_PURGE_RETRY_MS = DAY_MS;
// Exported only because the Fixed windows table states it: `// window:` binds
// the number in the doc to this constant, and the test that pins the pair reads
// the exported value.
// window: Stuck account-deletion alert
export const ACCOUNT_DELETION_ALERT_AFTER_MS = DAY_MS;

type DeletionState = {
	boxes: Doc<"boxes">[];
	user: Doc<"users"> | null;
};

async function stateForClerkUser(
	ctx: Pick<ActionCtx, "runQuery">,
	clerkUserId: string
): Promise<DeletionState> {
	return await ctx.runQuery(internal.account.deletion.accountDeletionState, {
		clerkUserId
	});
}

async function startDeletionWorkflows(ctx: ActionCtx, boxes: Doc<"boxes">[]) {
	for (const box of accountDeletionBoxTargets(boxes)) {
		// Comp boxes have no subscription to revoke; deletion still tears down the
		// server.
		if (box.polar_subscription_id) {
			await revokePolarSubscription(box.polar_subscription_id);
		}

		try {
			await startBoxOperation(ctx, box._id, "delete", {
				idempotencyKey: boxDeletionIdempotencyKey(box),
				trigger: "system:account_deletion"
			});
		} catch {
			// The finalizer retries busy boxes until the normal operation gate opens.
		}
	}
}

async function scheduleFinalizer(
	ctx: Pick<ActionCtx, "runMutation">,
	clerkUserId: string,
	delayMs = ACCOUNT_DELETION_FINALIZER_DELAY_MS
) {
	await ctx.runMutation(
		internal.account.deletion.scheduleAccountDeletionFinalizer,
		{
			clerkUserId,
			delayMs
		}
	);
}

export const accountDeletionState = internalQuery({
	args: {
		clerkUserId: v.string()
	},
	handler: async (ctx, args): Promise<DeletionState> => {
		const user = await findUserByClerkId(ctx, args.clerkUserId);

		const boxes = await ctx.db
			.query("boxes")
			.withIndex("user_id_created_at", (query) =>
				query.eq("user_id", args.clerkUserId)
			)
			.collect();

		return { boxes, user };
	}
});

export const pendingAccountDeletionsPage = internalQuery({
	args: {
		cursor: v.union(v.string(), v.null())
	},
	handler: async (ctx, args) => {
		return await ctx.db
			.query("users")
			.withIndex("deletion_pending", (query) =>
				query.eq("deletion_pending", true)
			)
			.paginate({
				cursor: args.cursor,
				numItems: ACCOUNT_DELETION_PAGE_SIZE
			});
	}
});

export const markAccountDeletionPending = internalMutation({
	args: {
		clerkUserId: v.string()
	},
	handler: async (ctx, args) => {
		const user = await findUserByClerkId(ctx, args.clerkUserId);

		if (!user) return null;
		if (user.deletion_finished_at) return user._id;

		const timestamp = Date.now();
		if (!user.deletion_pending) {
			await ctx.db.patch(user._id, {
				deletion_pending: true,
				deletion_requested_at: timestamp,
				updated_at: timestamp
			});
		}

		// Release any open checkout reservation right away: a payment completing
		// after this point must not convert into a box owned by a deleted
		// account, and the slug should free up immediately.
		const intents = await ctx.db
			.query("box_checkout_intents")
			.withIndex("user_id_created_at", (query) =>
				query.eq("user_id", args.clerkUserId)
			)
			.collect();
		for (const intent of intents) {
			if (intent.status !== "active" || intent.box_id) continue;
			await releaseIntentDoc(ctx, intent, {
				reason: "account_deleted",
				status: "released"
			});
		}
		await reconcileCapacityAlert(ctx);

		return user._id;
	}
});

export const scheduleAccountDeletionFinalizer = internalMutation({
	args: {
		clerkUserId: v.string(),
		delayMs: v.number()
	},
	handler: async (ctx, args) => {
		await ctx.scheduler.runAfter(
			args.delayMs,
			internal.account.deletion.finalizeAccountDeletion,
			{ clerkUserId: args.clerkUserId }
		);
	}
});

export const finishAccountDeletion = internalMutation({
	args: {
		clerkUserId: v.string()
	},
	handler: async (ctx, args) => {
		const user = await findUserByClerkId(ctx, args.clerkUserId);
		if (!user || !user.deletion_pending || user.deletion_finished_at) return;

		const timestamp = Date.now();
		const deletedUserId = scrubbedUserId(user._id);
		const intents = await ctx.db
			.query("box_checkout_intents")
			.withIndex("user_id_created_at", (query) =>
				query.eq("user_id", args.clerkUserId)
			)
			.collect();

		for (const intent of intents) {
			await ctx.db.patch(intent._id, {
				user_id: deletedUserId,
				slug: deletedCheckoutSlug(intent._id),
				...terminalCheckoutSecretPatch(),
				updated_at: timestamp
			});
		}
		await ctx.scheduler.runAfter(
			0,
			internal.account.deletion.pseudonymizeDeletedAccountRecords,
			{
				deletedUserId,
				deletedEmail: scrubbedAccountEmail(user._id),
				clerkUserId: args.clerkUserId
			}
		);

		await ctx.db.patch(user._id, {
			clerk_user_id: deletedUserId,
			email: scrubbedAccountEmail(user._id),
			role: "user",
			suspended: true,
			suspended_reason: undefined,
			deletion_pending: false,
			deletion_finished_at: timestamp,
			purge_at: billingRecordPurgeAt(timestamp),
			updated_at: timestamp
		});
	}
});

export const purgeExpiredDeletedAccounts = internalMutation({
	args: {},
	handler: async (ctx) => {
		const timestamp = Date.now();
		const users = await ctx.db
			.query("users")
			// purge_at is optional and Convex orders a missing field below every
			// number, so a bare lte() also selects every account that never had
			// one - that is, every live account. Bound the range from below.
			.withIndex("purge_at", (query) =>
				query.gte("purge_at", 0).lte("purge_at", timestamp)
			)
			.take(ACCOUNT_DELETION_PAGE_SIZE);

		for (const user of users) {
			// Only a finished deletion may be purged. A live account carrying a
			// purge_at is stray state, so clear it instead of sweeping it.
			if (!user.deletion_finished_at) {
				await ctx.db.patch(user._id, {
					purge_at: undefined,
					updated_at: timestamp
				});
				continue;
			}
			// Every table that can still point at this account. The tombstone exists
			// only to keep those pointers meaningful, so it outlives the last one and
			// not a day longer - which is also exactly what the Privacy Policy says
			// happens, and a table missing from this list is that sentence quietly
			// becoming untrue.
			const [box, intent, event, notice] = await Promise.all([
				ctx.db
					.query("boxes")
					.withIndex("user_id_created_at", (query) =>
						query.eq("user_id", user.clerk_user_id)
					)
					.first(),
				ctx.db
					.query("box_checkout_intents")
					.withIndex("user_id_created_at", (query) =>
						query.eq("user_id", user.clerk_user_id)
					)
					.first(),
				ctx.db
					.query("box_events")
					.withIndex("user_id", (query) =>
						query.eq("user_id", user.clerk_user_id)
					)
					.first(),
				ctx.db
					.query("legal_notice_recipients")
					.withIndex("user_id", (query) =>
						query.eq("user_id", user.clerk_user_id)
					)
					.first()
			]);

			if (box || intent || event || notice) {
				await ctx.db.patch(user._id, {
					purge_at: timestamp + ACCOUNT_PURGE_RETRY_MS,
					updated_at: timestamp
				});
				continue;
			}
			await ctx.db.delete(user._id);
		}

		if (users.length === ACCOUNT_DELETION_PAGE_SIZE) {
			await ctx.scheduler.runAfter(
				0,
				internal.account.deletion.purgeExpiredDeletedAccounts,
				{}
			);
		}
	}
});

export const pseudonymizeDeletedAccountRecords = internalMutation({
	args: {
		clerkUserId: v.string(),
		deletedEmail: v.string(),
		deletedUserId: v.string()
	},
	handler: async (ctx, args) => {
		const boxes = await ctx.db
			.query("boxes")
			.withIndex("user_id_created_at", (query) =>
				query.eq("user_id", args.clerkUserId)
			)
			.take(ACCOUNT_DELETION_PAGE_SIZE);
		const events = await ctx.db
			.query("box_events")
			.withIndex("user_id", (query) => query.eq("user_id", args.clerkUserId))
			.take(ACCOUNT_DELETION_PAGE_SIZE);
		const notices = await ctx.db
			.query("legal_notice_recipients")
			.withIndex("user_id", (query) => query.eq("user_id", args.clerkUserId))
			.take(ACCOUNT_DELETION_PAGE_SIZE);

		for (const box of boxes) {
			await ctx.db.patch(box._id, { user_id: args.deletedUserId });
		}
		for (const event of events) {
			await ctx.db.patch(event._id, { user_id: args.deletedUserId });
		}
		// A notice record loses the address but keeps the fact. Both halves are
		// deliberate: the address is personal data this person asked us to erase,
		// while "the account holder was told, on this date, and it was delivered"
		// is the evidence that we discharged an obligation owed to them - kept for
		// the same six years, and for the same reason, as the billing record beside
		// it. Erasure under Article 17 GDPR does not reach a record retained for
		// the establishment or defence of legal claims, and this is one.
		for (const notice of notices) {
			await ctx.db.patch(notice._id, {
				user_id: args.deletedUserId,
				email: args.deletedEmail
			});
		}

		if (
			boxes.length === ACCOUNT_DELETION_PAGE_SIZE ||
			events.length === ACCOUNT_DELETION_PAGE_SIZE ||
			notices.length === ACCOUNT_DELETION_PAGE_SIZE
		) {
			await ctx.scheduler.runAfter(
				0,
				internal.account.deletion.pseudonymizeDeletedAccountRecords,
				args
			);
		}
	}
});

// Clerk owns the identity, so Clerk owns the decision to delete it: a customer
// deleting their own account in the account portal and staff deleting one from
// the Clerk dashboard are the same signed `user.deleted` webhook, and this is
// everything that happens on our side of it. There is deliberately no second
// entry point - a staff console button that deleted the Clerk user through its
// Backend API would be a second way to start the identical cleanup, and the
// deployment would carry a Clerk secret on the Convex plane to do it.
export const requestAccountDeletionForClerkUser = internalAction({
	args: {
		clerkUserId: v.string()
	},
	handler: async (ctx, args) => {
		const marked = await ctx.runMutation(
			internal.account.deletion.markAccountDeletionPending,
			args
		);
		if (!marked) return;

		const state = await stateForClerkUser(ctx, args.clerkUserId);
		await startDeletionWorkflows(ctx, state.boxes);
		await scheduleFinalizer(ctx, args.clerkUserId, 0);
	}
});

export const finalizeAccountDeletion = internalAction({
	args: {
		clerkUserId: v.string()
	},
	handler: async (ctx, args) => {
		const state = await stateForClerkUser(ctx, args.clerkUserId);
		if (!state.user?.deletion_pending || state.user.deletion_finished_at)
			return;
		const requestedAt = state.user.deletion_requested_at;
		if (
			requestedAt &&
			Date.now() - requestedAt >= ACCOUNT_DELETION_ALERT_AFTER_MS
		) {
			await ctx.runMutation(internal.staff.alerts.raise, {
				key: `account-deletion-stuck:${state.user._id}:${requestedAt}`,
				severity: "critical",
				subject: "Account deletion has been pending for over 24 hours",
				text: `Account deletion for ${state.user.email} (${state.user.clerk_user_id}) has not finished after 24 hours. Review its box delete operations, Polar subscriptions, and provider cleanup in the staff console.`
			});
		}

		await startDeletionWorkflows(ctx, state.boxes);

		const refreshed = await stateForClerkUser(ctx, args.clerkUserId);
		if (accountDeletionReady(refreshed.boxes)) {
			await ctx.runMutation(internal.account.deletion.finishAccountDeletion, {
				clerkUserId: args.clerkUserId
			});
			return;
		}

		await scheduleFinalizer(ctx, args.clerkUserId);
	}
});

export const sweepPendingAccountDeletions = internalAction({
	args: {},
	handler: async (ctx) => {
		let cursor: string | null = null;

		for (;;) {
			const page: {
				continueCursor: string;
				isDone: boolean;
				page: Doc<"users">[];
			} = await ctx.runQuery(
				internal.account.deletion.pendingAccountDeletionsPage,
				{ cursor }
			);

			for (const user of page.page) {
				await scheduleFinalizer(ctx, user.clerk_user_id, 0);
			}

			if (page.isDone) break;
			cursor = page.continueCursor;
		}
	}
});
