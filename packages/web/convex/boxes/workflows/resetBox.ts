import { internal } from "../../_generated/api";
import { captureRollbackSnapshot } from "./snapshotWorkflows";
import { defineBoxWorkflow } from "./boxWorkflow";

// Reset - give the box a clean host and nothing else.
//
// It rebuilds the existing VPS disk from the base image, which keeps the server
// and its Primary IPs while removing every trace of host-level damage, and then
// bootstraps the runtime again from the box's own row.
//
// It deliberately does not change the version. Reset used to re-resolve the
// deployment's channel and advance `box.runtime_image` on the way through, so
// "give me a clean box" also meant "and put me on whatever shipped since" - a
// version change nobody asked for, on the one operation an owner reaches for when
// something is already wrong. The bootstrap renders the compose file from
// `box.runtime_image`, so leaving that field alone is what pins the reset box to
// the version it already had. Update is the only thing that moves a version.
export const resetBox = defineBoxWorkflow({
	type: "reset",
	run: async (step, args) => {
		const box = await step.runQuery(
			internal.boxes.queries.getBoxLifecycleSnapshot,
			{ boxId: args.boxId }
		);

		await captureRollbackSnapshot(step, args.boxId, "reset");

		const server = await step.runAction(
			internal.boxes.infra.hetznerVps.rebuildServer,
			{ serverId: box.hetzner_server_id },
			{ retry: true }
		);

		await step.runMutation(
			internal.boxes.operation.record.recordServerRebuilt,
			{
				boxId: box._id,
				serverId: server.serverId,
				serverType: server.serverType,
				location: server.location,
				ipv4: server.ipv4,
				ipv6: server.ipv6
			}
		);

		await step.runAction(
			internal.boxes.infra.host.bootstrapRuntime,
			{ boxId: box._id },
			{ retry: true }
		);

		await step.runMutation(internal.boxes.operation.record.markResetSucceeded, {
			boxId: args.boxId,
			operationId: args.operationId
		});

		await step.runMutation(
			internal.boxes.snapshots.supersedeRollbackSnapshots,
			{ boxId: args.boxId }
		);
	}
});
