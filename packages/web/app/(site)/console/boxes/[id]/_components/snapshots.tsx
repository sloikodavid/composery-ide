"use client";

import { useMutation, useQuery } from "convex/react";
import { SnapshotsDialog } from "@/components/box/snapshots-dialog";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { isOperationAllowed } from "@/convex/model/box/operation";
import { type BoxStatus } from "@/convex/model/box/status";
import type { BoxPlan, SnapshotSplit } from "@/convex/model/box/plan";

export function BoxSnapshots({
	boxId,
	plan,
	split,
	status
}: {
	boxId: Id<"boxes">;
	plan: BoxPlan;
	split: SnapshotSplit;
	status: BoxStatus;
}) {
	const snapshots = useQuery(api.staff.boxes.snapshots, { boxId });
	const createSnapshot = useMutation(api.staff.boxes.createSnapshot);
	const restoreSnapshot = useMutation(api.staff.boxes.restoreSnapshot);
	const deleteSnapshot = useMutation(api.staff.boxes.deleteSnapshot);

	return (
		<SnapshotsDialog
			canRestore={isOperationAllowed(status, "restore")}
			canTake={isOperationAllowed(status, "snapshot")}
			onDelete={(id) => deleteSnapshot({ snapshotId: id })}
			onRestore={(id) => restoreSnapshot({ snapshotId: id })}
			onTake={() => createSnapshot({ boxId })}
			plan={plan}
			split={split}
			snapshots={snapshots}
		/>
	);
}
