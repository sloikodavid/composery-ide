// What a box snapshot is, as words.
//
// Both planes read these: `convex/schema.ts` builds the stored columns from
// them, and the interface labels every one of them (`ui/box/status-text.tsx`
// keeps a `Record<SnapshotStatus, ...>`, so a status added here fails to compile
// until it has a word).
import { operationLabel, type BoxOperationType } from "./operation";

type SnapshotClassSpec = {
	// Which of a box's snapshot slots one of these fills, and therefore what
	// happens when they are all full. `manual` refuses at the cap, `automatic`
	// evicts the oldest complete one of its own class to make room, and
	// `reserved` neither: its slot is held for it outside the plan's allowance
	// (see `RESERVED_SNAPSHOT_SLOTS`), so it is never refused and never evicted.
	//
	// One field decides both, because "which cap does it count against" and "what
	// gives when that cap is reached" are the same question. Two fields could
	// disagree, and they would disagree silently: a class that fell through to the
	// automatic arm would get the automatic cap *and* become open to eviction,
	// which would let a daily snapshot delete the undo point an owner is about to
	// need.
	allowance: "manual" | "automatic" | "reserved";
	// Whether the owner may delete one. False where the class is the deployment's
	// own: a rollback snapshot is superseded automatically and costs the owner
	// nothing from their allowance, so a delete button could only remove a safety
	// net in exchange for nothing.
	deletable: boolean;
	// Whether a completed one is given an expiry at all. A manual snapshot is the
	// owner's own checkpoint and the count cap is its only bound; the classes this
	// deployment takes by itself are kept for `automaticRetentionDays` and then
	// swept.
	expires: boolean;
};

// One row per class, and every rule about a class is in its row. A fourth class
// fails to compile until someone writes what it costs, who may delete it, and
// how long it lives - which is the whole reason this is a table rather than a
// chain of `cls === "manual"` comparisons scattered across four files.
export const SNAPSHOT_CLASSES = {
	// The owner's own checkpoint, taken whenever they ask on a plan that sells
	// capture-on-demand.
	manual: {
		allowance: "manual",
		deletable: true,
		expires: false
	},
	// The daily one. Rolling disaster recovery: kept briefly, and the oldest is
	// evicted rather than refusing tonight's.
	scheduled: {
		allowance: "automatic",
		deletable: true,
		expires: true
	},
	// The undo point this deployment takes for the owner immediately before an
	// operation that cannot be undone by any other means.
	//
	// It exists because a successful update is irreversible for the owner's own
	// files: cloud boxes run the overlay persistence engine, whose boot pass drops
	// overlayfs whiteouts when the image baseline changes, so putting the old
	// image back does not bring deleted files back. Reset and restore replace the
	// disk outright. In all three cases the only way back is a copy taken first.
	rollback: {
		allowance: "reserved",
		deletable: false,
		expires: true
	},
	// The copy taken when an owner presses Duplicate, which the new box is
	// provisioned from.
	//
	// Reserved for the same reason a rollback snapshot is, and it needs its own
	// slot rather than sharing that one: the two coexist. An owner can duplicate a
	// box and then update it while the duplicate's checkout is still open, and the
	// update takes a rollback snapshot of its own - so a class that shared the
	// rollback slot would have one of them evict the other, either destroying the
	// image a paid checkout is about to provision from or removing the undo point
	// for an update already under way.
	//
	// Not deletable by the owner, because it is not theirs to manage: it is held
	// for a checkout they have not completed yet, and removing it would strand
	// that checkout with nothing to build from. It is released by
	// `releaseIntentDoc` when the reservation ends, whichever way it ends.
	//
	// It expires, unlike a manual snapshot, because an abandoned checkout must not
	// leave a provider image behind for ever. The reservation's own release is what
	// normally removes it; the expiry is the floor under a release that never ran.
	duplicate: {
		allowance: "reserved",
		deletable: false,
		expires: true
	}
} as const satisfies Record<string, SnapshotClassSpec>;

export type SnapshotClass = keyof typeof SNAPSHOT_CLASSES;

export const SNAPSHOT_CLASS_NAMES = Object.keys(
	SNAPSHOT_CLASSES
) as SnapshotClass[];

// The operations that take a rollback snapshot before they run, and the one
// place that set is stated.
//
// Repair is deliberately absent: its parking volume is a verified copy of the
// files taken before the host is touched, so it already has the safety net this
// class exists to provide - and it runs on boxes whose host may be unreachable,
// where a capture would fail and take the recovery with it. A configuration
// change is absent because it only recreates a container, and the box's row
// keeps the configuration it booted with until the new one answers.
export const ROLLBACK_SNAPSHOT_OPERATIONS = [
	"update",
	"reset",
	"restore"
] as const satisfies readonly BoxOperationType[];

export type RollbackSnapshotOperation =
	(typeof ROLLBACK_SNAPSHOT_OPERATIONS)[number];

// What an owner is told when the safety snapshot could not be taken.
//
// The sentence names the operation that did *not* run, because "the snapshot
// failed" and "your update did not start" are different pieces of news and only
// the second one says what happened to the box. It is built here, from the
// operation's own label, rather than in the workflow body that throws it: a
// workflow body cannot be run by any test, so prose written there is prose
// nothing checks.
export function rollbackCaptureFailure(
	operation: RollbackSnapshotOperation,
	reason: string
) {
	return `The safety snapshot failed, so the ${operationLabel(operation, true)} did not start. ${reason}`;
}

// `pending` is a row that exists before Hetzner has been asked; `creating` is
// one Hetzner is working on. They are kept apart because only the second has a
// provider image behind it, which is what the reclaim sweep looks for.
export const SNAPSHOT_STATUSES = [
	"pending",
	"creating",
	"complete",
	"failed",
	"deleting"
] as const;

export type SnapshotStatus = (typeof SNAPSHOT_STATUSES)[number];
