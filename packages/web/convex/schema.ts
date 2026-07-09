import { defineSchema, defineTable } from "convex/server";
import { v, type Infer } from "convex/values";
import { AUTHORIZATION_TYPES } from "./model/box/auth";
import { BOX_FLAG_SIGNALS } from "./model/box/metric";
import {
	BOX_DURING_STATUSES,
	BOX_EVENT_TYPES,
	BOX_FAILURE_STATUSES,
	BOX_OPERATION_STATUSES,
	BOX_OPERATION_TYPES
} from "./model/box/operation";
import { BOX_PLAN_ORDER, SERVER_TYPES } from "./model/box/plan";
import { CAPACITY_LIMIT_BLOCK_REASONS } from "./model/box/capacity";
import {
	ROLLBACK_SNAPSHOT_OPERATIONS,
	SNAPSHOT_CLASS_NAMES,
	SNAPSHOT_STATUSES
} from "./model/box/snapshot";
import { BOX_STATUSES } from "./model/box/status";
import { USAGE_SIGNAL_NAMES } from "./model/box/usage";

// Turn a list of the model's words into a Convex validator.
//
// The direction matters and is the whole point of `convex/model/`. Every closed
// union this deployment stores is declared as words there - where the browser,
// the control plane and the tests all read it without importing a database - and
// becomes a validator only here. It used to run the other way, with the schema
// holding the literals and each list derived back out with
// `vBoxStatus.members.map(...)`, which meant a module that only wanted the words
// had to import the schema and everything the schema imports.
//
// A subset union is derived too rather than listed beside its parent: the
// begin-status and failure-status unions were hand-written subsets, and a subset
// is exactly what the type checker cannot check. The begin-status one had
// drifted to carry `running` and `suspended`, which no operation ever moved a
// box to.
function literals<T extends string>(values: readonly T[]) {
	return v.union(...values.map((value) => v.literal(value)));
}

export const vUserRole = v.union(v.literal("user"), v.literal("admin"));
export type UserRole = Infer<typeof vUserRole>;

export const vCheckoutIntentStatus = v.union(
	v.literal("active"),
	v.literal("converted"),
	v.literal("released"),
	v.literal("expired")
);

export const vBoxAuthorizationType = literals(AUTHORIZATION_TYPES);

export const vBoxStatus = literals(BOX_STATUSES);

export const vBoxBeginStatus = literals(BOX_DURING_STATUSES);
export const vBoxFailureStatus = literals(BOX_FAILURE_STATUSES);
export const vBoxOperationType = literals(BOX_OPERATION_TYPES);
export const vBoxOperationStatus = literals(BOX_OPERATION_STATUSES);
export const vBoxEventType = literals(BOX_EVENT_TYPES);

// Who started an operation. Recorded on every one, because "who did this" is a
// question a box's history has to be able to answer - in support, in the console,
// and in automatic repair's own gates.
//
// A closed union rather than a free string: automatic repair holds off while a
// person is working on a box, and it tells the two apart by this field alone. A
// misspelled trigger would silently reclassify a fleet action as a human one, so
// there is nothing to misspell.
export const vOperationTrigger = v.union(
	// A person acting on the box: its owner, or staff acting on their behalf. Both
	// hold automatic repair off - the hand on the box is a human's either way.
	v.literal("owner"),
	v.literal("staff"),
	// The fleet acting on its own. Every one of these is named separately so a
	// box's history says which sweep touched it, and so `isSystemTrigger` can
	// classify them all without listing them.
	v.literal("system:auto_repair"),
	v.literal("system:runtime_floor"),
	v.literal("system:auto_snapshot"),
	v.literal("system:abuse_suspension"),
	v.literal("system:subscription_revoked"),
	v.literal("system:account_deletion"),
	// Re-drives a deletion that was already ordered and stopped part-way. Named
	// apart from the triggers above because it starts no teardown of its own: it
	// only finishes one of theirs (see `finishFailedDeletions`).
	v.literal("system:delete_retry")
);
export type OperationTrigger = Infer<typeof vOperationTrigger>;

// True for anything the fleet started by itself. Keyed off the `system:` prefix
// rather than a second list of literals, so a trigger added to the union above is
// classified the moment it exists instead of defaulting to "a person did this".
export function isSystemTrigger(trigger: OperationTrigger) {
	return trigger.startsWith("system:");
}

// Which half of a Repair ("clean host, current files") a box's parking volume
// is in. It is the crash-safety marker a resumed repair reads to decide the
// authoritative copy of the files:
//   - "parking":   the box's server still holds the files; the volume is being
//                  filled. Safe to re-copy server -> volume and to rebuild the
//                  host only once that copy has verified.
//   - "restoring": the server has been (or is being) wiped and reborn; the
//                  volume now holds the only copy. The files are copied back
//                  volume -> server, and server -> volume must never run here.
// The transition parking -> restoring happens exactly once, gated on the
// copy-out verifying, so an interrupted repair always resumes towards keeping
// the files rather than overwriting them.
export const vParkingVolumeStage = v.union(
	v.literal("parking"),
	v.literal("restoring")
);
export type ParkingVolumeStage = Infer<typeof vParkingVolumeStage>;

// What a plan is - its machine, its specification, its capabilities - is
// `convex/model/box/plan.ts`, and `BoxPlan` is the key of that table. There is no
// second list of plan names to keep in step: a plan exists iff it has a machine.
export const vBoxPlan = literals(BOX_PLAN_ORDER);

// The Hetzner types a box can run on: one per plan, and nothing else.
export const vServerType = literals(SERVER_TYPES);

// Where a box may be placed. Unlike the machine, this is not a property of a
// plan - any plan can run in any of these - so the list lives here, beside the
// column that stores it, rather than in the model.
export const vServerLocation = v.union(
	v.literal("nbg1"),
	v.literal("fsn1"),
	v.literal("hel1")
);
export type ServerLocation = Infer<typeof vServerLocation>;
export const SERVER_LOCATIONS = vServerLocation.members.map(
	(member) => member.value
);

export const vBoxFlagSignal = literals(BOX_FLAG_SIGNALS);

// What a box can run out of. Two signals, one shape - see `model/box/usage.ts`
// for why a level against an allowance is not a metric and not a flag.
export const vUsageSignal = literals(USAGE_SIGNAL_NAMES);

export const vThreshold = v.object({
	signal: vBoxFlagSignal,
	value: v.number(),
	sustained_samples: v.number()
});
export type StoredThreshold = Infer<typeof vThreshold>;

// Staff-tunable snapshot behaviour. Deliberately no caps: how many snapshots a
// box gets is what its plan sells, and how they are split is its owner's, so a
// number here could only contradict one of them. What is left is timing.
//
// There is no manual retention, and its absence is the rule rather than an
// omission: a snapshot the owner took themselves is kept until they delete it,
// or until their own allowance pushes it out. A window here could only ever
// delete a checkpoint somebody deliberately made.
export const vSnapshotPolicy = v.object({
	manual_min_interval_minutes: v.number(),
	automatic_retention_days: v.number()
});
export type StoredSnapshotPolicy = Infer<typeof vSnapshotPolicy>;

// What the deployment's RUNTIME_IMAGE channel last resolved to, refreshed on a
// schedule and cached fleet-wide. Every box compares its own `runtime_image`
// against `image` here; `version` is the label read off that digest and exists
// only so the interface can say "0.2.1" instead of a hash.
export const vRuntimeRelease = v.object({
	image: v.string(),
	version: v.union(v.string(), v.null()),
	checked_at: v.number()
});
export type StoredRuntimeRelease = Infer<typeof vRuntimeRelease>;

export const vSnapshotClass = literals(SNAPSHOT_CLASS_NAMES);
export const vSnapshotStatus = literals(SNAPSHOT_STATUSES);

// Which operation a rollback snapshot was taken before. Narrower than
// `vBoxOperationType` on purpose: only three operations take one, so a row
// naming any other operation cannot be stored - and the interface reads this
// field to say "Before update" rather than inventing a name for the class.
export const vRollbackSnapshotOperation = literals(
	ROLLBACK_SNAPSHOT_OPERATIONS
);

export const vStaffAlertSeverity = v.union(
	v.literal("warning"),
	v.literal("critical"),
	v.literal("resolved")
);
export const vStaffAlertQueueStatus = v.union(
	v.literal("pending"),
	v.literal("disabled"),
	v.literal("no_recipients"),
	v.literal("queued"),
	v.literal("queue_failed")
);

// A notice is queued per recipient in the same mutation that records the
// recipient, so there is no state between "not recorded" and "handed to Resend".
// Deliberately narrower than `vStaffAlertQueueStatus`: an alert can sit at
// `disabled` or `no_recipients` waiting for configuration, whereas a notice that
// cannot be sent is not started at all, and a row that exists is a row that was
// attempted. A status that can never occur is a status nothing can be trusted to
// mean.
export const vLegalNoticeQueueStatus = v.union(
	v.literal("queued"),
	v.literal("queue_failed")
);

const vMetadata = v.optional(v.record(v.string(), v.any()));

export default defineSchema({
	users: defineTable({
		clerk_user_id: v.string(),
		email: v.string(),
		role: vUserRole,
		suspended: v.boolean(),
		suspended_reason: v.optional(v.string()),
		suspended_at: v.optional(v.number()),
		deletion_pending: v.optional(v.boolean()),
		deletion_requested_at: v.optional(v.number()),
		deletion_finished_at: v.optional(v.number()),
		purge_at: v.optional(v.number()),
		created_at: v.number(),
		updated_at: v.number()
	})
		.index("clerk_user_id", ["clerk_user_id"])
		.index("email", ["email"])
		.index("role", ["role"])
		.index("deletion_pending", ["deletion_pending"])
		.index("purge_at", ["purge_at"])
		.index("created_at", ["created_at"]),

	box_checkout_intents: defineTable({
		user_id: v.string(),
		slug: v.string(),
		// The plan the visitor was buying when the slug was reserved. Capacity
		// admission reads it - a plan without manual snapshots commits fewer
		// snapshot slots - so a reservation has to name one, not infer it later
		// from whatever product the order happens to arrive on.
		plan: vBoxPlan,
		status: vCheckoutIntentStatus,
		polar_checkout_id: v.optional(v.string()),
		polar_checkout_url: v.optional(v.string()),
		polar_checkout_status: v.optional(v.string()),
		polar_checkout_expires_at: v.optional(v.number()),
		polar_customer_id: v.optional(v.string()),
		polar_subscription_id: v.optional(v.string()),
		polar_initial_order_id: v.optional(v.string()),
		terms_accepted_at: v.optional(v.number()),
		terms_version: v.optional(v.string()),
		created_at: v.number(),
		updated_at: v.number(),
		converted_at: v.optional(v.number()),
		released_at: v.optional(v.number()),
		release_reason: v.optional(v.string()),
		purge_at: v.optional(v.number()),
		retain_until: v.optional(v.number()),
		// What this reservation is duplicating, when it is a duplicate.
		//
		// Both set together or neither: a duplicate reservation names the box it
		// copies AND the snapshot row holding the image it will be built from, and
		// one without the other is a reservation that cannot be fulfilled. They are
		// two fields rather than one because they answer different questions - the
		// box says whose plan and whose settings the copy inherits and whether the
		// source still exists, the snapshot says which disk.
		//
		// The snapshot row is what `releaseIntentDoc` reads to give the image back
		// when this reservation ends without converting.
		duplicate_source_box_id: v.optional(v.id("boxes")),
		duplicate_snapshot_id: v.optional(v.id("box_snapshots")),
		box_id: v.optional(v.id("boxes"))
	})
		.index("slug_status", ["slug", "status"])
		// Every live reservation duplicating one box. Read when a box is deleted,
		// so a reservation whose source is disappearing can be found before the
		// source is gone rather than discovered at conversion.
		.index("duplicate_source_box_id", ["duplicate_source_box_id"])
		.index("status_expires", ["status", "polar_checkout_expires_at"])
		.index("status_created_at", ["status", "created_at"])
		.index("polar_checkout_id", ["polar_checkout_id"])
		.index("user_id_created_at", ["user_id", "created_at"])
		.index("user_id_status", ["user_id", "status"])
		.index("user_id_slug_status", ["user_id", "slug", "status"])
		.index("box_id", ["box_id"])
		.index("purge_at", ["purge_at"])
		.index("created_at", ["created_at"]),

	boxes: defineTable({
		user_id: v.string(),
		slug: v.string(),
		status: vBoxStatus,
		// Which plan this box was bought on - the machine it gets and the snapshot
		// allowance it comes with. Fixed for the life of the box: nothing moves a
		// box between plans, so this is written once at creation and only ever read
		// afterwards.
		plan: vBoxPlan,
		// How much of the plan's snapshot allowance is set aside for snapshots the
		// owner takes themselves. The automatic half is the remainder, never stored,
		// so the two cannot drift apart or sum to more than the plan sells. Always
		// zero on a plan without manual snapshots. Read through
		// `resolveSnapshotSplit`, never directly.
		manual_snapshot_cap: v.number(),
		// A box is backed by EITHER a paid Polar subscription (these two set) OR a
		// staff comp (comped_at set, these absent). Never both, never neither. The
		// subscription-coupled paths (reconciliation, revoke, account deletion,
		// billing views) branch on which is present.
		polar_customer_id: v.optional(v.string()),
		polar_subscription_id: v.optional(v.string()),
		comped_by: v.optional(v.string()),
		comped_at: v.optional(v.number()),
		comp_reason: v.optional(v.string()),
		runtime_image: v.optional(v.string()),
		// The version label of `runtime_image`, recorded beside it so a box can say
		// what it runs without the interface asking a registry per page view. Null
		// where the registry would not tell us; the digest above is what every
		// comparison actually uses.
		runtime_version: v.optional(v.string()),
		runtime_auth_hash: v.optional(v.string()),
		// The owner's own environment variables for this box, already validated
		// against the allowlist in `boxes/configuration.ts`. Held on the row rather
		// than applied once, because every path that rewrites the box's env file
		// renders it from here - so a Reset, Repair, update, or password change
		// cannot quietly revert what the owner configured.
		runtime_config: v.optional(v.record(v.string(), v.string())),
		password_setup_pending_at: v.optional(v.number()),
		hetzner_server_id: v.optional(v.number()),
		hetzner_server_type: v.optional(vServerType),
		hetzner_location: v.optional(vServerLocation),
		hetzner_ipv4: v.optional(v.string()),
		hetzner_ipv6: v.optional(v.string()),
		// A domain the owner points at this box themselves, served alongside its
		// composery.cloud name rather than instead of it: the managed name is how
		// the control plane and the owner always reach the box, and losing it to a
		// registrar change would take the box with it.
		//
		// Only ever written after the name is observed to resolve to this box's own
		// address. Caddy asks a certificate authority for a certificate the moment
		// the name appears in its config, and a name that does not point here fails
		// that challenge on a schedule until the authority rate-limits the box.
		custom_domain: v.optional(v.string()),
		dns_record_id: v.optional(v.string()),
		dns_record_aaaa_id: v.optional(v.string()),
		// Set the instant a Repair's parking volume is created and cleared only
		// after that volume is deleted, so a repair that dies mid-flight leaves a
		// recoverable pointer to the Hetzner Volume holding the box's files rather
		// than orphaning it. `parking_volume_stage` says which copy is authoritative
		// (see vParkingVolumeStage); reconciliation reclaims any volume no live box
		// still points at.
		parking_volume_id: v.optional(v.number()),
		parking_volume_stage: v.optional(vParkingVolumeStage),
		created_at: v.number(),
		updated_at: v.number(),
		ready_at: v.optional(v.number()),
		deleted_at: v.optional(v.number()),
		purge_at: v.optional(v.number())
	})
		.index("slug_status", ["slug", "status"])
		.index("status", ["status"])
		// Only a deleted box is given one (`deletedBoxDataPatch`), so the purge
		// sweep needs no status column to scope itself - the same shape every other
		// purged table uses.
		.index("purge_at", ["purge_at"])
		.index("created_at", ["created_at"])
		.index("user_id_created_at", ["user_id", "created_at"])
		.index("user_id_status", ["user_id", "status"])
		.index("polar_subscription_id", ["polar_subscription_id"])
		.index("hetzner_server_id", ["hetzner_server_id"])
		.index("parking_volume_id", ["parking_volume_id"]),

	// How many boxes this deployment has ever created. One row, by construction,
	// like `settings` below.
	//
	// A separate row rather than a count of `boxes`, because that table is not a
	// history: `purgeBox` removes the row outright once a deleted box passes its
	// retention window, so counting rows answers "how many boxes exist now" and
	// silently falls over time. This only ever rises, which is the difference
	// between a total the site can publish and a number that falls every
	// time the purge sweep runs.
	box_counts: defineTable({
		created: v.number()
	}),

	box_auth_codes: defineTable({
		box_id: v.id("boxes"),
		code_hash: v.string(),
		code_challenge: v.string(),
		redirect_uri: v.string(),
		type: vBoxAuthorizationType,
		expires_at: v.number(),
		consumed_at: v.optional(v.number()),
		created_at: v.number()
	})
		.index("code_hash", ["code_hash"])
		.index("expires_at", ["expires_at"])
		.index("box_id", ["box_id"]),

	box_auth_grants: defineTable({
		box_id: v.id("boxes"),
		token_hash: v.string(),
		expires_at: v.number(),
		consumed_at: v.optional(v.number()),
		runtime_auth_hash: v.optional(v.string()),
		created_at: v.number()
	})
		.index("token_hash", ["token_hash"])
		.index("expires_at", ["expires_at"])
		.index("box_id", ["box_id"]),

	box_operations: defineTable({
		box_id: v.id("boxes"),
		type: vBoxOperationType,
		status: vBoxOperationStatus,
		idempotency_key: v.string(),
		reserved_slug: v.optional(v.string()),
		// Who asked for this. Required: `startBoxOperation` is the only writer and it
		// demands one, and automatic repair decides whether a person has their hand
		// on this box from this field alone - a row without it would read as neither.
		trigger: vOperationTrigger,
		// The workflow carrying this operation out. It is what lets the operation
		// sweep ask whether an operation still has anything running behind it,
		// instead of guessing from how long it has been open.
		//
		// Optional because it cannot be otherwise: starting the workflow needs the
		// operation's own id, so the row is inserted and then patched with this,
		// inside one transaction. Nothing outside that transaction ever sees the
		// gap, and the sweep treats an active operation without one as orphaned.
		workflow_id: v.optional(v.string()),
		started_at: v.optional(v.number()),
		finished_at: v.optional(v.number()),
		last_error: v.optional(v.string()),
		dismissed_at: v.optional(v.number()),
		dismissed_by: v.optional(v.string()),
		metadata: vMetadata,
		created_at: v.number(),
		updated_at: v.number()
	})
		.index("box_id_status", ["box_id", "status"])
		.index("box_id_created_at", ["box_id", "created_at"])
		.index("box_type_status", ["box_id", "type", "status"])
		.index("box_id_type_created_at", ["box_id", "type", "created_at"])
		// Fleet-wide, by operation type and time. The per-box index above cannot
		// answer a fleet question, and the fleet question is the Let's Encrypt
		// certificates-per-registered-domain ceiling: how many certificates every
		// box in this deployment has caused between them this week
		// (`model/box/certificate.ts`). Bounded by time rather than by a row cap,
		// because a truncated read of a limit is a limit that stops being enforced
		// exactly when the fleet is busiest.
		.index("type_created_at", ["type", "created_at"])
		.index("status_created_at", ["status", "created_at"])
		.index("status_dismissed_created_at", [
			"status",
			"dismissed_at",
			"created_at"
		])
		.index("idempotency_key_status", ["idempotency_key", "status"])
		.index("reserved_slug_status", ["reserved_slug", "status"]),

	box_events: defineTable({
		box_id: v.id("boxes"),
		user_id: v.string(),
		// The closed union, not `v.string()`. `appendBoxEvent` already took a
		// `BoxEventType`, so the write was typed; the column was not, which left
		// the door open for a row nothing in the interface can name. Validating it
		// here is what lets `boxEventLabel` be total and drop its fallback.
		type: vBoxEventType,
		message: v.optional(v.string()),
		metadata: vMetadata,
		created_at: v.number()
	})
		.index("box_id_created_at", ["box_id", "created_at"])
		.index("user_id", ["user_id"]),

	// One row per box, tracking whether it is answering. Only the running count
	// matters: automatic repair fires on a box that has been unreachable for
	// several consecutive checks, so a single number and the last time it was fine
	// is the whole state. Deliberately not an event stream - the cost of this has
	// to stay flat in the number of boxes, not grow with how long they run.
	box_health: defineTable({
		box_id: v.id("boxes"),
		consecutive_failures: v.number(),
		last_ok_at: v.optional(v.number()),
		updated_at: v.number()
	}).index("box_id", ["box_id"]),

	box_metrics: defineTable({
		box_id: v.id("boxes"),
		sampled_at: v.number(),
		cpu_percent: v.number(),
		ingress_bps: v.number(),
		egress_bps: v.number(),
		ingress_pps: v.number(),
		egress_pps: v.number(),
		disk_read_bps: v.number(),
		disk_write_bps: v.number()
	})
		.index("box_id_sampled_at", ["box_id", "sampled_at"])
		.index("sampled_at", ["sampled_at"]),

	box_metrics_hourly: defineTable({
		box_id: v.id("boxes"),
		hour_start: v.number(),
		sample_count: v.number(),
		cpu_percent: v.number(),
		ingress_bps: v.number(),
		egress_bps: v.number(),
		ingress_pps: v.number(),
		egress_pps: v.number(),
		disk_read_bps: v.number(),
		disk_write_bps: v.number()
	})
		.index("box_id_hour_start", ["box_id", "hour_start"])
		.index("hour_start", ["hour_start"]),

	// One row per box per usage signal: what it has spent of what it is allowed.
	//
	// Deliberately not a series. A level against an allowance is only ever read as
	// its latest value - the meter on the box page, the step that decides a notice -
	// so keeping history would be paying per box per sample for a number nothing
	// asks the past of. `box_metrics` already holds the rates, with a retention
	// window, for anyone who wants a shape over time.
	//
	// `used_bytes` and `allowance_bytes` are stored and the percentage is derived
	// from them by `usagePercent` wherever it is needed. Storing the percentage too
	// would be a third number that can disagree with the two it comes from.
	box_usage: defineTable({
		box_id: v.id("boxes"),
		signal: vUsageSignal,
		used_bytes: v.number(),
		allowance_bytes: v.number(),
		// The highest step (see `USAGE_STEPS`) this box has already been told about.
		// Cleared the moment usage falls back below it, which is the one rule that
		// also handles the provider resetting its traffic counter at the start of a
		// billing month - a counter that went down has, by definition, stopped
		// at the level the owner was told about.
		noticed_step: v.optional(v.number()),
		// When a counter was last seen to go down. Set only for a signal that resets -
		// traffic does, a disk does not - and it is what lets the box page say which
		// period the figure covers instead of implying it is all-time.
		counter_reset_at: v.optional(v.number()),
		sampled_at: v.number()
		// One index, and a box's whole set is read through its `box_id` prefix. A
		// second index on `box_id` alone would select exactly the same rows in
		// exactly the same order at the cost of a second write per sample.
	}).index("box_id_signal", ["box_id", "signal"]),

	box_flags: defineTable({
		box_id: v.id("boxes"),
		signal: vBoxFlagSignal,
		message: v.string(),
		value: v.number(),
		threshold: v.number(),
		auto_suspended: v.boolean(),
		dismissed_at: v.optional(v.number()),
		dismissed_by: v.optional(v.string()),
		created_at: v.number()
	})
		.index("box_id_created_at", ["box_id", "created_at"])
		.index("box_id_signal", ["box_id", "signal"])
		.index("dismissed_created_at", ["dismissed_at", "created_at"])
		.index("box_id_dismissed_created_at", [
			"box_id",
			"dismissed_at",
			"created_at"
		]),

	box_snapshots: defineTable({
		box_id: v.id("boxes"),
		hetzner_image_id: v.optional(v.number()),
		hetzner_action_id: v.optional(v.number()),
		class: vSnapshotClass,
		// Which operation this snapshot was taken before. Set only on a rollback
		// snapshot, which is the only class taken because of an operation.
		before_operation: v.optional(vRollbackSnapshotOperation),
		status: vSnapshotStatus,
		// What the box was running when the image was taken. A snapshot is a disk,
		// and the disk holds that version's container - so restoring one without
		// putting these back would boot the restored files under whatever image the
		// row happens to name now, which after an update is the very image the
		// owner is rolling away from. Absent on a snapshot taken before this was
		// recorded, and on a box that had no image recorded at all.
		runtime_image: v.optional(v.string()),
		runtime_version: v.optional(v.string()),
		size_bytes: v.optional(v.number()),
		error: v.optional(v.string()),
		created_at: v.number(),
		completed_at: v.optional(v.number()),
		// When the retention sweep may remove this snapshot. Absent has exactly one
		// meaning: nothing will ever remove it on a timer. Every row is given one at
		// insert (the incomplete-row window), and only completing a class that does
		// not expire clears it - see `snapshotExpiry`.
		expires_at: v.optional(v.number())
	})
		.index("box_id_created_at", ["box_id", "created_at"])
		.index("box_id_class_created_at", ["box_id", "class", "created_at"])
		.index("box_id_class_status_created_at", [
			"box_id",
			"class",
			"status",
			"created_at"
		])
		.index("status_expires_at", ["status", "expires_at"])
		.index("hetzner_image_id", ["hetzner_image_id"]),

	staff_alerts: defineTable({
		key: v.string(),
		severity: vStaffAlertSeverity,
		subject: v.string(),
		text: v.string(),
		queue_status: vStaffAlertQueueStatus,
		recipient_count: v.number(),
		email_id: v.optional(v.string()),
		last_email_event: v.optional(v.string()),
		delivery_error: v.optional(v.string()),
		created_at: v.number(),
		updated_at: v.number(),
		purge_at: v.number()
	})
		.index("key", ["key"])
		.index("queue_status_created_at", ["queue_status", "created_at"])
		.index("email_id", ["email_id"])
		.index("purge_at", ["purge_at"])
		.index("created_at", ["created_at"]),

	// A legal notice as it was actually sent. One row per entry in
	// `convex/model/legal.ts`, created the first time the sweep reaches it.
	//
	// The text is copied in rather than read back out of the code it came from,
	// because this is evidence: the repository can be edited, and a record that
	// resolves its own contents through today's source can only ever say what the
	// notice would say now. `started_at` is the recipient cutoff and the reason
	// this row exists at all - it fixes who "every account holder" meant at the
	// moment the send began, so a signup arriving mid-send is not half-notified.
	legal_notices: defineTable({
		notice_id: v.string(),
		subject: v.string(),
		text: v.string(),
		started_at: v.number(),
		// Where the walk through `users` got to. Absent once the walk is done.
		cursor: v.optional(v.string()),
		finished_at: v.optional(v.number()),
		recipient_count: v.number(),
		purge_at: v.number()
	}).index("notice_id", ["notice_id"]),

	// One row per person told, which is the only form this evidence can take. The
	// obligation under Article 19 of Directive (EU) 2019/770 and Article 34 GDPR
	// is owed to each customer individually, so "we mailed everybody" answers a
	// question nobody asks: what has to be answerable is whether this person was
	// told, when, and whether it arrived.
	legal_notice_recipients: defineTable({
		notice_id: v.string(),
		user_id: v.string(),
		email: v.string(),
		email_id: v.optional(v.string()),
		queue_status: vLegalNoticeQueueStatus,
		last_email_event: v.optional(v.string()),
		delivery_error: v.optional(v.string()),
		created_at: v.number(),
		purge_at: v.number()
	})
		.index("notice_id_user_id", ["notice_id", "user_id"])
		.index("notice_id_queue_status", ["notice_id", "queue_status"])
		.index("email_id", ["email_id"])
		.index("user_id", ["user_id"])
		.index("purge_at", ["purge_at"]),

	// One row, by construction: nothing inserts a second, and every reader takes
	// the first. It carried a `key: "global"` column and an index over it - a
	// column with one possible value, and an index that could only ever narrow a
	// one-row table to itself.
	settings: defineTable({
		checkout_enabled: v.boolean(),
		hetzner_server_limit: v.optional(v.number()),
		hetzner_snapshot_limit: v.optional(v.number()),
		// The apex's weekly Let's Encrypt allowance. An operator fact, not a
		// constant: it is roughly 50 for an ordinary registered domain and becomes
		// a different number the day Let's Encrypt grants this deployment a rate
		// limit adjustment - which is exactly why the provider allocations beside
		// it are settings too. Absent fails closed, like they do.
		certificate_weekly_limit: v.optional(v.number()),
		auto_suspend_enabled: v.optional(v.boolean()),
		max_active_checkout_intents_per_user: v.optional(v.number()),
		thresholds: v.optional(v.array(vThreshold)),
		snapshot_policy: v.optional(vSnapshotPolicy),
		runtime_release: v.optional(vRuntimeRelease),
		// The floor below which a box is not allowed to stay: a digest, plus the
		// moment owners of older boxes stop being asked and start being updated.
		// Absent means no floor - every update is the owner's choice.
		minimum_runtime_image: v.optional(v.string()),
		minimum_runtime_version: v.optional(v.string()),
		minimum_runtime_deadline: v.optional(v.number()),
		// Derived from the one list, never restated: a resource added there must
		// not be storable in the runtime type and unstorable in the column.
		capacity_alert_reason: v.optional(literals(CAPACITY_LIMIT_BLOCK_REASONS)),
		capacity_alert_started_at: v.optional(v.number()),
		updated_at: v.number(),
		updated_by: v.optional(v.string())
	})
});
