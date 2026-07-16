import { v } from "convex/values";
import { internal } from "../../_generated/api";
import { defineBoxWorkflow } from "./boxWorkflow";

export const changeBoxPassword = defineBoxWorkflow({
	extraArgs: { runtimeAuthHash: v.string() },
	type: "change_password",
	run: async (step, args) => {
		await step.runAction(
			internal.boxes.infra.host.rewritePasswordAndRestart,
			{
				boxId: args.boxId,
				runtimeAuthHash: args.runtimeAuthHash
			},
			{ retry: true }
		);

		await step.runMutation(
			internal.boxes.operation.record.updateRuntimeAuthHash,
			{
				boxId: args.boxId,
				operationId: args.operationId,
				runtimeAuthHash: args.runtimeAuthHash
			}
		);
	}
});
