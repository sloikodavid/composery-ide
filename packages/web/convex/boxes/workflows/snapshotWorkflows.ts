import { v } from "convex/values";
import type { WorkflowCtx } from "@convex-dev/workflow";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { vSnapshotClass } from "../../schema";
import {
	rollbackCaptureFailure,
	type RollbackSnapshotOperation,
	type SnapshotClass
} from "../../model/box/snapshot";
import {
	snapshotImagePollStatus,
	snapshotPollOutcome,
	snapshotSizeBytes
} from "../snapshotPolicy";
import { defineBoxWorkflow, operationError } from "./boxWorkflow";

// Take one snapshot of this box and wait for the provider image to be usable.
//
// One body, two callers: the standalone capture below, and the rollback snapshot
// three destructive operations take before they run. It deliberately knows
// nothing about operations - it neither starts nor closes one - so the same steps
// work whether the capture *is* the operation or is the first step of another.
//
// Waiting for the image to reach `available` is not a nicety, and no caller may
// reorder it: a snapshot is only a way back once the provider says the image
// exists, and Hetzner serializes a server's actions, so a rebuild started beside
// a running `create_image` fails outright.
async function captureSnapshotImage(
	step: WorkflowCtx,
	args: {
		beforeOperation?: RollbackSnapshotOperation;
		boxId: Id<"boxes">;
		class: SnapshotClass;
	}
) {
	const box = await step.runQuery(
		internal.boxes.queries.getBoxLifecycleSnapshot,
		{ boxId: args.boxId }
	);
	if (!box.hetzner_server_id) {
		throw new Error("Box has no Hetzner server to snapshot.");
	}

	const { snapshotRowId } = await step.runMutation(
		internal.boxes.snapshots.beginSnapshot,
		{
			boxId: args.boxId,
			beforeOperation: args.beforeOperation,
			class: args.class
		}
	);

	try {
		const { imageId, actionId } = await step.runAction(
			internal.boxes.infra.hetznerVps.createSnapshotImage,
			{
				serverId: box.hetzner_server_id,
				slug: box.slug,
				snapshotClass: args.class,
				snapshotRef: snapshotRowId
			},
			{ retry: true }
		);
		await step.runMutation(internal.boxes.snapshots.markCreating, {
			snapshotRowId,
			imageId,
			actionId
		});

		if (actionId !== undefined) {
			let waited = 0;
			for (;;) {
				const action = await step.runAction(
					internal.boxes.infra.hetznerVps.getAction,
					{ actionId },
					{ retry: true }
				);
				const outcome = snapshotPollOutcome({
					error: action.error,
					status: action.status,
					waitedMs: waited
				});
				if (outcome.type === "complete") break;
				if (outcome.type === "failed") throw new Error(outcome.error);
				await step.sleep(outcome.delayMs);
				waited += outcome.delayMs;
			}
		}

		let imageSizeGb: number | undefined;
		let waited = 0;
		for (;;) {
			const image = await step.runAction(
				internal.boxes.infra.hetznerVps.getImage,
				{ imageId },
				{ retry: true }
			);
			const outcome = snapshotPollOutcome({
				status: snapshotImagePollStatus(image.status),
				waitedMs: waited
			});
			if (outcome.type === "complete") {
				imageSizeGb = image.imageSizeGb;
				break;
			}
			if (outcome.type === "failed") throw new Error(outcome.error);
			await step.sleep(outcome.delayMs);
			waited += outcome.delayMs;
		}
		await step.runMutation(internal.boxes.snapshots.completeSnapshot, {
			snapshotRowId,
			sizeBytes: snapshotSizeBytes(imageSizeGb)
		});
	} catch (error) {
		await step.runMutation(internal.boxes.snapshots.failSnapshot, {
			snapshotRowId,
			error: operationError(error)
		});
		throw error;
	}
}

// The box's way back, taken before an operation that cannot be undone.
//
// Called first, before the operation touches anything, and it aborts the whole
// operation when it fails. That direction is deliberate: an update that succeeds
// is irreversible for the owner's own files - the persistence engine drops the
// overlay's whiteouts when the image baseline changes, so putting the old image
// back does not bring deleted files back - and reset and restore replace the disk
// outright. Going ahead without the copy would be trading a failure the owner can
// retry for a loss nobody can undo.
export async function captureRollbackSnapshot(
	step: WorkflowCtx,
	boxId: Id<"boxes">,
	beforeOperation: RollbackSnapshotOperation
) {
	try {
		await captureSnapshotImage(step, {
			beforeOperation,
			boxId,
			class: "rollback"
		});
	} catch (error) {
		// Named for what the owner is looking at: the box is untouched and the
		// operation did not start, which is a different sentence from the same
		// operation failing part-way through.
		throw new Error(
			rollbackCaptureFailure(beforeOperation, operationError(error))
		);
	}
}

// Capture holds the single-active-operation lock: a Hetzner `create_image` is a
// server action and Hetzner serializes server actions, so a concurrent
// reset/restore would get a raw "server has a running action" error. The box
// stays `running` throughout. Records failure on the row then re-throws so the
// wrapper marks the operation failed and emits one `box.snapshot_failed` event.
export const captureSnapshot = defineBoxWorkflow({
	extraArgs: { class: vSnapshotClass },
	type: "snapshot",
	run: async (step, args) => {
		await captureSnapshotImage(step, {
			boxId: args.boxId,
			class: args.class
		});
	}
});

// Restore rebuilds the VPS disk from the snapshot image, then re-bootstraps so
// the box's current password/slug are reconciled onto the restored disk.
//
// The order below is the whole operation: a way back first, then the disk, then
// the version that disk was taken on, and only then the bootstrap that renders
// the box's compose file from that version.
export const restoreBox = defineBoxWorkflow({
	extraArgs: { snapshotRowId: v.id("box_snapshots") },
	type: "restore",
	run: async (step, args) => {
		const box = await step.runQuery(
			internal.boxes.queries.getBoxLifecycleSnapshot,
			{ boxId: args.boxId }
		);
		if (!box.hetzner_server_id) {
			throw new Error("Box has no Hetzner server to restore.");
		}

		const target = await step.runQuery(
			internal.boxes.snapshots.snapshotRestoreTarget,
			{ snapshotRowId: args.snapshotRowId }
		);
		if (!target) throw new Error("Snapshot is not restorable.");

		await captureRollbackSnapshot(step, args.boxId, "restore");

		await step.runAction(
			internal.boxes.infra.hetznerVps.rebuildServer,
			{ serverId: box.hetzner_server_id, image: target.imageId },
			{ retry: true }
		);

		// Before the bootstrap, which renders the compose file from this field.
		// Writing it afterwards would leave the restored files running whatever
		// image the row named a moment ago - after an update, the very one the
		// owner is rolling away from.
		if (target.runtimeImage) {
			await step.runMutation(internal.boxes.operation.record.setRuntimeImage, {
				boxId: args.boxId,
				runtimeImage: target.runtimeImage,
				runtimeVersion: target.runtimeVersion
			});
		}

		await step.runAction(
			internal.boxes.infra.host.bootstrapRuntime,
			{ boxId: args.boxId },
			{ retry: true }
		);
		await step.runMutation(internal.boxes.snapshots.markRestoreSucceeded, {
			boxId: args.boxId,
			floorClamped: target.floorClamped,
			operationId: args.operationId,
			runtimeImage: target.runtimeImage,
			snapshotRowId: args.snapshotRowId
		});

		await step.runMutation(
			internal.boxes.snapshots.supersedeRollbackSnapshots,
			{ boxId: args.boxId }
		);
	}
});
