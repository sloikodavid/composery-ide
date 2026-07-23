"use client";

import { useState } from "react";
import { AnimatedIconButton } from "@/components/animated-icon";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle
} from "@/components/base/dialog";
import { SortHeader } from "@/components/sort-header";
import { StatusText } from "@/components/box/status-text";
import {
	Table,
	TableBody,
	TableCell,
	TableEmptyRow,
	TableHead,
	TableHeader,
	TableLoadingRow,
	TableRow
} from "@/components/base/table";
import type { Id } from "@/convex/_generated/dataModel";
import { operationLabel } from "@/convex/model/box/operation";
import {
	BOX_PLANS,
	type BoxPlan,
	type SnapshotSplit
} from "@/convex/model/box/plan";
import {
	SNAPSHOT_CLASSES,
	type RollbackSnapshotOperation,
	type SnapshotClass,
	type SnapshotStatus
} from "@/convex/model/box/snapshot";
import { useBusyAction } from "@/hooks/use-busy-action";
import { useTableSort } from "@/hooks/use-table-sort";
import { formatDate, formatDateTime } from "@/lib/datetime";

type SnapshotRow = {
	id: Id<"box_snapshots">;
	beforeOperation: RollbackSnapshotOperation | null;
	class: SnapshotClass;
	status: SnapshotStatus;
	sizeBytes: number | null;
	createdAt: number;
	completedAt: number | null;
	expiresAt: number | null;
};

// What each class is called, in the reader's words rather than the row's. A
// rollback snapshot is named for the operation it was taken before, because
// "Rollback" says what we call it and "Before update" says what it is for.
const CLASS_LABEL = {
	manual: "Manual",
	scheduled: "Automatic",
	rollback: "Safety copy",
	duplicate: "Duplicate source"
} as const satisfies Record<SnapshotClass, string>;

function classLabel(snapshot: SnapshotRow) {
	if (snapshot.class !== "rollback" || !snapshot.beforeOperation) {
		return CLASS_LABEL[snapshot.class];
	}
	return `Before ${operationLabel(snapshot.beforeOperation, true)}`;
}

const SNAPSHOT_SORT = {
	created: (row: SnapshotRow) => row.createdAt,
	type: (row: SnapshotRow) => row.class,
	size: (row: SnapshotRow) => row.sizeBytes ?? 0,
	status: (row: SnapshotRow) => row.status
};

function formatSize(bytes: number | null) {
	if (bytes === null) return "-";
	const gb = bytes / 1e9;
	return gb >= 1
		? `${gb.toFixed(2)} GB`
		: `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

export function SnapshotsDialog({
	canRestore,
	canTake,
	onOpenChange,
	onDelete,
	onRestore,
	onSplitChange,
	onTake,
	open: openProp,
	plan,
	snapshots,
	split
}: {
	canRestore: boolean;
	canTake: boolean;
	onOpenChange?: (open: boolean) => void;
	onDelete: (id: Id<"box_snapshots">) => Promise<unknown>;
	onRestore: (id: Id<"box_snapshots">) => Promise<unknown>;
	onTake: () => Promise<unknown>;
	// Absent for staff, who do not set an owner's split. Its presence is what
	// decides whether the control is offered at all, so there is no second flag
	// that could disagree with it.
	onSplitChange?: (manualCap: number) => Promise<unknown>;
	// Read rather than passed as a boolean, so this dialog and the mutation that
	// would refuse it are answering the same question from the same table.
	open?: boolean;
	plan: BoxPlan;
	snapshots: SnapshotRow[] | undefined;
	split: SnapshotSplit;
}) {
	const [internalOpen, setInternalOpen] = useState(false);
	const open = openProp ?? internalOpen;
	const { busy, run } = useBusyAction();
	// The slider is dragged locally and committed on release, so a drag across
	// five positions is one write rather than five.
	const [draftManual, setDraftManual] = useState<number | null>(null);
	const manual = draftManual ?? split.manual;
	const cap = BOX_PLANS[plan].snapshotCap;
	const { sort, sortedRows } = useTableSort(snapshots ?? [], SNAPSHOT_SORT);

	function changeOpen(nextOpen: boolean) {
		if (onOpenChange) onOpenChange(nextOpen);
		else setInternalOpen(nextOpen);
	}

	return (
		<>
			{openProp === undefined ? (
				<AnimatedIconButton
					icon="download"
					iconPosition="start"
					onClick={() => changeOpen(true)}
					variant="outline"
				>
					Snapshot
				</AnimatedIconButton>
			) : null}
			<Dialog onOpenChange={changeOpen} open={open}>
				<DialogContent size="panel">
					<DialogHeader>
						<DialogTitle>Snapshots</DialogTitle>
						<DialogDescription>
							{BOX_PLANS[plan].manualSnapshots
								? "Restore points for this box. Taking one doesn't interrupt it."
								: "Restore points for this box, taken automatically once a day."}
						</DialogDescription>
					</DialogHeader>

					{/* A plan without capture-on-demand gets a sentence, not a disabled
					    button: a greyed-out control with no reason beside it reads as
					    "broken", and the honest answer - this plan takes them for you,
					    and the other one lets you take your own - is also the useful
					    one. Restoring and deleting stay available either way, because
					    the automatic snapshots are just as much the owner's.

					    No cap is quoted in that sentence on purpose: it is
					    staff-configurable from the console, so a figure here would be a
					    second copy that goes wrong the first time anyone changes it. The
					    list below is the honest answer to "how many do I have". */}
					{onSplitChange && BOX_PLANS[plan].manualSnapshots ? (
						<div className="space-y-2 rounded-2xl bg-card p-4">
							<div className="flex items-baseline justify-between gap-3">
								<label className="text-sm font-medium" htmlFor="snapshot-split">
									How your {cap} snapshots are used
								</label>
								<span className="text-xs text-muted-foreground tabular-nums">
									{cap - manual} automatic / {manual} yours
								</span>
							</div>
							<input
								className="w-full accent-control"
								disabled={busy === "snapshot-split"}
								id="snapshot-split"
								max={cap}
								min={0}
								onChange={(event) => setDraftManual(Number(event.target.value))}
								onPointerUp={() => {
									if (draftManual === null || draftManual === split.manual)
										return;
									run("snapshot-split", "Snapshot split updated", () =>
										onSplitChange(draftManual)
									);
								}}
								step={1}
								type="range"
								value={manual}
							/>
							{/* Both ends are reachable and both are honest choices, so each
							    one says what it costs rather than being disallowed. */}
							<p className="text-xs text-pretty text-muted-foreground">
								{manual === cap
									? "Every slot is yours to take - this box will not be snapshotted automatically."
									: manual === 0
										? "Every slot is automatic. Raise this to keep some for snapshots you take yourself."
										: "Automatic snapshots are taken daily; the rest are yours to take whenever you like."}
							</p>
						</div>
					) : null}

					{BOX_PLANS[plan].manualSnapshots ? (
						<div className="flex justify-end">
							<AnimatedIconButton
								disabled={!canTake || busy === "snapshot"}
								icon="download"
								iconPosition="start"
								onClick={() => run("snapshot", "Taking snapshot", onTake)}
							>
								New snapshot
							</AnimatedIconButton>
						</div>
					) : (
						<p className="text-sm text-muted-foreground">
							{BOX_PLANS[plan].label} snapshots this box every day. Switch to{" "}
							{BOX_PLANS.pro.label} to also take one whenever you want.
						</p>
					)}

					<div className="overflow-hidden rounded-2xl bg-card">
						<Table cols={["fluid", "short", "short", "status", "actions-2"]}>
							<TableHeader>
								<TableRow>
									<TableHead className="pl-4">
										<SortHeader label="Created" sort={sort} sortKey="created" />
									</TableHead>
									<TableHead>
										<SortHeader label="Type" sort={sort} sortKey="type" />
									</TableHead>
									<TableHead>
										<SortHeader label="Size" sort={sort} sortKey="size" />
									</TableHead>
									<TableHead>
										<SortHeader label="Status" sort={sort} sortKey="status" />
									</TableHead>
									<TableHead className="pr-4 text-right">
										<span className="sr-only">Actions</span>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{snapshots === undefined ? (
									<TableLoadingRow />
								) : sortedRows.length > 0 ? (
									<>
										{sortedRows.map((snapshot) => {
											const restoreDisabled =
												!canRestore ||
												snapshot.status !== "complete" ||
												busy === "restore";
											return (
												<TableRow
													className="h-14 [&>td]:align-top"
													key={snapshot.id}
												>
													<TableCell className="pl-4">
														<div>
															<p className="font-medium text-foreground">
																{formatDateTime(snapshot.createdAt)}
															</p>
															{snapshot.expiresAt ? (
																<p className="text-xs text-muted-foreground">
																	Expires {formatDate(snapshot.expiresAt)}
																</p>
															) : null}
														</div>
													</TableCell>
													<TableCell className="text-muted-foreground">
														{classLabel(snapshot)}
													</TableCell>
													<TableCell className="tabular-nums text-muted-foreground">
														{formatSize(snapshot.sizeBytes)}
													</TableCell>
													<TableCell>
														<StatusText
															kind="snapshot"
															status={snapshot.status}
														/>
													</TableCell>
													<TableCell className="pr-4 text-right">
														<div className="flex items-center justify-end gap-1">
															<ConfirmDialog
																confirmLabel="Restore"
																description="Replaces the box's current files and state with this snapshot. The box restarts briefly, and this can't be undone."
																destructive
																onConfirm={() =>
																	run("restore", "Restoring snapshot", () =>
																		onRestore(snapshot.id)
																	)
																}
																title="Restore snapshot"
															>
																{(openConfirm) => (
																	<AnimatedIconButton
																		aria-label="Restore snapshot"
																		disabled={restoreDisabled}
																		icon="rotate-cw"
																		iconPosition="only"
																		onClick={openConfirm}
																		size="icon-sm"
																		variant="outline"
																	/>
																)}
															</ConfirmDialog>
															{/* A class this deployment owns gets no delete button
															    rather than a disabled one: it is replaced by the
															    next one automatically and costs the owner nothing
															    from their allowance, so there is no action to
															    offer and nothing to explain. The mutation refuses
															    it too - this only stops the page offering
															    something the control plane would turn down. */}
															{SNAPSHOT_CLASSES[snapshot.class].deletable ? (
																<ConfirmDialog
																	confirmLabel="Delete"
																	description="Permanently removes this snapshot. This can't be undone."
																	destructive
																	onConfirm={() =>
																		run("delete", "Removing snapshot", () =>
																			onDelete(snapshot.id)
																		)
																	}
																	title="Delete snapshot"
																>
																	{(openConfirm) => (
																		<AnimatedIconButton
																			aria-label="Delete snapshot"
																			disabled={busy === "delete"}
																			icon="delete"
																			iconPosition="only"
																			onClick={openConfirm}
																			size="icon-sm"
																			variant="destructive"
																		/>
																	)}
																</ConfirmDialog>
															) : null}
														</div>
													</TableCell>
												</TableRow>
											);
										})}
									</>
								) : (
									<TableEmptyRow>No snapshots yet.</TableEmptyRow>
								)}
							</TableBody>
						</Table>
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}
