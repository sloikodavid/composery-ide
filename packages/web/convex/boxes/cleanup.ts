import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
	internalAction,
	internalMutation,
	internalQuery
} from "../_generated/server";
import { consoleBoxPath } from "../model/box/path";
import { staffConsoleUrl } from "../env";
import { raiseAlert } from "../staff/alerts";
import { boxDeletionIdempotencyKey } from "../account/deletionLogic";
import { startBoxOperation } from "./operation/start";
import {
	billingRecordPurgeAt,
	deletedCheckoutSlug,
	deletedBoxDataPatch,
	retainedOperationMetadata,
	terminalCheckoutSecretPatch
} from "./retention";
import { DAY_MS, MINUTE_MS } from "../time";

const DELETE_BATCH_SIZE = 100;
const CLEANUP_RETRY_MS = DAY_MS;

// How many failed deletes make this a person's problem as well as the sweep's.
//
// It raises an alert; it does not stop the retries. Deletion is idempotent and
// converges, so the only thing that keeps it failing is an external cause -
// Hetzner unreachable, credentials rotated out from under us - and those clear.
// A sweep that gave up would strand the box permanently at exactly the moment
// the cause was about to go away, and there is no manual lever to rescue it
// with: `staff.boxes.revokeComp` refuses anything that is not a comp, and a paid
// box's only teardown path is the subscription reconciliation that no longer
// looks at `delete_failed`. So it keeps trying and tells someone.
// window: Delete attempts before alert
export const DELETE_ATTEMPTS_BEFORE_ALERT = 3;

// Pure so the rule is testable without a database.
export function deleteNeedsPerson(failedDeletes: number) {
	return failedDeletes >= DELETE_ATTEMPTS_BEFORE_ALERT;
}

// Every box whose deletion stopped part-way, with the number of times it has
// been tried, so the sweep can decide from one consistent read.
export const boxesFailedToDelete = internalQuery({
	args: {},
	handler: async (ctx) => {
		const boxes = await ctx.db
			.query("boxes")
			.withIndex("status", (query) => query.eq("status", "delete_failed"))
			.take(DELETE_BATCH_SIZE);

		const pending: {
			boxId: Id<"boxes">;
			failedDeletes: number;
			idempotencyKey: string;
		}[] = [];
		for (const box of boxes) {
			const failed = await ctx.db
				.query("box_operations")
				.withIndex("box_type_status", (query) =>
					query
						.eq("box_id", box._id)
						.eq("type", "delete")
						.eq("status", "failed")
				)
				.collect();
			pending.push({
				boxId: box._id,
				failedDeletes: failed.length,
				idempotencyKey: boxDeletionIdempotencyKey(box)
			});
		}
		return pending;
	}
});

// A deletion that keeps failing is invisible otherwise: its owner is gone, so
// nobody opens the box's page, and the sweep below retries in silence. Keyed per
// box per day so a box that stays stuck does not send an email every hour.
export const alertDeletionNeedsPerson = internalMutation({
	args: { boxId: v.id("boxes"), failedDeletes: v.number() },
	handler: async (ctx, args) => {
		const box = await ctx.db.get(args.boxId);
		if (!box || box.status !== "delete_failed") return;

		const day = Math.floor(Date.now() / DAY_MS);
		await raiseAlert(ctx, {
			key: `box-delete-needs-person:${box._id}:${day}`,
			severity: "critical",
			subject: `Box ${box.slug} has failed to delete ${args.failedDeletes} times`,
			text: `Box ${box.slug} (${box._id}) has failed to delete ${args.failedDeletes} times. It is still being retried every hour - deletion is idempotent, so it will finish on its own if the cause is transient - but ${args.failedDeletes} failures means something is not clearing by itself.\n\nUntil it does, the box keeps its slug reserved, counts against fleet capacity, and never reaches markDeleted - which is what deletes its Hetzner snapshot images and any parking volume, so those keep billing.${box.hetzner_server_id ? ` Its recorded Hetzner server is ${box.hetzner_server_id}; check whether it still exists, because a teardown that finished externally still leaves this record behind.` : " It has no Hetzner server recorded."}\n\n${staffConsoleUrl(consoleBoxPath(box._id))}`
		});
	}
});

// Finish deletions that stopped part-way.
//
// This exists because `delete_failed` used to be terminal, and that made the
// record lie about the world. The incident that produced it: every external step
// succeeded - DNS records removed, Hetzner server deleted - and the workflow then
// threw on a later step, so `markDeleted` never ran. The box was gone from
// Hetzner and the website said its deletion had failed, for ever, because it was
// a comp box and the only retry in the codebase was reached through a
// subscription it did not have.
//
// Re-driving is safe precisely because deletion is idempotent at every step: the
// DNS delete, the server delete, and the wait all treat "already gone" as
// success, and `markDeleted` is a plain database patch. So a re-drive of a box
// whose teardown already finished takes seconds and simply records the truth.
//
// It never *starts* a deletion. Only a revoked subscription, an account
// deletion, or staff revoking a comp does that; this finishes one of those, which
// is why it carries a trigger of its own rather than borrowing theirs.
//
// It composes with `boxOperationSweep`: a delete whose workflow vanished is
// failed by that sweep, lands in `delete_failed`, and is picked up here.
//
// The alert never stops the retry - see `DELETE_ATTEMPTS_BEFORE_ALERT` for why
// giving up would strand a box no manual lever can reach.
export const finishFailedDeletions = internalAction({
	args: {},
	handler: async (ctx) => {
		const pending = await ctx.runQuery(
			internal.boxes.cleanup.boxesFailedToDelete,
			{}
		);

		for (const box of pending) {
			if (deleteNeedsPerson(box.failedDeletes)) {
				await ctx.runMutation(internal.boxes.cleanup.alertDeletionNeedsPerson, {
					boxId: box.boxId,
					failedDeletes: box.failedDeletes
				});
			}

			try {
				await startBoxOperation(ctx, box.boxId, "delete", {
					idempotencyKey: box.idempotencyKey,
					trigger: "system:delete_retry"
				});
			} catch {
				// Busy, or no longer in a status delete may begin from. Both mean
				// something else is already moving this box; the next sweep re-reads it.
			}
		}
	}
});

export const normalizeDeletedBoxes = internalMutation({
	args: {},
	handler: async (ctx) => {
		const boxes = await ctx.db
			.query("boxes")
			.withIndex("status", (query) => query.eq("status", "deleted"))
			.filter((query) => query.eq(query.field("purge_at"), undefined))
			.take(DELETE_BATCH_SIZE);
		for (const box of boxes) {
			const deletedAt = box.deleted_at ?? box.updated_at;
			await ctx.db.patch(box._id, deletedBoxDataPatch(deletedAt));
			await ctx.scheduler.runAfter(
				0,
				internal.boxes.cleanup.deleteRuntimeData,
				{
					boxId: box._id
				}
			);
			await ctx.scheduler.runAfter(
				0,
				internal.boxes.cleanup.sanitizeOperations,
				{
					boxId: box._id
				}
			);
			await ctx.scheduler.runAfter(0, internal.boxes.cleanup.sanitizeEvents, {
				boxId: box._id
			});
			await ctx.scheduler.runAfter(
				0,
				internal.boxes.cleanup.startCheckoutRetention,
				{
					boxId: box._id,
					deletedAt
				}
			);
		}
		if (boxes.length === DELETE_BATCH_SIZE) {
			await ctx.scheduler.runAfter(
				0,
				internal.boxes.cleanup.normalizeDeletedBoxes,
				{}
			);
		}
	}
});

export const deleteRuntimeData = internalMutation({
	args: { boxId: v.id("boxes") },
	handler: async (ctx, args) => {
		const authCodes = await ctx.db
			.query("box_auth_codes")
			.withIndex("box_id", (query) => query.eq("box_id", args.boxId))
			.take(DELETE_BATCH_SIZE);
		const authGrants = await ctx.db
			.query("box_auth_grants")
			.withIndex("box_id", (query) => query.eq("box_id", args.boxId))
			.take(DELETE_BATCH_SIZE);
		const metrics = await ctx.db
			.query("box_metrics")
			.withIndex("box_id_sampled_at", (query) => query.eq("box_id", args.boxId))
			.take(DELETE_BATCH_SIZE);
		const hourlyMetrics = await ctx.db
			.query("box_metrics_hourly")
			.withIndex("box_id_hour_start", (query) => query.eq("box_id", args.boxId))
			.take(DELETE_BATCH_SIZE);
		// Health tracking is about a box that answers; a deleted box does not. The
		// row is also what automatic repair's failure count lives in, so leaving it
		// behind keeps a count for a box that can never be probed again.
		const health = await ctx.db
			.query("box_health")
			.withIndex("box_id", (query) => query.eq("box_id", args.boxId))
			.take(DELETE_BATCH_SIZE);
		// Usage is what a box spent of what it was allowed. A deleted box spends
		// nothing, and leaving the rows behind would keep a full-disk reading against
		// a box no host answers for.
		const usage = await ctx.db
			.query("box_usage")
			.withIndex("box_id_signal", (query) => query.eq("box_id", args.boxId))
			.take(DELETE_BATCH_SIZE);
		for (const row of [
			...authCodes,
			...authGrants,
			...metrics,
			...hourlyMetrics,
			...health,
			...usage
		]) {
			await ctx.db.delete(row._id);
		}
		if (
			[authCodes, authGrants, metrics, hourlyMetrics, health, usage].some(
				(rows) => rows.length === DELETE_BATCH_SIZE
			)
		) {
			await ctx.scheduler.runAfter(
				0,
				internal.boxes.cleanup.deleteRuntimeData,
				{
					boxId: args.boxId
				}
			);
		}
	}
});

export const startCheckoutRetention = internalMutation({
	args: {
		boxId: v.id("boxes"),
		deletedAt: v.number(),
		cursor: v.optional(v.union(v.string(), v.null()))
	},
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query("box_checkout_intents")
			.withIndex("box_id", (query) => query.eq("box_id", args.boxId))
			.paginate({ cursor: args.cursor ?? null, numItems: DELETE_BATCH_SIZE });
		for (const intent of page.page) {
			await ctx.db.patch(intent._id, {
				purge_at: billingRecordPurgeAt(args.deletedAt),
				...terminalCheckoutSecretPatch()
			});
		}
		if (!page.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.boxes.cleanup.startCheckoutRetention,
				{
					boxId: args.boxId,
					deletedAt: args.deletedAt,
					cursor: page.continueCursor
				}
			);
		}
	}
});

export const purgeExpiredCheckoutRecords = internalMutation({
	args: {},
	handler: async (ctx) => {
		const timestamp = Date.now();
		const intents = await ctx.db
			.query("box_checkout_intents")
			// Bounded from below: purge_at is optional, and Convex orders a
			// missing field below every number, so lte() alone would also sweep
			// in-flight intents that have not been given a purge_at yet.
			.withIndex("purge_at", (query) =>
				query.gte("purge_at", 0).lte("purge_at", timestamp)
			)
			.take(DELETE_BATCH_SIZE);
		for (const intent of intents) {
			if ((intent.retain_until ?? 0) > timestamp) {
				await ctx.db.patch(intent._id, { purge_at: intent.retain_until });
				continue;
			}
			if (intent.box_id && (await ctx.db.get(intent.box_id))) {
				await ctx.db.patch(intent._id, {
					purge_at: timestamp + CLEANUP_RETRY_MS
				});
				continue;
			}
			await ctx.db.delete(intent._id);
		}
		if (intents.length === DELETE_BATCH_SIZE) {
			await ctx.scheduler.runAfter(
				0,
				internal.boxes.cleanup.purgeExpiredCheckoutRecords,
				{}
			);
		}
	}
});

export const sanitizeOperations = internalMutation({
	args: {
		boxId: v.id("boxes"),
		cursor: v.optional(v.union(v.string(), v.null()))
	},
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query("box_operations")
			.withIndex("box_id_created_at", (query) => query.eq("box_id", args.boxId))
			.paginate({ cursor: args.cursor ?? null, numItems: DELETE_BATCH_SIZE });
		for (const operation of page.page) {
			await ctx.db.patch(operation._id, {
				idempotency_key: `deleted:${operation._id}`,
				reserved_slug: undefined,
				last_error: undefined,
				metadata: retainedOperationMetadata(operation.type, operation.metadata)
			});
		}
		if (!page.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.boxes.cleanup.sanitizeOperations,
				{
					boxId: args.boxId,
					cursor: page.continueCursor
				}
			);
		}
	}
});

export const sanitizeEvents = internalMutation({
	args: {
		boxId: v.id("boxes"),
		cursor: v.optional(v.union(v.string(), v.null()))
	},
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query("box_events")
			.withIndex("box_id_created_at", (query) => query.eq("box_id", args.boxId))
			.paginate({ cursor: args.cursor ?? null, numItems: DELETE_BATCH_SIZE });
		for (const event of page.page) {
			await ctx.db.patch(event._id, {
				message: undefined,
				metadata: undefined
			});
		}
		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.boxes.cleanup.sanitizeEvents, {
				boxId: args.boxId,
				cursor: page.continueCursor
			});
		}
	}
});

export const scheduleExpiredBoxPurges = internalMutation({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query("boxes")
			// Bounded from below because `purge_at` is optional and Convex orders a
			// missing field below every number: a bare `lte` would select every box
			// that never got one, which is every live box.
			.withIndex("purge_at", (query) =>
				query.gte("purge_at", 0).lte("purge_at", Date.now())
			)
			.paginate({ cursor: args.cursor ?? null, numItems: DELETE_BATCH_SIZE });
		for (const box of page.page) {
			await ctx.scheduler.runAfter(0, internal.boxes.cleanup.purgeBox, {
				boxId: box._id
			});
		}
		if (!page.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.boxes.cleanup.scheduleExpiredBoxPurges,
				{ cursor: page.continueCursor }
			);
		}
	}
});

export const purgeBox = internalMutation({
	args: { boxId: v.id("boxes") },
	handler: async (ctx, args) => {
		const box = await ctx.db.get(args.boxId);
		if (
			!box ||
			box.status !== "deleted" ||
			(box.purge_at ?? Infinity) > Date.now()
		) {
			return;
		}

		const authCodes = await ctx.db
			.query("box_auth_codes")
			.withIndex("box_id", (query) => query.eq("box_id", args.boxId))
			.take(DELETE_BATCH_SIZE);
		const authGrants = await ctx.db
			.query("box_auth_grants")
			.withIndex("box_id", (query) => query.eq("box_id", args.boxId))
			.take(DELETE_BATCH_SIZE);
		const operations = await ctx.db
			.query("box_operations")
			.withIndex("box_id_created_at", (query) => query.eq("box_id", args.boxId))
			.take(DELETE_BATCH_SIZE);
		const events = await ctx.db
			.query("box_events")
			.withIndex("box_id_created_at", (query) => query.eq("box_id", args.boxId))
			.take(DELETE_BATCH_SIZE);
		const metrics = await ctx.db
			.query("box_metrics")
			.withIndex("box_id_sampled_at", (query) => query.eq("box_id", args.boxId))
			.take(DELETE_BATCH_SIZE);
		const hourlyMetrics = await ctx.db
			.query("box_metrics_hourly")
			.withIndex("box_id_hour_start", (query) => query.eq("box_id", args.boxId))
			.take(DELETE_BATCH_SIZE);
		const flags = await ctx.db
			.query("box_flags")
			.withIndex("box_id_created_at", (query) => query.eq("box_id", args.boxId))
			.take(DELETE_BATCH_SIZE);
		const health = await ctx.db
			.query("box_health")
			.withIndex("box_id", (query) => query.eq("box_id", args.boxId))
			.take(DELETE_BATCH_SIZE);
		const usage = await ctx.db
			.query("box_usage")
			.withIndex("box_id_signal", (query) => query.eq("box_id", args.boxId))
			.take(DELETE_BATCH_SIZE);
		const intents = await ctx.db
			.query("box_checkout_intents")
			.withIndex("box_id", (query) => query.eq("box_id", args.boxId))
			.take(DELETE_BATCH_SIZE);
		const snapshots = await ctx.db
			.query("box_snapshots")
			.withIndex("box_id_created_at", (query) => query.eq("box_id", args.boxId))
			.take(DELETE_BATCH_SIZE);

		const rows = [
			...authCodes,
			...authGrants,
			...operations,
			...events,
			...metrics,
			...hourlyMetrics,
			...flags,
			...health,
			...usage
		];
		for (const row of rows) await ctx.db.delete(row._id);
		for (const intent of intents) {
			await ctx.db.patch(intent._id, {
				box_id: undefined,
				slug: deletedCheckoutSlug(intent._id)
			});
		}
		for (const snapshot of snapshots) {
			await ctx.scheduler.runAfter(0, internal.boxes.snapshots.runDelete, {
				snapshotRowId: snapshot._id
			});
		}

		if (rows.length > 0 || intents.length > 0 || snapshots.length > 0) {
			await ctx.scheduler.runAfter(
				snapshots.length > 0 ? MINUTE_MS : 0,
				internal.boxes.cleanup.purgeBox,
				{ boxId: args.boxId }
			);
			return;
		}

		await ctx.db.delete(box._id);
	}
});
