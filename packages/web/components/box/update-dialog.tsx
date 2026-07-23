"use client";

import { useState } from "react";
import { AnimatedIconButton } from "@/components/animated-icon";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle
} from "@/components/base/dialog";
import {
	isOperationInFlight,
	lastOperationNotice,
	Notice,
	recreateNotice,
	unavailableReason,
	type LastOperation,
	type OperationNotice
} from "@/components/box/operation-dialog";
import { isOperationAllowed } from "@/convex/model/box/operation";
import type { RuntimeStanding } from "@/convex/boxes/version";
import { type BoxStatus } from "@/convex/model/box/status";
import { formatDateTime } from "@/lib/datetime";
import { standingNotices } from "@/lib/box/update";

// The last update this box attempted. The status field on the box says one ran;
// this record is where the error text behind a failure lives.
export type UpdateOperation = LastOperation;

function updateNotice(update: UpdateOperation | null) {
	return lastOperationNotice(update, {
		inFlight:
			"Updating this box now. The versions above update when it finishes.",
		// True by construction: the update advances the box's recorded image only
		// after the new container has answered, so a failure leaves the row naming
		// the image that last served and Repair rebuilds from it.
		failed: (error) =>
			`The last update failed: ${error}. This box is still recorded on the version it was running; try again, or repair it to put that version back.`,
		succeeded: (finishedAt) =>
			finishedAt
				? `The last update finished ${formatDateTime(finishedAt)}.`
				: "The last update finished."
	});
}

// The trigger carries the standing itself rather than the page growing a banner
// for it: the action bar already names state in a button ("Renews 3 Mar"), and an
// owner who never opens this dialog still sees that an update is waiting. The box
// list's menu item reads the same words, so a waiting update is visible from the
// list too.
export function updateLabel(runtime: RuntimeStanding) {
	if (runtime.required) return "Update required";
	if (runtime.updateAvailable) return "Update available";
	return "Update";
}

// Owner and console box pages share this. It names the version the box runs and
// the one available - "Unknown" where we have neither, never a guessed number -
// says plainly what an update costs, and offers the one Update action. The
// caller's onUpdate performs it. A caller that opens the dialog from outside (a
// menu) passes `open` and `onOpenChange`; absent, the dialog owns its state and
// renders its own button.
export function UpdateDialog({
	boxStatus,
	busy,
	onOpenChange,
	onUpdate,
	open: openProp,
	runtime,
	slug,
	update
}: {
	boxStatus: BoxStatus;
	busy: string | null;
	onOpenChange?: (open: boolean) => void;
	onUpdate: () => Promise<void>;
	open?: boolean;
	runtime: RuntimeStanding;
	slug: string;
	update: UpdateOperation | null;
}) {
	const [internalOpen, setInternalOpen] = useState(false);
	const open = openProp ?? internalOpen;

	function changeOpen(nextOpen: boolean) {
		if (onOpenChange) onOpenChange(nextOpen);
		else setInternalOpen(nextOpen);
	}

	// Ask the same table the backend enforces, so the dialog can never offer an
	// update `startOperation` will refuse. Only a running box (or one whose
	// last update failed) can be updated: the host has to answer over SSH for the
	// new image to be pulled at all.
	const updatable = isOperationAllowed(boxStatus, "update");
	const updating = isOperationInFlight(update);

	const outcome = updateNotice(update);
	const notices: OperationNotice[] = [
		...standingNotices(runtime),
		...(updatable
			? []
			: [
					{
						tone: "muted" as const,
						text: unavailableReason(boxStatus, "update", updating)
					}
				]),
		...(outcome ? [outcome] : [])
	];

	const versions: [string, string | null][] = [
		["Running now", runtime.currentVersion],
		["Available", runtime.availableVersion]
	];

	return (
		<>
			{openProp === undefined ? (
				<AnimatedIconButton
					icon="rotate-cw"
					iconPosition="start"
					onClick={() => changeOpen(true)}
					variant="outline"
				>
					{updateLabel(runtime)}
				</AnimatedIconButton>
			) : null}
			<Dialog onOpenChange={changeOpen} open={open}>
				<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
					<DialogHeader>
						<DialogTitle>Update {slug}</DialogTitle>
						<DialogDescription>
							Moves this box onto the current Composery release and keeps its
							files.
						</DialogDescription>
					</DialogHeader>

					<div className="overflow-hidden rounded-2xl">
						{versions.map(([label, version]) => (
							<div
								className="flex items-baseline justify-between gap-3 px-3 py-2.5"
								key={label}
							>
								<p className="text-sm font-medium">{label}</p>
								<p className="min-w-0 truncate text-sm text-muted-foreground">
									{version ?? "Unknown"}
								</p>
							</div>
						))}
					</div>

					{/* Not muted like the rows below it: this is the one thing an owner
					    must not be surprised by after pressing Update. */}
					<Notice muted={false} tone="warn">
						{recreateNotice("Updating")}
					</Notice>

					{notices.map((notice) => (
						<Notice key={notice.text} tone={notice.tone}>
							{notice.text}
						</Notice>
					))}

					<AnimatedIconButton
						className="w-full"
						disabled={busy !== null || !updatable || updating}
						icon="rotate-cw"
						iconPosition="start"
						onClick={() => void onUpdate()}
					>
						{busy === "update" || updating ? "Updating…" : "Update"}
					</AnimatedIconButton>
				</DialogContent>
			</Dialog>
		</>
	);
}
