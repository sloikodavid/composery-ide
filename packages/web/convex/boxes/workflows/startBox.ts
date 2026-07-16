import { internal } from "../../_generated/api";
import { defineBoxWorkflow } from "./boxWorkflow";

export const startBox = defineBoxWorkflow({
	type: "start",
	run: async (step, args) => {
		const box = await step.runQuery(
			internal.boxes.queries.getBoxLifecycleSnapshot,
			{ boxId: args.boxId }
		);

		await step.runAction(
			internal.boxes.infra.hetznerVps.powerOnServer,
			{ serverId: box.hetzner_server_id },
			{ retry: true }
		);

		await step.runMutation(
			internal.boxes.operation.record.setBoxStatusWithOperationSucceeded,
			{
				boxId: args.boxId,
				operationId: args.operationId,
				status: "running"
			}
		);
	}
});
