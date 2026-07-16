import type { WorkflowId } from "@convex-dev/workflow";
import { v } from "convex/values";
import { internal } from "../../_generated/api";
import type { Doc } from "../../_generated/dataModel";
import {
	internalAction,
	internalMutation,
	internalQuery
} from "../../_generated/server";
import { consoleBoxPath } from "../../model/box/path";
import {
	operationLabel,
	ACTIVE_OPERATION_STATUSES,
	isActiveOperationStatus,
	BOX_OPERATIONS
} from "../../model/box/operation";
import { vBoxOperationType } from "../../schema";
import { staffConsoleUrl } from "../../env";
import { raiseAlert } from "../../staff/alerts";
import { recordOperationFailure } from "./record";
import { activeOperation } from "../views";
import { workflow } from "../workflows/boxWorkflow";
import { HOUR_MS, MINUTE_MS } from "../../time";

// The backstop for the operation lock.
//
// An active operation blocks every later action on its box - that is the whole
// point of it, and it is why an operation that can never finish is the worst state
// a box can reach: the owner sees "This box is busy with another operation" for
// ever, and no amount of pressing Repair helps. `startOperation` makes the row and
// its workflow atomic, and `finishBoxOperation` closes the operation on every
// terminal outcome the component reports, so nothing should get stuck. This sweep
// exists because "should" is not a guarantee, and because a stuck operation is
// invisible until someone complains.
//
// What it does *not* do is guess from elapsed time. An operation is only closed
// when the workflow behind it is provably gone - terminal, or never recorded at
// all. A repair copies a whole disk twice and can legitimately run for hours; a
// sweep that failed operations on a timer would eventually fight a working repair
// and race it for the box's status.

// Nothing younger than this is examined, so a just-created operation is never
// mistaken for an orphan while its workflow is still being handed to the workpool
// and its completion callback has not yet landed. Both are second-scale; the
// window is minutes because there is no cost to patience here.
// window: Orphaned operation grace period
export const OPERATION_ORPHAN_GRACE_MS = 30 * MINUTE_MS;

// An operation whose workflow is still genuinely running past this is reported,
// never closed. Past any plausible duration it means a workflow is wedged rather
// than working, and cancelling one mid-flight is a judgement call about the box's
// files - so it goes to a person, with `staff.boxes.cancelOperation` as the lever.
// window: Long-running operation alert
export const OPERATION_RUNNING_ALERT_MS = 6 * HOUR_MS;

const OPERATION_SWEEP_BATCH = 100;

export type OperationLiveness =
	| { orphaned: false }
	// The workflow is provably gone, so the operation can never be closed by it.
	| { orphaned: true; error: string };

// Pure, so the whole decision is testable without a workflow component: what the
// component says about the workflow, plus whether one was ever recorded, decides
// this and nothing else.
export function operationLiveness(input: {
	workflowId: string | undefined;
	workflowStatus: { type: string } | null;
}): OperationLiveness {
	if (input.workflowId === undefined) {
		// `startBoxOperation` inserts the row and patches this in one transaction,
		// so an active operation reaching the sweep without one means the workflow
		// was never started. Nothing is carrying it.
		return {
			orphaned: true,
			error:
				"No workflow was recorded for this operation, so nothing was left to finish it."
		};
	}
	if (input.workflowStatus === null) {
		return {
			orphaned: true,
			error: "The workflow for this operation no longer exists."
		};
	}
	if (input.workflowStatus.type === "inProgress") return { orphaned: false };
	return {
		orphaned: true,
		error: `The workflow for this operation ended as "${input.workflowStatus.type}" without recording an outcome.`
	};
}

export const activeOperationForBox = internalQuery({
	args: { boxId: v.id("boxes") },
	handler: async (ctx, args) => await activeOperation(ctx.db, args.boxId)
});

export const activeOperationsBefore = internalQuery({
	args: { before: v.number() },
	handler: async (ctx, args) => {
		const operations: Doc<"box_operations">[] = [];
		for (const status of ACTIVE_OPERATION_STATUSES) {
			const page = await ctx.db
				.query("box_operations")
				.withIndex("status_created_at", (query) =>
					query.eq("status", status).lte("created_at", args.before)
				)
				.take(OPERATION_SWEEP_BATCH);
			operations.push(...page);
		}
		return operations.map((operation) => ({
			boxId: operation.box_id,
			createdAt: operation.created_at,
			operationId: operation._id,
			type: operation.type,
			workflowId: operation.workflow_id
		}));
	}
});

// Close an operation whose workflow is provably gone, and say so. Routed through
// the same failure recorder every workflow failure uses, so the box lands in the
// status `BOX_OPERATIONS[type].onFailure` says a failure leaves it in - a rescued
// repair reads as `repair_failed` and can be retried, exactly as one that failed
// the ordinary way.
export const failOrphanedOperation = internalMutation({
	args: {
		error: v.string(),
		operationId: v.id("box_operations")
	},
	handler: async (ctx, args) => {
		const operation = await ctx.db.get(args.operationId);
		if (!operation || !isActiveOperationStatus(operation.status)) return;

		await recordOperationFailure(ctx, {
			boxId: operation.box_id,
			error: args.error,
			operationId: args.operationId,
			targetBoxStatus: BOX_OPERATIONS[operation.type].onFailure ?? undefined
		});
	}
});

export const alertLongRunningOperation = internalMutation({
	args: {
		boxId: v.id("boxes"),
		createdAt: v.number(),
		operationId: v.id("box_operations"),
		type: vBoxOperationType
	},
	handler: async (ctx, args) => {
		const box = await ctx.db.get(args.boxId);
		if (!box) return;
		const hours = Math.floor((Date.now() - args.createdAt) / HOUR_MS);
		await raiseAlert(ctx, {
			key: `box-operation-long-running:${args.operationId}`,
			severity: "warning",
			subject: `Box ${box.slug}: ${operationLabel(args.type, true)} has been running ${hours}h`,
			text: `A ${operationLabel(args.type, true)} operation on box ${box.slug} (${box._id}) has been running for ${hours} hours and its workflow still reports itself in progress.\n\nWhile it stays open no other action on this box can start. If it is wedged rather than working, cancel it from the box's console page; that records it as failed and frees the box.\n\n${staffConsoleUrl(consoleBoxPath(box._id))}`
		});
	}
});

export const sweepStuckOperations = internalAction({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const operations = await ctx.runQuery(
			internal.boxes.operation.sweep.activeOperationsBefore,
			{ before: now - OPERATION_ORPHAN_GRACE_MS }
		);

		for (const operation of operations) {
			try {
				// `status` throws for a workflow the component no longer holds, which is
				// itself an answer: nothing is going to finish this operation.
				const workflowStatus = operation.workflowId
					? await workflow
							.status(ctx, operation.workflowId as WorkflowId)
							.catch(() => null)
					: null;

				const liveness = operationLiveness({
					workflowId: operation.workflowId,
					workflowStatus
				});

				if (liveness.orphaned) {
					await ctx.runMutation(
						internal.boxes.operation.sweep.failOrphanedOperation,
						{ error: liveness.error, operationId: operation.operationId }
					);
					continue;
				}

				if (now - operation.createdAt >= OPERATION_RUNNING_ALERT_MS) {
					await ctx.runMutation(
						internal.boxes.operation.sweep.alertLongRunningOperation,
						{
							boxId: operation.boxId,
							createdAt: operation.createdAt,
							operationId: operation.operationId,
							type: operation.type
						}
					);
				}
			} catch (error) {
				// One unreadable operation must not stop the rest of the fleet's from
				// being checked. The next run picks it up again.
				console.error(
					`[operation-sweep] could not check operation ${operation.operationId}`,
					error
				);
			}
		}
	}
});
