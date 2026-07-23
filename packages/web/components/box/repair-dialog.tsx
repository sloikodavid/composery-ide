"use client";

import { LoaderIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AnimatedIconButton } from "@/components/animated-icon";
import { Badge } from "@/components/base/badge";
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
	unavailableReason,
	type LastOperation
} from "@/components/box/operation-dialog";
import { ToneIcon } from "@/components/box/tone-icon";
import { isOperationAllowed } from "@/convex/model/box/operation";
import type { RecoveryStatus } from "@/convex/model/box/recovery";
import { type BoxStatus } from "@/convex/model/box/status";
import { errorMessage } from "@/lib/error-message";
import { CHECKS, summarize } from "@/lib/box/repair";

const TONE_BADGE = {
	ok: "success",
	warn: "warning",
	bad: "destructive",
	muted: "secondary"
} as const;

// The last repair this box attempted. The dialog reads this record for the
// precise progress and the error text behind a failure.
export type RepairOperation = LastOperation;

function repairNotice(repair: RepairOperation | null) {
	return lastOperationNotice(repair, {
		inFlight:
			"Repairing this box now. The checks above update when it finishes.",
		failed: (error) =>
			`The last repair failed: ${error}. Your files are safe on the parking volume; repair again to resume.`,
		succeeded: () => "The last repair finished."
	});
}

// Owner and console box pages share this. It shows a read-only picture of every
// layer of the box, then offers one data-preserving Repair action - the box's
// single recovery lever. Nothing is destroyed without a verified copy of it
// existing first, so the action needs no confirmation step. The caller's check
// loads the status and onRepair performs the repair. A caller that opens the
// dialog from outside (a menu) passes `open` and `onOpenChange`; absent, the
// dialog owns its state and renders its own button.
export function RepairDialog({
	boxStatus,
	busy,
	check,
	onOpenChange,
	onRepair,
	open: openProp,
	repair,
	slug
}: {
	boxStatus: BoxStatus;
	busy: string | null;
	check: () => Promise<RecoveryStatus>;
	onOpenChange?: (open: boolean) => void;
	onRepair: () => Promise<void>;
	open?: boolean;
	repair: RepairOperation | null;
	slug: string;
}) {
	const [internalOpen, setInternalOpen] = useState(false);
	const open = openProp ?? internalOpen;
	const [checking, setChecking] = useState(false);
	const [status, setStatus] = useState<RecoveryStatus | null>(null);

	function changeOpen(nextOpen: boolean) {
		if (onOpenChange) onOpenChange(nextOpen);
		else setInternalOpen(nextOpen);
	}

	// Ask the same table the backend enforces, so the dialog can never offer a
	// repair that `startOperation` will refuse. A stopped box is the case
	// that matters: its server is powered off, so probing it would report every
	// layer as missing and raise a false alarm about a box that is merely off.
	const repairable = isOperationAllowed(boxStatus, "repair");

	const refresh = useCallback(async () => {
		setChecking(true);
		// Clear first, so "Check again" shows the same loading state as opening
		// the dialog. Leaving the old rows up reads as nothing having happened.
		setStatus(null);
		try {
			setStatus(await check());
		} catch (error) {
			setStatus(null);
			toast.error("Check failed", { description: errorMessage(error) });
		} finally {
			setChecking(false);
		}
	}, [check]);

	// Refresh when the dialog opens, whoever opened it - its own button or a
	// menu. The closed-to-open edge is guarded because `refresh` changes
	// identity when the caller re-renders; the effect must not re-run while it
	// stays open. It starts false so a dialog that mounts already open (a menu
	// opened it) refreshes on first effect instead of being skipped.
	const wasOpen = useRef(false);
	useEffect(() => {
		if (!wasOpen.current && open && repairable) {
			void refresh();
		}
		wasOpen.current = open;
	}, [open, refresh, repairable]);

	const summary = status ? summarize(status) : null;
	const notice = repairNotice(repair);
	const repairing = isOperationInFlight(repair);

	return (
		<>
			{openProp === undefined ? (
				<AnimatedIconButton
					icon="wrench"
					iconPosition="start"
					onClick={() => changeOpen(true)}
					variant="outline"
				>
					Repair
				</AnimatedIconButton>
			) : null}
			<Dialog onOpenChange={changeOpen} open={open}>
				<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
					<DialogHeader>
						<DialogTitle>Repair {slug}</DialogTitle>
						<DialogDescription>
							Rebuilds the box from a clean setup while preserving files.
						</DialogDescription>
					</DialogHeader>

					{repairable ? (
						<>
							<div className="flex items-center justify-between gap-3">
								{summary ? (
									<div className="flex min-w-0 items-center gap-2">
										<ToneIcon tone={summary.tone} />
										<span className="truncate text-sm font-medium">
											{summary.label}
										</span>
									</div>
								) : (
									<div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
										{checking ? (
											<>
												<LoaderIcon className="size-4 shrink-0 animate-spin" />
												<span className="truncate">Checking…</span>
											</>
										) : (
											<>
												<ToneIcon tone="muted" />
												<span className="truncate">
													Couldn&apos;t check the box
												</span>
											</>
										)}
									</div>
								)}
								<AnimatedIconButton
									disabled={checking}
									icon="rotate-cw"
									iconPosition="start"
									onClick={() => void refresh()}
									size="sm"
									variant="outline"
								>
									Check again
								</AnimatedIconButton>
							</div>

							{/* One placeholder bar per real check, in a row of the same
							    height (py-2.5 either side of a 36px body), so the list is
							    the same size loading as loaded and the dialog never
							    resizes. */}
							<div className="overflow-hidden rounded-2xl">
								{CHECKS.map((item) => {
									const state = status ? item.read(status) : null;
									if (!state) {
										return (
											<div className="px-3 py-2.5" key={item.label}>
												<div className="h-9 animate-pulse rounded-lg bg-muted" />
											</div>
										);
									}
									return (
										<div
											className="flex items-start gap-3 px-3 py-2.5"
											key={item.label}
										>
											<ToneIcon className="mt-0.5" tone={state.tone} />
											<div className="min-w-0 flex-1">
												<p className="text-sm font-medium">{item.label}</p>
												<p className="text-xs text-muted-foreground">
													{item.description}
												</p>
											</div>
											<Badge variant={TONE_BADGE[state.tone]}>
												{state.label}
											</Badge>
										</div>
									);
								})}
							</div>
						</>
					) : (
						<Notice tone="muted">
							{unavailableReason(boxStatus, "repair", repairing)}
						</Notice>
					)}

					{notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}

					<AnimatedIconButton
						className="w-full"
						disabled={busy !== null || !repairable || repairing}
						icon="wrench"
						iconPosition="start"
						onClick={() => void onRepair()}
					>
						{busy === "repair" || repairing ? "Repairing…" : "Repair"}
					</AnimatedIconButton>
				</DialogContent>
			</Dialog>
		</>
	);
}
