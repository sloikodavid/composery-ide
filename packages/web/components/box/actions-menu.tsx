"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import {
	CopyIcon,
	CreditCardIcon,
	DownloadIcon,
	LockIcon,
	PenToolIcon,
	RotateCwIcon,
	ScanTextIcon,
	SquarePenIcon,
	Trash2Icon,
	WrenchIcon
} from "lucide-react";
import { useState, type ReactElement } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from "@/components/base/dropdown-menu";
import { AgentStack } from "@/components/box/agent-stack";
import { ChangeSlugDialog } from "@/components/box/change-slug-dialog";
import { QrDialog } from "@/components/box/qr-dialog";
import { RepairDialog } from "@/components/box/repair-dialog";
import { ResetDialog } from "@/components/box/reset-dialog";
import { SnapshotsDialog } from "@/components/box/snapshots-dialog";
import { SshDialog } from "@/components/box/ssh-dialog";
import {
	PRIMARY_ACTION,
	PRIMARY_ICON,
	PRIMARY_LABEL,
	STOP_DESCRIPTION
} from "@/components/box/status-action";
import { UpdateDialog, updateLabel } from "@/components/box/update-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { api } from "@/convex/_generated/api";
import { isOperationAllowed } from "@/convex/model/box/operation";
import { boxPath } from "@/convex/model/box/path";
import type { BoxActions } from "@/hooks/use-box-actions";
import { billingLabel } from "@/lib/box/billing";
import type { BoxDetail, OwnerBox } from "@/lib/box/detail";
import { copyToClipboard } from "@/lib/clipboard";

// Which dialog the menu opened, if any.
type MenuTarget =
	| "connect"
	| "qr"
	| "repair"
	| "reset"
	| "slug"
	| "snapshots"
	| "stop"
	| "update";

// A box's actions as one dropdown, shared by the box page and the box list.
//
// The two surfaces differ in what is left outside it. The box page keeps what an
// owner reaches for on buttons beside this menu - the status action, connecting,
// updating, the plan - so the menu holds the rest. A list row has room for one
// button, so `primary` puts that outer set into the menu as well and the row
// offers every action the box page does. One component either way: an action that
// exists in two places is an action that goes missing from one of them.
//
// The dialogs render beside the menu, never inside it: the menu's popup unmounts
// when it closes, which would take an open dialog with it.
export function BoxActionsMenu({
	actions,
	box,
	detail,
	onOpenChange,
	primary = false,
	trigger
}: {
	actions: BoxActions;
	box: OwnerBox;
	// Absent while a list row's menu is still loading it. Every item that reads a
	// box's operations waits for it rather than claiming there are none.
	detail: BoxDetail | undefined;
	onOpenChange?: (open: boolean) => void;
	primary?: boolean;
	trigger: ReactElement;
}) {
	const [target, setTarget] = useState<MenuTarget | null>(null);
	const { busy } = actions;

	// Which operation the box's status leads with - `PRIMARY_ACTION`'s decision,
	// the same table the status button reads. Owners have no unsuspend, so a
	// suspended box offers nothing here, exactly as the button offers nothing when
	// no unsuspend handler is passed to it.
	const leads = PRIMARY_ACTION[box.status as keyof typeof PRIMARY_ACTION];

	return (
		<>
			<DropdownMenu onOpenChange={onOpenChange}>
				<DropdownMenuTrigger render={trigger} />
				<DropdownMenuContent align="end" className="w-56">
					{primary ? (
						<>
							{leads === "stop" ? (
								<DropdownMenuItem onClick={() => setTarget("stop")}>
									<PRIMARY_ICON.stop.static className="text-destructive" />
									{PRIMARY_LABEL.stop}
								</DropdownMenuItem>
							) : null}
							{leads === "start" ? (
								<DropdownMenuItem
									disabled={busy !== null}
									onClick={() => void actions.start()}
								>
									<PRIMARY_ICON.start.static className="text-success" />
									{PRIMARY_LABEL.start}
								</DropdownMenuItem>
							) : null}
							{leads === "create" ? (
								<DropdownMenuItem
									disabled={busy !== null}
									onClick={() => void actions.retryCreate()}
								>
									<PRIMARY_ICON.create.static />
									{PRIMARY_LABEL.create}
								</DropdownMenuItem>
							) : null}
							<DropdownMenuItem
								disabled={box.status !== "running"}
								onClick={() => setTarget("connect")}
							>
								<AgentStack />
								Connect remotely
							</DropdownMenuItem>
							<DropdownMenuItem
								disabled={!detail}
								onClick={() => setTarget("update")}
							>
								<RotateCwIcon />
								{detail ? updateLabel(detail.runtime) : "Update"}
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								onClick={() =>
									void copyToClipboard(box.runtimeUrl, "Link copied")
								}
							>
								<CopyIcon />
								Copy link
							</DropdownMenuItem>
							<DropdownMenuItem onClick={() => setTarget("qr")}>
								<ScanTextIcon />
								Show QR
							</DropdownMenuItem>
							<DropdownMenuSeparator />
						</>
					) : null}

					<DropdownMenuItem
						render={<Link href={`${boxPath(box.id)}/configuration`} />}
					>
						<PenToolIcon />
						Configuration
					</DropdownMenuItem>
					<DropdownMenuItem
						render={
							<a
								href={new URL("change-password", box.runtimeUrl).toString()}
								rel="noreferrer"
								target="_blank"
							/>
						}
					>
						<LockIcon />
						Change password
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => setTarget("slug")}>
						<SquarePenIcon />
						Change slug
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => setTarget("snapshots")}>
						<DownloadIcon />
						Snapshots
					</DropdownMenuItem>
					{primary ? (
						<DropdownMenuItem
							disabled={!detail || box.comp || busy !== null}
							onClick={() => void actions.openBilling()}
						>
							<CreditCardIcon />
							{detail ? billingLabel(box, detail.subscription) : "Billing"}
						</DropdownMenuItem>
					) : null}

					<DropdownMenuSeparator />
					<DropdownMenuItem
						disabled={!detail}
						onClick={() => setTarget("repair")}
					>
						<WrenchIcon />
						Repair
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => setTarget("reset")}
						variant="destructive"
					>
						<Trash2Icon />
						Reset
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			<ChangeSlugDialog
				onOpenChange={(open) => setTarget(open ? "slug" : null)}
				onSubmit={actions.changeSlug}
				open={target === "slug"}
				slug={box.slug}
			/>
			<Snapshots
				box={box}
				onOpenChange={(open) => setTarget(open ? "snapshots" : null)}
				open={target === "snapshots"}
			/>
			<RepairDialog
				boxStatus={box.status}
				busy={busy}
				check={actions.checkRepair}
				onOpenChange={(open) => setTarget(open ? "repair" : null)}
				onRepair={actions.repair}
				open={target === "repair"}
				repair={detail?.repair ?? null}
				slug={box.slug}
			/>
			<ResetDialog
				busy={busy}
				onOpenChange={(open) => setTarget(open ? "reset" : null)}
				onReset={actions.reset}
				open={target === "reset"}
				slug={box.slug}
			/>

			{primary ? (
				<>
					<ConfirmDialog
						confirmLabel={PRIMARY_LABEL.stop}
						description={STOP_DESCRIPTION}
						destructive
						onConfirm={() => void actions.stop()}
						onOpenChange={(open) => setTarget(open ? "stop" : null)}
						open={target === "stop"}
						title={PRIMARY_LABEL.stop}
					/>
					<SshDialog
						host={new URL(box.runtimeUrl).host}
						onOpenChange={(open) => setTarget(open ? "connect" : null)}
						open={target === "connect"}
						slug={box.slug}
					/>
					<QrDialog
						onOpenChange={(open) => setTarget(open ? "qr" : null)}
						open={target === "qr"}
						runtimeUrl={box.runtimeUrl}
					/>
					{detail ? (
						<UpdateDialog
							boxStatus={box.status}
							busy={busy}
							onOpenChange={(open) => setTarget(open ? "update" : null)}
							onUpdate={actions.update}
							open={target === "update"}
							runtime={detail.runtime}
							slug={box.slug}
							update={detail.update}
						/>
					) : null}
				</>
			) : null}
		</>
	);
}

// This box's snapshots, read only while the dialog showing them is open.
//
// The box list renders one of these per row, and a list of twenty-five boxes must
// not read twenty-five boxes' snapshots to draw menus nobody opened. Skipping
// while closed is what keeps the cost of the list the cost of the list.
function Snapshots({
	box,
	onOpenChange,
	open
}: {
	box: OwnerBox;
	onOpenChange: (open: boolean) => void;
	open: boolean;
}) {
	const slug = box.slug;
	const snapshots = useQuery(
		api.owner.boxes.snapshots,
		open ? { slug } : "skip"
	);
	const createSnapshot = useMutation(api.owner.boxes.createSnapshot);
	const restoreSnapshot = useMutation(api.owner.boxes.restoreSnapshot);
	const deleteSnapshot = useMutation(api.owner.boxes.deleteSnapshot);
	const setSnapshotSplit = useMutation(api.owner.boxes.setSnapshotSplit);

	return (
		<SnapshotsDialog
			canRestore={isOperationAllowed(box.status, "restore")}
			canTake={isOperationAllowed(box.status, "snapshot")}
			onDelete={(id) => deleteSnapshot({ snapshotId: id })}
			onOpenChange={onOpenChange}
			onRestore={(id) => restoreSnapshot({ snapshotId: id })}
			onSplitChange={(manualCap) => setSnapshotSplit({ manualCap, slug })}
			onTake={() => createSnapshot({ slug })}
			open={open}
			plan={box.plan}
			snapshots={snapshots}
			split={box.snapshots}
		/>
	);
}
