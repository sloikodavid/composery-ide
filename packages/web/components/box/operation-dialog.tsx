import type { ReactNode } from "react";
import { ToneIcon } from "@/components/box/tone-icon";
import { type BoxOperationStatus } from "@/convex/model/box/operation";
import { type BoxStatus } from "@/convex/model/box/status";
import type { Tone } from "@/lib/box/repair";

// What the Repair and Update dialogs are: a read-only picture of the box, a
// stack of notices explaining what it says, and one button. Everything on this
// page is the part of that they share.

// The last attempt at one operation, as the box page hands it over. Repair and
// Update each declared their own identical copy of this, which is how one of
// them came to list a `cancelled` status the schema has never had.
export type LastOperation = {
	error: string | null;
	finishedAt: number | null;
	status: BoxOperationStatus;
};

export type OperationNotice = { text: string; tone: Tone };

export function isOperationInFlight(operation: LastOperation | null) {
	return operation?.status === "pending" || operation?.status === "running";
}

// One row of the notice stack. The tone glyph and the muted text were written
// out at four call sites, which is why two of them had drifted to a different
// padding.
export function Notice({
	children,
	muted = true,
	tone
}: {
	children: ReactNode;
	// The one thing an owner must not be surprised by is not muted; everything
	// reporting a state they only have to read is.
	muted?: boolean;
	tone: Tone;
}) {
	return (
		<div className="flex items-start gap-3 rounded-2xl bg-muted/50 px-3 py-2.5">
			<ToneIcon className="mt-0.5" tone={tone} />
			<div
				className={`min-w-0 flex-1 text-sm${muted ? " text-muted-foreground" : ""}`}
			>
				{children}
			</div>
		</div>
	);
}

// What the last attempt at this operation says about the box now.
//
// The four statuses are handled here rather than in each dialog, so neither can
// grow a fifth branch the schema does not have or miss one it does. The prose is
// the caller's, because "the last repair failed" and "the last update failed"
// are followed by genuinely different advice.
export function lastOperationNotice(
	operation: LastOperation | null,
	copy: {
		failed: (error: string) => string;
		inFlight: string;
		succeeded: (finishedAt: number | null) => string;
	}
): OperationNotice | null {
	if (!operation) return null;

	switch (operation.status) {
		case "pending":
		case "running":
			return { text: copy.inFlight, tone: "muted" };
		case "failed":
			return {
				text: copy.failed(operation.error ?? "no reason recorded"),
				tone: "bad"
			};
		case "succeeded":
			return { text: copy.succeeded(operation.finishedAt), tone: "ok" };
	}
}

// Why the button is not offered, in the box's own terms.
//
// Both dialogs asked this question with the same three-branch shape and their
// own wording, and both got the suspended case wrong: they told an owner to
// start a box that is suspended, which is the one state an owner cannot start it
// out of. Written out per operation rather than assembled from its identifier -
// prose and identifiers are separate vocabularies, and "This box can't be
// change_config'd" is what assembling it produces.
const UNAVAILABLE = {
	repair: {
		inFlight: "A repair is already running on this box.",
		other: "This box can't be repaired in its current state.",
		stopped: "This box is not running. Start it before repairing.",
		suspended:
			"This box is suspended, so it can't be repaired. Contact support to have it unsuspended."
	},
	update: {
		inFlight: "An update is already running on this box.",
		other: "This box can't be updated in its current state.",
		stopped: "This box is not running. Start it before updating.",
		suspended:
			"This box is suspended, so it can't be updated. Contact support to have it unsuspended."
	}
} as const;

export function unavailableReason(
	boxStatus: BoxStatus,
	operation: keyof typeof UNAVAILABLE,
	inFlight: boolean
) {
	const copy = UNAVAILABLE[operation];
	if (inFlight) return copy.inFlight;
	if (boxStatus === "suspended") return copy.suspended;
	if (boxStatus === "stopped") return copy.stopped;
	return copy.other;
}

// Recreating the box's container is what Update and a configuration save both
// cost, and it is the one thing an owner must not be surprised by afterwards.
// One sentence with one verb in front of it, so the two cannot drift into
// promising different things about the same action.
export function recreateNotice(action: "Saving" | "Updating") {
	return `${action} recreates the box's container. Terminals, running processes and anything unsaved stop, and the box is unreachable until the new one answers. Files on disk and snapshots are kept.`;
}
