import { internal } from "../../_generated/api";
import { captureRollbackSnapshot } from "./snapshotWorkflows";
import { updateAlreadyApplied } from "../version";
import { defineBoxWorkflow } from "./boxWorkflow";

// Update - moves a box to the runtime image the deployment's channel currently
// resolves to, keeping its files. It is the only data-preserving way a box
// changes version: Reset re-resolves the channel too but rebuilds the host and
// keeps nothing, and Repair deliberately re-pulls the image the box is already
// pinned to, because "get me working again" must not also change what is
// running.
//
// The whole operation is a container recreate. The host is untouched, the named
// volumes holding the box's files are untouched, and persistence is built for
// exactly this: the new image ships a new lower and the box's delta is laid back
// over it on boot (see docs/developing/web/maintenance.md).
//
// Ordering is the only subtle part, and it is what makes a failure recoverable:
//
//   1. resolve the channel to a digest - a moving tag must not be re-resolved
//      later in the operation, or the compose file and the row could name two
//      different images;
//   2. write that digest into the box's compose file and bring the stack up,
//      holding until the editor answers;
//   3. only then advance `box.runtime_image`.
//
// Between 2 and 3 the row still names the image that last served. So any throw
// leaves the box in `update_failed` with a row Repair can rebuild from, and
// Repair rewrites the old compose file and puts the box back.
//
// That covers a *failed* update, and only that. A successful one is the case the
// rollback snapshot exists for, because nothing else can undo it: persistence lays the box's delta over the image's
// baseline, and its boot pass drops the overlay's whiteouts when that baseline
// changes - so once the new image has booted, a file the owner deleted is back
// and putting the old image on cannot remove it again. The disk taken before the
// update is the only way to that state, which is why the capture is a step of
// this operation rather than something the owner has to remember.
export const updateBox = defineBoxWorkflow({
	type: "update",
	run: async (step, args) => {
		const box = await step.runQuery(
			internal.boxes.queries.getBoxLifecycleSnapshot,
			{ boxId: args.boxId }
		);

		const release = await step.runAction(
			internal.boxes.infra.image.resolveConfiguredRuntimeRelease,
			{},
			{ retry: true }
		);

		// Already on the target digest. The decision, and why settling cleanly is
		// the honest outcome, is `updateAlreadyApplied` - a workflow body is
		// excluded from coverage and mutation testing, so nothing written here
		// would be checked.
		if (updateAlreadyApplied(box.runtime_image, release.image)) {
			await step.runMutation(
				internal.boxes.operation.record.setBoxStatusWithOperationSucceeded,
				{
					boxId: args.boxId,
					operationId: args.operationId,
					outcome: "skipped",
					status: "running"
				}
			);
			return;
		}

		// After the skip above, and before anything is touched. After, because a
		// box already on the target digest is not going to change and a snapshot of
		// it would evict the one taken before the change that did happen. Before,
		// because this is the only thing that can undo a successful update:
		// the row-ordering below recovers a *failed* one, and a failure is not what
		// the owner needs protecting from here.
		await captureRollbackSnapshot(step, args.boxId, "update");

		await step.runAction(
			internal.boxes.infra.host.updateRuntime,
			{ boxId: args.boxId, runtimeImage: release.image },
			{ retry: true }
		);

		await step.runMutation(
			internal.boxes.operation.record.markUpdateSucceeded,
			{
				boxId: args.boxId,
				operationId: args.operationId,
				runtimeImage: release.image,
				runtimeVersion: release.version
			}
		);

		await step.runMutation(
			internal.boxes.snapshots.supersedeRollbackSnapshots,
			{ boxId: args.boxId }
		);
	}
});
