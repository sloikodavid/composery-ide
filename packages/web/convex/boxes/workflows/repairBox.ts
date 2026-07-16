import { internal } from "../../_generated/api";
import { BOX_PLANS } from "../../model/box/plan";
import { defineBoxWorkflow } from "./boxWorkflow";

// Repair - gives a box a clean host while keeping its files. It is the box's one
// recovery action: the owner never has to tell a wedged container apart from a
// broken host. Restore and Reset both give a clean disk but rewind or erase the
// files; Repair is the only path that keeps them. A host the owner has damaged
// in a way no in-place fix can heal (broken Docker, a mangled boot disk, wrecked
// systemd/nftables, or an unreachable SSH service) is read through Hetzner
// Rescue instead. Rescue boots independently of that disk, so Repair can park
// the Docker volumes on a transient Hetzner Volume before the server is rebuilt
// from HETZNER_BOX_IMAGE, and the files are copied back and verified before the
// volume is deleted. Rewriting the runtime files and force-recreating the
// containers on the fresh host (repairRuntime) is the final step, so a wedged
// container is healed by the same action.
//
// Crash safety rests on two things, both persisted on the box row:
//   * parking_volume_id, set the instant the volume exists and cleared only
//     after the fresh server has a verified copy. External deletion follows the
//     clear, so an interruption leaves either a recoverable pointer or a harmless
//     orphan (reconciliation reclaims any volume no live box points at);
//   * parking_volume_stage, the one-way gate between the two halves. The
//     destructive server rebuild only runs after the copy onto the volume has
//     verified (stage crosses to "restoring"), and once there the copy direction
//     is fixed at volume -> server, so a resumed repair can never overwrite the
//     parked files with an empty server.
//
// This is the only operation that moves a box's files, and nothing else ever
// needs to: a box keeps one disk for its whole life. There is no plan change to
// move them for either - a plan is fixed at purchase, and a subscription that
// drifts off it is reported to staff rather than acted on (see
// `convex/billing/reconciliation.ts`).
//
// No pre-repair Hetzner snapshot is taken: the verified parking volume is the
// safety net, and a snapshot would burn a per-box snapshot slot (which gates
// fleet-wide checkout capacity) and cannot even capture the attached volume. An
// owner who wants belt-and-braces can take a manual snapshot first, on a plan
// that has them.
export const repairBox = defineBoxWorkflow({
	type: "repair",
	run: async (step, args) => {
		const box = await step.runQuery(
			internal.boxes.queries.getBoxLifecycleSnapshot,
			{ boxId: args.boxId }
		);
		if (!box.hetzner_server_id) {
			throw new Error("Box has no Hetzner server to repair.");
		}
		if (!box.hetzner_location) {
			throw new Error("Box has no Hetzner location for its parking volume.");
		}
		const serverId = box.hetzner_server_id;

		// Most outages are a stopped or wedged container, not a damaged boot disk.
		// Reconcile the declared runtime first and accept it only after the public
		// health boundary answers. Any failure falls through to provider rescue;
		// the owner still has one Repair action and no diagnosis to make.
		try {
			await step.runAction(
				internal.boxes.infra.host.repairRuntime,
				{ boxId: args.boxId },
				{ retry: true }
			);
			const health = await step.runAction(
				internal.boxes.health.probeRuntime,
				{ boxId: args.boxId },
				{ retry: true }
			);
			if (health.reachable) {
				await step.runMutation(
					internal.boxes.operation.record.markRepairSucceeded,
					{ boxId: args.boxId, operationId: args.operationId }
				);
				return;
			}
		} catch {
			// Rescue is the fallback and records the operation's final result.
		}

		// PARKING PHASE. The box's own server still holds the authoritative files;
		// nothing destructive has happened. Skipped entirely when a resumed repair
		// has already crossed into "restoring".
		let volumeId = box.parking_volume_id;
		if (box.parking_volume_stage !== "restoring") {
			if (volumeId === undefined) {
				const created = await step.runAction(
					internal.boxes.infra.hetznerVps.createParkingVolume,
					{
						boxRef: String(args.boxId),
						slug: box.slug,
						location: box.hetzner_location,
						sizeGb: BOX_PLANS[box.plan].diskGb
					},
					{ retry: true }
				);
				volumeId = created.volumeId;
				// Persist the id before a single byte is copied, so a crash from here on
				// can never orphan the volume.
				await step.runMutation(
					internal.boxes.operation.record.recordParkingVolume,
					{
						boxId: args.boxId,
						volumeId
					}
				);
			}
			await step.runAction(
				internal.boxes.infra.hetznerVps.attachParkingVolume,
				{ volumeId, serverId },
				{ retry: true }
			);
			// Ask the installed OS to stop cleanly, with a provider power-off fallback,
			// then boot the independent rescue OS with the recovery key.
			await step.runAction(
				internal.boxes.infra.hetznerVps.stopServer,
				{ serverId },
				{ retry: true }
			);
			await step.runAction(
				internal.boxes.infra.hetznerVps.bootServerInRescue,
				{ serverId },
				{ retry: true }
			);
			await step.runAction(
				internal.boxes.infra.host.copyToParking,
				{ boxId: args.boxId, volumeId },
				{ retry: true }
			);
			// Verify the copy while the box's files still exist, before anything
			// irreversible. "rsync exited 0" is not proof; this compares the trees.
			await step.runAction(
				internal.boxes.infra.host.verifyParkingCopy,
				{ boxId: args.boxId, volumeId },
				{ retry: true }
			);
			await step.runAction(
				internal.boxes.infra.host.unmountParkingFromRescue,
				{ boxId: args.boxId },
				{ retry: true }
			);
			// The one-way gate: only now is the volume authoritative and the
			// destructive rebuild permitted.
			await step.runMutation(
				internal.boxes.operation.record.markParkingRestoring,
				{
					boxId: args.boxId
				}
			);
		}

		if (volumeId === undefined) {
			// A box in "restoring" must have a parking volume. If the pointer is gone
			// the recovery data cannot be found, so fail loudly rather than proceed.
			throw new Error(
				"Repair is mid-restore but its parking volume pointer is gone."
			);
		}

		// RESTORING PHASE. The parking volume holds the only copy of the files, so
		// nothing copies server -> volume from here on.
		//
		// Detach before the rebuild deliberately: it makes the operation correct
		// whether or not a Hetzner rebuild would have preserved the attachment,
		// rather than resting on an assumption about Hetzner's behaviour.
		await step.runAction(
			internal.boxes.infra.hetznerVps.detachParkingVolume,
			{ volumeId },
			{ retry: true }
		);
		const server = await step.runAction(
			internal.boxes.infra.hetznerVps.rebuildServer,
			{ serverId },
			{ retry: true }
		);
		await step.runMutation(
			internal.boxes.operation.record.recordServerRebuilt,
			{
				boxId: args.boxId,
				serverId: server.serverId,
				serverType: server.serverType,
				location: server.location,
				ipv4: server.ipv4,
				ipv6: server.ipv6
			}
		);
		await step.runAction(
			internal.boxes.infra.hetznerVps.attachParkingVolume,
			{ volumeId, serverId },
			{ retry: true }
		);
		await step.runAction(
			internal.boxes.infra.host.copyFromParking,
			{ boxId: args.boxId, volumeId },
			{ retry: true }
		);
		await step.runAction(
			internal.boxes.infra.host.verifyParkingBack,
			{ boxId: args.boxId, volumeId },
			{ retry: true }
		);

		// Copy-back verified: the fresh host is authoritative again. Unmount and
		// detach first, then clear the pointer before deletion. If execution stops
		// there, reconciliation deletes the harmless orphan; no persisted pointer
		// can ever name a volume that was already deleted.
		await step.runAction(
			internal.boxes.infra.host.unmountParking,
			{ boxId: args.boxId },
			{ retry: true }
		);
		await step.runAction(
			internal.boxes.infra.hetznerVps.detachParkingVolume,
			{ volumeId },
			{ retry: true }
		);
		await step.runMutation(internal.boxes.operation.record.clearParkingVolume, {
			boxId: args.boxId
		});
		await step.runAction(
			internal.boxes.infra.hetznerVps.deleteParkingVolume,
			{ volumeId },
			{ retry: true }
		);

		// Rewrite the runtime files, force-recreate the stack, and hold until the
		// editor answers, so a reported success means the box genuinely serves.
		await step.runAction(
			internal.boxes.infra.host.repairRuntime,
			{ boxId: args.boxId },
			{ retry: true }
		);
		await step.runMutation(
			internal.boxes.operation.record.markRepairSucceeded,
			{
				boxId: args.boxId,
				operationId: args.operationId
			}
		);
	}
});
