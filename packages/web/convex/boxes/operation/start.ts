import { ConvexError, v } from "convex/values";
import type { Infer } from "convex/values";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import {
	internalMutation,
	type ActionCtx,
	type DatabaseReader
} from "../../_generated/server";
import {
	vBoxBeginStatus,
	vBoxOperationType,
	vOperationTrigger,
	type OperationTrigger
} from "../../schema";
import {
	ACTIVE_OPERATION_STATUSES,
	isOperationAllowed
} from "../../model/box/operation";
import { assertSlugAvailable } from "../slugAvailability";
import { startWorkflow } from "../workflows/boxWorkflow";

type ReadDbCtx = { db: DatabaseReader };
type OperationType = Infer<typeof vBoxOperationType>;
type StartArgs = Parameters<typeof startWorkflow>;
// Actions and mutations both start operations. An action's `runMutation` has the
// narrower signature of the two, so typing the slot with it accepts either.
type StartCtx = { runMutation: ActionCtx["runMutation"] };

function assertOperationAllowed(box: Doc<"boxes">, type: OperationType) {
	if (!isOperationAllowed(box.status, type)) {
		throw new ConvexError(`Cannot start ${type} while box is ${box.status}.`);
	}
}

async function findActiveOperationByIdempotencyKey(
	ctx: ReadDbCtx,
	key: string
) {
	for (const status of ACTIVE_OPERATION_STATUSES) {
		const operation = await ctx.db
			.query("box_operations")
			.withIndex("idempotency_key_status", (query) =>
				query.eq("idempotency_key", key).eq("status", status)
			)
			.first();
		if (operation) return operation;
	}

	return null;
}

async function findActiveOperationForBox(ctx: ReadDbCtx, boxId: Id<"boxes">) {
	for (const status of ACTIVE_OPERATION_STATUSES) {
		const operation = await ctx.db
			.query("box_operations")
			.withIndex("box_id_status", (query) =>
				query.eq("box_id", boxId).eq("status", status)
			)
			.first();
		if (operation) return operation;
	}

	return null;
}

// The one place that knows, per operation, which status the box moves to while
// the operation runs and which workflow carries it out. `satisfies` makes the
// table exhaustive: add an operation type to the schema and this won't compile
// until it has a plan. Callers only supply what genuinely varies - the
// idempotency key, and any reserved slug, metadata, or workflow arguments.
const BOX_OPERATION_PLANS = {
	create: {
		targetStatus: "creating",
		workflow: internal.boxes.workflows.createBox.createBox
	},
	delete: {
		targetStatus: "deleting",
		workflow: internal.boxes.workflows.deleteBox.deleteBox
	},
	reset: {
		targetStatus: "resetting",
		workflow: internal.boxes.workflows.resetBox.resetBox
	},
	stop: {
		targetStatus: "stopping",
		workflow: internal.boxes.workflows.stopBox.stopBox
	},
	start: {
		targetStatus: "starting",
		workflow: internal.boxes.workflows.startBox.startBox
	},
	change_slug: {
		workflow: internal.boxes.workflows.changeBoxSlug.changeBoxSlug
	},
	change_password: {
		workflow: internal.boxes.workflows.changeBoxPassword.changeBoxPassword
	},
	suspend: {
		targetStatus: "suspending",
		workflow: internal.boxes.workflows.suspendBox.suspendBox
	},
	unsuspend: {
		targetStatus: "unsuspending",
		workflow: internal.boxes.workflows.unsuspendBox.unsuspendBox
	},
	restore: {
		targetStatus: "restoring",
		workflow: internal.boxes.workflows.snapshotWorkflows.restoreBox
	},
	snapshot: {
		workflow: internal.boxes.workflows.snapshotWorkflows.captureSnapshot
	},
	repair: {
		targetStatus: "repairing",
		workflow: internal.boxes.workflows.repairBox.repairBox
	},
	update: {
		targetStatus: "updating",
		workflow: internal.boxes.workflows.updateBox.updateBox
	},
	change_config: {
		workflow: internal.boxes.workflows.changeBoxConfig.changeBoxConfig
	}
} satisfies Record<
	OperationType,
	{ targetStatus?: Infer<typeof vBoxBeginStatus>; workflow: StartArgs[1] }
>;

// Create the operation row, start its workflow, and record which workflow that
// was - all in one transaction.
//
// The atomicity is the point, not incidental tidiness. This used to run as two
// steps, so every caller reached through an action (repair, update, restore, and
// every automatic sweep) had a window between them: an action that died after the
// row committed but before the workflow started left an operation `pending` with
// nothing behind it, which made `findActiveOperationForBox` refuse every later
// action on that box - permanently, since nothing existed to fail it. The box
// could only be freed by editing the row by hand. One mutation removes the window
// instead of detecting it afterwards.
export const startOperation = internalMutation({
	args: {
		boxId: v.id("boxes"),
		idempotencyKey: v.string(),
		metadata: v.optional(v.record(v.string(), v.any())),
		reservedSlug: v.optional(v.string()),
		trigger: vOperationTrigger,
		type: vBoxOperationType,
		workflowArgs: v.optional(v.record(v.string(), v.any()))
	},
	handler: async (ctx, args): Promise<Id<"box_operations"> | null> => {
		const box = await ctx.db.get(args.boxId);
		if (!box) throw new ConvexError("Box not found.");

		const existing = await findActiveOperationByIdempotencyKey(
			ctx,
			args.idempotencyKey
		);
		if (existing) return null;

		const activeOperation = await findActiveOperationForBox(ctx, box._id);
		if (activeOperation) {
			throw new ConvexError(
				"This box is busy with another operation. Try again in a moment."
			);
		}

		assertOperationAllowed(box, args.type);

		if (args.reservedSlug) {
			await assertSlugAvailable(ctx, args.reservedSlug, { boxId: box._id });
		}

		const plan = BOX_OPERATION_PLANS[args.type];
		const timestamp = Date.now();
		// Presence alone: an entry that has the key always names a status, because
		// the table above is literals rather than a `Record` with optional values.
		// The truthiness check that used to follow could not fail.
		if ("targetStatus" in plan) {
			await ctx.db.patch(box._id, {
				status: plan.targetStatus,
				updated_at: timestamp
			});
		}

		const operationId = await ctx.db.insert("box_operations", {
			box_id: box._id,
			type: args.type,
			status: "pending",
			idempotency_key: args.idempotencyKey,
			reserved_slug: args.reservedSlug,
			trigger: args.trigger,
			metadata: args.metadata,
			created_at: timestamp,
			updated_at: timestamp
		});

		const workflowId = await startWorkflow(
			ctx,
			plan.workflow,
			{
				boxId: box._id,
				operationId,
				...args.workflowArgs
			} as StartArgs[2],
			{ boxId: box._id, operationId }
		);
		await ctx.db.patch(operationId, { workflow_id: workflowId });

		return operationId;
	}
});

export async function startBoxSuspension(
	ctx: StartCtx,
	input: {
		boxId: Id<"boxes">;
		idempotencyKeyPrefix: string;
		reason?: string;
		suspend: boolean;
		trigger: OperationTrigger;
	}
) {
	return await startBoxOperation(
		ctx,
		input.boxId,
		input.suspend ? "suspend" : "unsuspend",
		{
			idempotencyKey: `${input.idempotencyKeyPrefix}:${input.boxId}`,
			metadata: input.suspend ? { reason: input.reason } : undefined,
			trigger: input.trigger
		}
	);
}

// Every operation starts here, whether the caller is a mutation or an action, so
// there is exactly one path into `startOperationRecord` and it is transactional
// for all of them. Callers that already hold a `Doc<"boxes">` in their own
// mutation (checkout conversion, staff comps) still come through here rather than
// calling the record helper directly - one absolute rule beats a rule plus an
// exception, and the exception is what grew a second, non-atomic path last time.
export async function startBoxOperation(
	ctx: StartCtx,
	boxId: Id<"boxes">,
	type: OperationType,
	options: {
		idempotencyKey: string;
		metadata?: Record<string, unknown>;
		reservedSlug?: string;
		trigger: OperationTrigger;
		workflowArgs?: Record<string, unknown>;
	}
): Promise<Id<"box_operations"> | null> {
	return await ctx.runMutation(internal.boxes.operation.start.startOperation, {
		boxId,
		idempotencyKey: options.idempotencyKey,
		metadata: options.metadata,
		reservedSlug: options.reservedSlug,
		trigger: options.trigger,
		type,
		workflowArgs: options.workflowArgs
	});
}
