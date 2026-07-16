import type { Doc } from "../_generated/dataModel";
import schema from "../schema";
import { DAY_MS } from "../time";

// window: Deleted box/support evidence
export const DELETED_BOX_RETENTION_DAYS = 180;
export const DELETED_BOX_RETENTION_MS = DELETED_BOX_RETENTION_DAYS * DAY_MS;

export function deletedBoxPurgeAt(deletedAt: number) {
	return deletedAt + DELETED_BOX_RETENTION_MS;
}

// What a deleted box's tombstone keeps. Everything else optional on the row is
// cleared, so this is the whole list of things that outlive the box.
//
// Named as exclusions because the direction of the mistake matters: this used to
// be a hand-written list of the fields to *clear*, and `runtime_config` - the
// owner's own environment for the box, including their GitHub token - was added
// to the schema long after that list and never joined it. A deleted box kept its
// owner's secret in the control plane for the full 180-day retention window, and
// nothing said so: the test guarding the patch used `toMatchObject`, which
// cannot see a field that was left behind. Inverting it means a field added
// tomorrow is scrubbed on the day it exists, and keeping one is a decision
// someone has to write down here.
const TOMBSTONE_KEEPS = new Set([
	// Billing evidence. The subscription outlives the box - a refund, a chargeback
	// or a tax enquiry is answered from these, and `billingRecordPurgeAt` is what
	// eventually retires them.
	"polar_customer_id",
	"polar_subscription_id",
	// Why this box was free, and who decided. A comp is the staff-side equivalent
	// of the two above.
	"comped_by",
	"comped_at",
	"comp_reason",
	// The audit timeline itself: when it first served, when it was deleted, and
	// when the tombstone goes. The last two are written by the patch below.
	"ready_at",
	"deleted_at",
	"purge_at"
]);

// Cleared fields are spelled `undefined` because that is what `db.patch` deletes
// a field with; a field already absent is unaffected.
export function deletedBoxDataPatch(deletedAt: number) {
	const cleared: Record<string, undefined> = {};
	for (const [field, validator] of Object.entries(
		schema.tables.boxes.validator.fields
	)) {
		if (validator.isOptional !== "optional") continue;
		if (TOMBSTONE_KEEPS.has(field)) continue;
		cleared[field] = undefined;
	}

	return {
		...cleared,
		status: "deleted" as const,
		deleted_at: deletedAt,
		purge_at: deletedBoxPurgeAt(deletedAt)
	} satisfies Partial<Doc<"boxes">>;
}

// window: Unpaid checkout record
export const UNPAID_CHECKOUT_RETENTION_DAYS = 30;
export const UNPAID_CHECKOUT_RETENTION_MS =
	UNPAID_CHECKOUT_RETENTION_DAYS * DAY_MS;
// window: Paid billing record
export const BILLING_RECORD_RETENTION_YEARS = 6;

export function unpaidCheckoutPurgeAt(finishedAt: number) {
	return finishedAt + UNPAID_CHECKOUT_RETENTION_MS;
}

// Also the window on a legal notice record (convex/notice/legal.ts), and not by
// coincidence: both are evidence held against a claim, and the period that
// decides how long either is worth holding is the six years the Statute of
// Limitations 1957 gives a contract action in Ireland. Shortening this shortens
// both, which is correct - but it is the kind of correct somebody should mean.
export function billingRecordPurgeAt(finishedAt: number) {
	const date = new Date(finishedAt);
	date.setUTCFullYear(date.getUTCFullYear() + BILLING_RECORD_RETENTION_YEARS);
	return date.getTime();
}

// The reason a suspension recorded, narrowed out of free-form operation
// metadata. Two readers need the same answer - what survives a box's deletion,
// and what the owner is told when the suspension happens - and one of them puts
// it in an email, so a value that is not a usable string has to be nothing in
// both rather than reach an inbox as "[object Object]".
export function suspensionReason(
	metadata: Record<string, unknown> | undefined
) {
	const reason = metadata?.reason;
	return typeof reason === "string" && reason.trim() ? reason : undefined;
}

export function retainedOperationMetadata(
	type: string,
	metadata: Record<string, unknown> | undefined
) {
	const reason = type === "suspend" ? suspensionReason(metadata) : undefined;
	return reason ? { reason } : undefined;
}

// What to clear when a checkout intent reaches a terminal state: the live
// checkout link, which is a capability anyone holding it could act on and which
// means nothing once the intent is converted, released, or expired.
//
// Every call site patches a `box_checkout_intents` row, so this may only name
// fields that table has - Convex validates a patch against the table's own
// validator, so one field belonging to `boxes` here throws on every checkout
// release, every expiry sweep, and the conversion of a paid order into a box.
// The behaviour tests under `tests/behavior/convex/checkout/` and
// `tests/behavior/convex/billing/` run those mutations, so a wrong field fails
// them rather than shipping.
export function terminalCheckoutSecretPatch() {
	return {
		polar_checkout_url: undefined
	};
}

export function deletedCheckoutSlug(intentId: string) {
	return `deleted-${intentId}`;
}
