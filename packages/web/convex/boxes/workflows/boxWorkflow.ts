import { WorkflowManager, type WorkflowCtx } from "@convex-dev/workflow";
import { type ObjectType, type PropertyValidators, v } from "convex/values";
import { components, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
	type BoxOperationType,
	BOX_OPERATIONS
} from "../../model/box/operation";

export const workflow = new WorkflowManager(components.workflow);

type StartParams = Parameters<typeof workflow.start>;

// Start a workflow and hand back its id, so the caller can record it on the
// operation row in the same transaction. That id is what later lets us ask the
// workflow component whether an operation still has anything running behind it
// (see `boxOperationSweep`); an operation with no id recorded is one whose
// workflow was never created.
export async function startWorkflow(
	ctx: StartParams[0],
	workflowRef: StartParams[1],
	args: StartParams[2],
	context: { boxId: Id<"boxes">; operationId: Id<"box_operations"> }
) {
	return await workflow.start(ctx, workflowRef, args, {
		startAsync: true,
		// The component calls this on every terminal outcome - success, failure, or
		// cancellation - including the ones `defineBoxWorkflow`'s own catch cannot
		// see: a workflow cancelled from outside, or one whose failure-recording
		// mutation itself threw. Without it those leave the operation active
		// forever, and an active operation blocks every later action on the box.
		onComplete: internal.boxes.operation.record.finishBoxOperation,
		context
	});
}

// Convex reports a throw from an action as "Uncaught Error: <message>" followed
// by a server stack trace, and an operation's error is shown to the box owner
// verbatim. Keep the sentence, drop the plumbing - a file and line number in
// our backend is not something the owner can act on.
export function operationError(error: unknown) {
	const raw = error instanceof Error ? error.message : String(error);
	const message = raw
		.split(/\n\s*at /)[0]
		.replace(/^Uncaught \w*Error: /, "")
		.trim();
	return message || "Something went wrong.";
}

type BoxWorkflowArgs<Extra extends PropertyValidators> = {
	boxId: Id<"boxes">;
	operationId: Id<"box_operations">;
} & ObjectType<Extra>;

// Marks the operation running, runs the body, and on any throw records the
// failure against the operation and box before re-throwing. On a clean return
// it settles the operation as a safety net, in case the body forgot to close
// it - an unclosed operation would block every later action on the box.
//
// Where a failure leaves the box is not stated here: it is looked up from
// `BOX_OPERATIONS[type].onFailure`, so a workflow cannot describe its own
// failure differently from the sweep that rescues it.
export function defineBoxWorkflow<
	Extra extends PropertyValidators = Record<string, never>
>(config: {
	extraArgs?: Extra;
	type: BoxOperationType;
	run: (step: WorkflowCtx, args: BoxWorkflowArgs<Extra>) => Promise<void>;
}) {
	const failureStatus = BOX_OPERATIONS[config.type].onFailure ?? undefined;

	return workflow.define({
		args: {
			boxId: v.id("boxes"),
			operationId: v.id("box_operations"),
			...((config.extraArgs ?? {}) as Extra)
		},
		handler: async (step, args) => {
			const typedArgs = args as BoxWorkflowArgs<Extra>;
			await step.runMutation(
				internal.boxes.operation.record.markOperationRunning,
				{
					operationId: typedArgs.operationId
				}
			);

			try {
				await config.run(step, typedArgs);
			} catch (error) {
				await step.runMutation(
					internal.boxes.operation.record.markOperationFailed,
					{
						boxId: typedArgs.boxId,
						operationId: typedArgs.operationId,
						error: operationError(error),
						targetBoxStatus: failureStatus
					}
				);
				throw error;
			}

			await step.runMutation(internal.boxes.operation.record.settleOperation, {
				operationId: typedArgs.operationId
			});
		}
	});
}
