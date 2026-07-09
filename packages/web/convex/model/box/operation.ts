// Everything that is true of a box operation, in one row per operation.
//
// This replaces six tables that were each keyed by the operation type and each
// kept in a different file: what it is called, which statuses it may begin from,
// which status the box has while it runs, where a failure leaves it, whether
// that failure pages a person, and what the owner is told about it. Six parallel
// tables mean six chances to add an operation and forget one - and that is not
// hypothetical: `repair_failed` was once spelled in one of them and missing from
// another, and a failed `delete` was filed as a warning for as long as the
// check for a critical failure compared prose against identifiers.
//
// One row per operation makes the whole set of facts about it visible at once,
// and `satisfies` makes every field mandatory. Adding an operation is adding a
// row here; nothing else has a list to update.
//
// What is deliberately NOT here: the workflow that carries the operation out.
// That reference needs `_generated`, which would drag Convex into a module the
// browser reads. It lives in `convex/boxes/operation/start.ts`, keyed by these same
// names and pinned exhaustive by `satisfies`, so the two cannot drift.
import { boxStatusesExcept, type BoxStatus } from "./status";

// Who may ask for an operation directly.
//
// `owner` is the box's own owner, addressing it by slug; `staff` is the console,
// addressing it by id; `box` is the running instance itself, over the cloud
// authorization flow. An operation with no audience is one only this deployment
// starts - `delete` follows the subscription ending, never a button.
export const OPERATION_AUDIENCES = ["owner", "staff", "box"] as const;

export type OperationAudience = (typeof OPERATION_AUDIENCES)[number];

type OperationSpec = {
	// Who may start it. Order is `OPERATION_AUDIENCES` order.
	audiences: readonly OperationAudience[];
	// Whether a failure pages staff rather than filing a warning. Critical means
	// "this box may not be serving now": the operation either builds the box,
	// tears it down, or recreates the container of one that was working.
	// Everything else fails leaving a box exactly as usable as it was.
	critical: boolean;
	// The status the box has while the operation runs, or `null` where the
	// operation runs beside a box it does not move off its current status.
	during: BoxStatus | null;
	// The statuses the operation may begin from. `startOperation` refuses
	// anything not listed, so a wrong entry either blocks a legal action or lets
	// a dangerous one through - this field is the gate.
	from: readonly BoxStatus[];
	// What the operation is called in the interface. Identifiers and prose are
	// separate vocabularies; this is the bridge, and it is why no surface renders
	// a raw `change_config`.
	label: string;
	// What a failure of this operation is called, and whether it is the owner's
	// to act on. `owned: false` means the notice is shown only in the console - a
	// scheduled snapshot hitting a full Hetzner quota is staff's problem, not the
	// owner's - but staff still get the sentence rather than a bare status word.
	// `hint: null` is the honest answer where there is nothing to suggest; never
	// invent an action an owner does not have.
	notice: { owned: boolean; title: string; hint: string | null };
	// Where a failure leaves the box, or `null` where the operation never moved
	// it off the status it started from so a failure has nothing to put back.
	onFailure: BoxStatus | null;
};

export const BOX_OPERATIONS = {
	create: {
		audiences: ["owner", "staff"],
		critical: true,
		during: "creating",
		from: ["creating", "create_failed"],
		label: "Create",
		notice: {
			owned: true,
			title: "This box could not be created.",
			hint: "Try creating it again, or contact support if it keeps failing - you are not charged for a box that never started."
		},
		onFailure: "create_failed"
	},
	delete: {
		// The owner never presses this - deletion follows the subscription ending -
		// but staff do, when they revoke a comp. The owner is told about a failure
		// because they can see the box sitting in their list, not because there is
		// anything for them to do about it.
		audiences: ["staff"],
		critical: true,
		during: "deleting",
		// Named by its exclusions, not its members. Every other entry here is a
		// short list a reader can check; this one was eighteen literals - every
		// status but two - which is the shape that silently falls behind the
		// union. A status added without being pasted in would be a box nothing can
		// delete: its server keeps billing, its slug stays reserved, and the only
		// signal is an owner told their box is "busy". `deleting` is out because a
		// teardown already has the box (`finishFailedDeletions` re-drives it
		// through `delete_failed`), and `deleted` because there is nothing left.
		from: boxStatusesExcept("deleting", "deleted"),
		label: "Remove",
		notice: {
			owned: true,
			title: "Removing this box did not finish.",
			hint: "Staff have been alerted and will finish removing it. There is nothing for you to do."
		},
		onFailure: "delete_failed"
	},
	reset: {
		audiences: ["owner", "staff"],
		critical: true,
		during: "resetting",
		from: ["running", "reset_failed", "restore_failed", "update_failed"],
		label: "Reset",
		notice: {
			owned: true,
			title: "The last reset did not finish.",
			hint: "The box may be part-way through a rebuild. Try again, or repair it to get back to a working box."
		},
		onFailure: "reset_failed"
	},
	stop: {
		audiences: ["owner", "staff"],
		critical: false,
		during: "stopping",
		from: ["running"],
		label: "Stop",
		notice: {
			owned: true,
			title: "The box could not be stopped.",
			hint: "It is still running. Try again in a moment."
		},
		onFailure: "running"
	},
	start: {
		audiences: ["owner", "staff"],
		critical: false,
		during: "starting",
		from: ["stopped"],
		label: "Start",
		notice: {
			owned: true,
			title: "The box could not be started.",
			hint: "It is still stopped. Try again in a moment."
		},
		onFailure: "stopped"
	},
	change_password: {
		// The box itself, over the cloud authorization flow. Holding the current
		// password is the whole proof, so this never needs a website account.
		audiences: ["box"],
		critical: false,
		during: null,
		from: ["running", "reset_failed"],
		label: "Password change",
		notice: {
			owned: true,
			title: "The password change did not reach this box.",
			hint: "The box still expects your previous password. Try changing it again from the box itself."
		},
		onFailure: "running"
	},
	change_slug: {
		audiences: ["owner", "staff"],
		critical: false,
		during: null,
		from: ["running"],
		label: "Slug change",
		notice: {
			owned: true,
			title: "The slug change did not finish.",
			hint: "The box is still reachable at its old slug. You can try the change again."
		},
		onFailure: "running"
	},
	change_config: {
		// Applying configuration recreates the editor's container, so it needs a
		// running box and a reachable host. It has no failure status of its own: a
		// failed apply leaves the box on the configuration it already had (the row
		// is only advanced once the editor answers), so it is still simply running.
		audiences: ["owner"],
		critical: false,
		during: null,
		from: ["running"],
		label: "Configuration change",
		notice: {
			owned: true,
			title: "The configuration change was not applied.",
			hint: "The box is still running the configuration it had before. Check the values and try again."
		},
		onFailure: "running"
	},
	suspend: {
		audiences: ["staff"],
		critical: false,
		during: "suspending",
		from: ["running", "stopped"],
		label: "Suspend",
		notice: {
			owned: false,
			title: "Suspending this box did not finish.",
			hint: null
		},
		onFailure: "running"
	},
	unsuspend: {
		audiences: ["staff"],
		critical: false,
		during: "unsuspending",
		from: ["suspended"],
		label: "Unsuspend",
		notice: {
			owned: false,
			title: "Unsuspending this box did not finish.",
			hint: null
		},
		onFailure: "suspended"
	},
	restore: {
		audiences: ["owner", "staff"],
		critical: true,
		during: "restoring",
		from: ["running", "restore_failed"],
		label: "Restore",
		notice: {
			owned: true,
			title: "The last snapshot restore did not finish.",
			hint: "Your snapshot is unchanged and can be restored again. Repair the box if it is not serving."
		},
		onFailure: "restore_failed"
	},
	snapshot: {
		// A scheduled snapshot failing is staff's problem - a full Hetzner
		// snapshot quota, typically - and the snapshot list already shows the
		// failed row, so the owner is not told twice.
		audiences: ["owner", "staff"],
		critical: false,
		during: null,
		from: ["running"],
		label: "Snapshot",
		notice: {
			owned: false,
			title: "The last snapshot did not finish.",
			hint: null
		},
		// A failed snapshot leaves nothing to put back. The snapshot row carries
		// the failure; the box is still running.
		onFailure: null
	},
	repair: {
		// Repair copies the box's files off, gives it a clean host, and copies them
		// back, so it needs a running box with real files and a reachable host. Not
		// `create_failed`: a box that never finished being created has no files
		// worth preserving (and may have no server) - Reset or another create
		// attempt is the right tool there. Not `stopped`: a powered-off host cannot
		// answer over SSH, so every step would time out. `repair_failed` is
		// included so a failed repair can resume from its parking volume.
		//
		// `update_failed` is included for a different reason, and it is the one
		// that matters most: a box left broken by an update is rolled back by
		// repairing it. Repair renders the compose file from `box.runtime_image`,
		// and an update only advances that field once the new image has answered -
		// so repairing a box that failed to update rewrites the last image known to
		// serve. Removing this entry would leave a failed update with no recovery
		// but Reset, which destroys the files the update was careful to keep.
		audiences: ["owner", "staff"],
		critical: true,
		during: "repairing",
		from: [
			"running",
			"reset_failed",
			"restore_failed",
			"repair_failed",
			"update_failed"
		],
		label: "Repair",
		notice: {
			owned: true,
			title: "The last repair did not finish.",
			hint: "Your files are safe on the parking volume. Repair again to resume from where it stopped."
		},
		onFailure: "repair_failed"
	},
	update: {
		// Update recreates the box's container on a new image. It needs a running
		// box and a reachable host for the same reason Repair does, and the pull is
		// the slow part. `update_failed` is included so a transient failure - an
		// unreachable registry, a pull that timed out - can simply be retried;
		// where the box itself is broken rather than the attempt, Repair is the way
		// back.
		audiences: ["owner", "staff"],
		critical: true,
		during: "updating",
		from: ["running", "update_failed"],
		label: "Update",
		notice: {
			owned: true,
			title: "The last update did not finish.",
			hint: "This box is still recorded on the version it was running. Try the update again, or repair it to put that version back."
		},
		onFailure: "update_failed"
	}
} as const satisfies Record<string, OperationSpec>;

export type BoxOperationType = keyof typeof BOX_OPERATIONS;

export const BOX_OPERATION_TYPES = Object.keys(
	BOX_OPERATIONS
) as BoxOperationType[];

// The statuses a box may have while an operation runs, and the statuses a
// failure may leave it in. Both are derived from the catalogue rather than
// listed beside it, because both were subsets that had already drifted: the
// begin-status union carried `running` and `suspended`, which no operation ever
// moved a box to.
//
// The types are read off the catalogue's literals rather than off the arrays
// below, so they stay the exact subsets. Taking them from the arrays would widen
// both to `BoxStatus` and quietly turn two narrow validators into one that
// accepts every status there is.
export type BoxDuringStatus = NonNullable<
	(typeof BOX_OPERATIONS)[BoxOperationType]["during"]
>;

export type BoxFailureStatus = NonNullable<
	(typeof BOX_OPERATIONS)[BoxOperationType]["onFailure"]
>;

export const BOX_DURING_STATUSES = [
	...new Set(
		BOX_OPERATION_TYPES.map((type) => BOX_OPERATIONS[type].during).filter(
			(status): status is BoxDuringStatus => status !== null
		)
	)
];

export const BOX_FAILURE_STATUSES = [
	...new Set(
		BOX_OPERATION_TYPES.map((type) => BOX_OPERATIONS[type].onFailure).filter(
			(status): status is BoxFailureStatus => status !== null
		)
	)
];

export type BoxOperationStatus = (typeof BOX_OPERATION_STATUSES)[number];

export const BOX_OPERATION_STATUSES = [
	"pending",
	"running",
	"succeeded",
	"failed"
] as const;

// An operation holds its box while it is in one of these. One definition, read
// by the console (to offer cancelling a wedged one) and by the sweep that
// rescues them, so neither can disagree about what "busy" means.
export const ACTIVE_OPERATION_STATUSES = [
	"pending",
	"running"
] as const satisfies readonly BoxOperationStatus[];

const ACTIVE_OPERATION_STATUS_SET: ReadonlySet<BoxOperationStatus> = new Set(
	ACTIVE_OPERATION_STATUSES
);

export function isActiveOperationStatus(status: BoxOperationStatus) {
	return ACTIVE_OPERATION_STATUS_SET.has(status);
}

export function isOperationAllowed(status: BoxStatus, type: BoxOperationType) {
	return (BOX_OPERATIONS[type].from as readonly BoxStatus[]).includes(status);
}

export function operationAllowsAudience(
	type: BoxOperationType,
	audience: OperationAudience
) {
	return (
		BOX_OPERATIONS[type].audiences as readonly OperationAudience[]
	).includes(audience);
}

// The operation's name inside a sentence ("the slug change failed"), where a
// leading capital would read as a proper noun.
export function operationLabel(type: BoxOperationType, sentence = false) {
	const { label } = BOX_OPERATIONS[type];
	return sentence ? label.toLowerCase() : label;
}

// Every event a box records about an operation, derived rather than listed.
//
// This used to be nineteen hand-written strings across thirteen files, in four
// competing grammars: `box.repair_succeeded`, `box.password_changed`,
// `box.stopped`, and `box.running` all meant "an operation finished". Three
// failure names disagreed with their own operation type
// (`box.slug_change_failed` for `change_slug`). A function cannot drift from
// itself, so the whole grammar is one line and adding an operation type gets its
// events for free.
export const OPERATION_OUTCOMES = [
	"started",
	"succeeded",
	"failed",
	"skipped"
] as const;

export type OperationOutcome = (typeof OPERATION_OUTCOMES)[number];

// The return type is the grammar, not `string`, which is what lets
// `BoxEventType` be a closed union and `boxEventLabel` be total over it.
export function boxEventType<
	Type extends BoxOperationType,
	Outcome extends OperationOutcome
>(type: Type, outcome: Outcome): `box.${Type}_${Outcome}` {
	return `box.${type}_${outcome}`;
}

// The facts a box records that are not an operation's outcome: infrastructure
// the workflows create and destroy around it. They are listed because there is
// no grammar to derive them from - and listed here, beside their labels, so a
// new one is named in the same edit that introduces it.
const BOX_FACT_LABEL = {
	"box.owner_emailed": "Owner emailed",
	"box.parking_volume_created": "Parking volume created",
	"box.parking_volume_deleted": "Parking volume deleted",
	"box.parking_volume_restoring": "Parking volume restoring",
	"dns.record_created": "DNS record created",
	"server.created": "Server created",
	"server.rebuilt": "Server rebuilt"
} as const;

export type BoxFactType = keyof typeof BOX_FACT_LABEL;

export type BoxEventType =
	`box.${BoxOperationType}_${OperationOutcome}` | BoxFactType;

// Every event name this deployment can write, as values. `convex/schema.ts`
// builds the stored column's validator from it, so a row whose type nothing can
// name cannot be inserted in the first place.
export const BOX_EVENT_TYPES: BoxEventType[] = [
	...BOX_OPERATION_TYPES.flatMap((type) =>
		OPERATION_OUTCOMES.map((outcome) => boxEventType(type, outcome))
	),
	...(Object.keys(BOX_FACT_LABEL) as BoxFactType[])
];

// What one row of the audit history is called.
//
// Total over the closed union, with no fallback: `appendBoxEvent` takes a
// `BoxEventType` and the schema validates the column against the same list, so
// there is no third source of stored values for a fallback to catch. A fallback
// here would be a branch nothing can reach, reporting healthy for exactly as
// long as nobody checked.
export function boxEventLabel(type: BoxEventType) {
	if (type in BOX_FACT_LABEL) {
		return BOX_FACT_LABEL[type as BoxFactType];
	}

	const match = /^box\.(.+)_(started|succeeded|failed|skipped)$/.exec(type);
	const operation = match?.[1] as BoxOperationType;
	return `${BOX_OPERATIONS[operation].label} ${match?.[2]}`;
}

export type OperationFailure = {
	error: string | null;
	finishedAt: number | null;
	type: BoxOperationType;
};

export type FailureNotice = {
	title: string;
	detail: string;
	// What the owner can do about it, or null where the honest answer is
	// "nothing, this one is ours". Never invent an action an owner does not have.
	hint: string | null;
};

// What a failed operation means to the person reading about it.
//
// `audience: "owner"` hides the failures an owner cannot act on; the console
// passes "staff" and sees every one, because "the box looks fine but its last
// operation failed" is exactly what staff are looking for.
export function failureNotice(
	failure: OperationFailure | null,
	audience: "owner" | "staff"
): FailureNotice | null {
	if (!failure) return null;
	const { notice } = BOX_OPERATIONS[failure.type];
	if (audience === "owner" && !notice.owned) return null;

	return {
		title: notice.title,
		// The error text is the whole point of surfacing this, so never drop it
		// silently: a failure with no recorded reason says so rather than showing
		// an empty line that reads as "no problem here".
		detail: failure.error ?? "No reason was recorded.",
		hint: notice.hint
	};
}
