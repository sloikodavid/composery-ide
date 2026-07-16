import { v } from "convex/values";
import { internal } from "../../_generated/api";
import { defineBoxWorkflow } from "./boxWorkflow";

// Apply the owner's environment configuration to their box.
//
// The box keeps its `running` status throughout. Unlike an update this does not
// change what the box is, only how the editor starts, and the visible cost is a
// container recreate - the same interruption a password change already causes.
// Giving it a `configuring` status would put the box into a state every other
// operation would then have to learn about, for a step measured in seconds.
//
// The ordering matches `updateBox`, and for the same reason: the row is advanced
// only after the editor has answered on the new configuration. A configuration
// that stops the editor booting therefore leaves `runtime_config` on the last
// value known to work, so Repair - which renders the env file from the row -
// puts the box back rather than reapplying the configuration that broke it.
//
// The attempted configuration is recorded in the operation's metadata by the
// caller, so a failed apply is not lost to support even though the row does not
// take it.
export const changeBoxConfig = defineBoxWorkflow({
	extraArgs: {
		config: v.record(v.string(), v.string())
	},
	type: "change_config",
	run: async (step, args) => {
		await step.runAction(
			internal.boxes.infra.host.applyRuntimeConfig,
			{ boxId: args.boxId, config: args.config },
			{ retry: true }
		);

		await step.runMutation(internal.boxes.operation.record.markConfigApplied, {
			boxId: args.boxId,
			operationId: args.operationId,
			config: args.config
		});
	}
});
