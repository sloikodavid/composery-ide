import { internal } from "../../_generated/api";
import { defineBoxWorkflow } from "./boxWorkflow";

// Suspension powers the whole VPS off at the provider, not just the container,
// so it holds even against a user who escaped the container or broke the box.
export const suspendBox = defineBoxWorkflow({
	type: "suspend",
	run: async (step, args) => {
		const box = await step.runQuery(
			internal.boxes.queries.getBoxLifecycleSnapshot,
			{ boxId: args.boxId }
		);

		await step.runAction(
			internal.boxes.infra.hetznerVps.powerOffServer,
			{ serverId: box.hetzner_server_id },
			{ retry: true }
		);

		await step.runMutation(
			internal.boxes.operation.record.setBoxStatusWithOperationSucceeded,
			{
				boxId: args.boxId,
				operationId: args.operationId,
				status: "suspended"
			}
		);
	}
});
