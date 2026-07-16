import { internal } from "../../_generated/api";
import { deleteRuntime } from "./runtimeLifecycle";
import { defineBoxWorkflow } from "./boxWorkflow";

// A box exists iff its Polar subscription is active. Deletion is only triggered
// by a subscription ending (the subscription.revoked webhook or the hourly
// reconciliation sweep), never directly by user or staff.
export const deleteBox = defineBoxWorkflow({
	type: "delete",
	run: async (step, args) => {
		const box = await step.runQuery(
			internal.boxes.queries.getBoxLifecycleSnapshot,
			{ boxId: args.boxId }
		);

		await deleteRuntime(step, box);

		await step.runMutation(internal.boxes.operation.record.markDeleted, {
			boxId: args.boxId,
			operationId: args.operationId
		});
	}
});
