import type { StoredSnapshotPolicy } from "../schema";
import { SNAPSHOT_CLASSES, type SnapshotClass } from "../model/box/snapshot";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "../time";

export type SnapshotPolicy = {
	manualMinIntervalMinutes: number;
	automaticRetentionDays: number;
};

// Timing only. How many snapshots a box may hold is its plan's business and how
// they are split is its owner's; this is how long the ones this deployment takes
// by itself last, and how often the owner may take one.
//
// There is no manual retention to set. The snapshots this deployment takes are
// rolling - a daily one for disaster recovery, a rollback one before an
// operation that cannot be undone - so a window is what bounds how many exist.
// A manual snapshot is the owner's own checkpoint, and their allowance is the
// only thing that bounds it; a window would delete work somebody chose to keep.
export const DEFAULT_SNAPSHOT_POLICY: SnapshotPolicy = {
	manualMinIntervalMinutes: 5,
	automaticRetentionDays: 5
};

// The one conversion of the stored minutes into the milliseconds every caller
// actually compares against. It was written out at each call site, which is how
// the two that matter came to sit beside a module constant derived from the
// *default* policy - a value that looked like the interval and ignored the
// setting.
export function manualSnapshotIntervalMs(policy: SnapshotPolicy) {
	return policy.manualMinIntervalMinutes * MINUTE_MS;
}

function positiveInteger(value: number) {
	return Number.isFinite(value) && value > 0 && Number.isInteger(value);
}

function resolvedPositiveInteger(value: number, fallback: number) {
	return positiveInteger(value) ? value : fallback;
}

export function resolveSnapshotPolicy(
	stored: StoredSnapshotPolicy | undefined
): SnapshotPolicy {
	if (!stored) return DEFAULT_SNAPSHOT_POLICY;
	return {
		manualMinIntervalMinutes: resolvedPositiveInteger(
			stored.manual_min_interval_minutes,
			DEFAULT_SNAPSHOT_POLICY.manualMinIntervalMinutes
		),
		automaticRetentionDays: resolvedPositiveInteger(
			stored.automatic_retention_days,
			DEFAULT_SNAPSHOT_POLICY.automaticRetentionDays
		)
	};
}

export function snapshotPolicyToStored(
	policy: SnapshotPolicy
): StoredSnapshotPolicy {
	validateSnapshotPolicy(policy);
	return {
		manual_min_interval_minutes: policy.manualMinIntervalMinutes,
		automatic_retention_days: policy.automaticRetentionDays
	};
}

export function validateSnapshotPolicy(policy: SnapshotPolicy) {
	const { manualMinIntervalMinutes, automaticRetentionDays } = policy;
	const values = { manualMinIntervalMinutes, automaticRetentionDays };
	for (const [key, value] of Object.entries(values)) {
		if (!positiveInteger(value)) {
			throw new Error(`${key} must be a positive integer.`);
		}
	}
}

// Derived constants kept in code: stagger, incomplete retention, sweep batch,
// poll cadence, and capture deadline are internal scheduling/cleanup concerns,
// not operator policy.
export const SNAPSHOT_SCHEDULE_STAGGER_MS = 20 * 1000;

// window: Incomplete snapshot-row retention
export const SNAPSHOT_INCOMPLETE_RETENTION_MS = DAY_MS;

export const SNAPSHOT_RETENTION_SWEEP_BATCH = 200;

export const SNAPSHOT_POLL_FAST_MS = 10 * 1000;
export const SNAPSHOT_POLL_SLOW_MS = 30 * 1000;
export const SNAPSHOT_POLL_FAST_WINDOW_MS = MINUTE_MS;
// window: Snapshot capture deadline
export const SNAPSHOT_CAPTURE_DEADLINE_MS = HOUR_MS;

// When a completed snapshot of this class stops being kept, or `undefined` where
// nothing removes it on a timer.
//
// `undefined` is not "not decided yet": it is the decision, and it is the only
// way a row ends up without an expiry once it has completed. Every row is given
// one at insert (`SNAPSHOT_INCOMPLETE_RETENTION_MS`), so an absent `expires_at`
// on a stored row means exactly one thing - a completed snapshot of a class that
// does not expire. The retention sweep bounds its range from below and therefore
// never selects one, which is what makes the two statements the same statement.
export function snapshotExpiry(
	cls: SnapshotClass,
	createdAt: number,
	policy: SnapshotPolicy
) {
	if (!SNAPSHOT_CLASSES[cls].expires) return undefined;
	return createdAt + policy.automaticRetentionDays * DAY_MS;
}

// What one Hetzner image status means to the capture loop.
//
// Hetzner reports an image as `available` once it can be restored from; every
// other value - `creating`, or one we have never seen - is "not yet", and the
// deadline in `snapshotPollOutcome` is what stops "not yet" going on forever.
//
// It is here rather than inside the capture loop because it is a decision, not
// wiring: which provider word means the snapshot is usable. The loop lives in
// a workflow body, which no test can run, so a decision left there is one nothing
// can check - and this is the decision that says whether an owner has a way back.
export function snapshotImagePollStatus(imageStatus: string | undefined) {
	return imageStatus === "available" ? "success" : "running";
}

export type SnapshotPollOutcome =
	| { type: "complete" }
	| { type: "failed"; error: string }
	| { type: "wait"; delayMs: number };

// What the capture loop does about one Hetzner action status, decided in one
// place instead of as four branches inside a workflow body nothing can reach.
//
// The deadline is checked *after* the terminal statuses, and that order is the
// point: an action that has already succeeded is a success even if the loop took
// longer than the deadline to notice, and failing it there would delete a
// snapshot image that exists and bill for it until reconciliation finds it.
export function snapshotPollOutcome(input: {
	error?: string | null;
	status: string;
	waitedMs: number;
}): SnapshotPollOutcome {
	if (input.status === "success") return { type: "complete" };
	if (input.status === "error") {
		return {
			type: "failed",
			error: input.error ?? "Hetzner snapshot creation failed."
		};
	}
	if (input.waitedMs >= SNAPSHOT_CAPTURE_DEADLINE_MS) {
		return {
			type: "failed",
			error: "Snapshot creation did not finish before the deadline."
		};
	}
	return { type: "wait", delayMs: snapshotPollDelayMs(input.waitedMs) };
}

// Hetzner reports an image's size in gigabytes; the row stores bytes, so the
// chart and the console are not each doing this multiplication. An image with no
// size yet is stored as no size rather than as zero, which would read as a
// snapshot that captured nothing.
export function snapshotSizeBytes(imageSizeGb: number | undefined) {
	return imageSizeGb ? Math.round(imageSizeGb * 1e9) : undefined;
}

// Pure (no clock read) so it stays safe to call inside a workflow handler.
export function snapshotPollDelayMs(waitedMs: number) {
	return waitedMs < SNAPSHOT_POLL_FAST_WINDOW_MS
		? SNAPSHOT_POLL_FAST_MS
		: SNAPSHOT_POLL_SLOW_MS;
}

export function snapshotScheduleDelayMs(scheduledIndex: number) {
	return scheduledIndex * SNAPSHOT_SCHEDULE_STAGGER_MS;
}

// The window one automatic snapshot's idempotency key covers, and therefore the
// cadence of the "snapshot running boxes" cron: a re-run of tonight's sweep
// deduplicates against tonight's key, and tomorrow's does not.
//
// Its own constant because it used to borrow `manualMinIntervalMinutes` - an
// operator setting about a different thing entirely. Set that above a day and
// consecutive nights fall into one bucket, so `startBoxOperation` returns null
// and the box simply does not get its daily snapshot. Nothing fails, nothing is
// recorded, and the first symptom is a restore that has nothing recent to
// restore from. `tests/behavior/convex/crons.test.ts` pins the cron to it.
export const AUTOMATIC_SNAPSHOT_INTERVAL_MS = DAY_MS;

// No defaults: every caller holds the resolved policy already, and a default
// here would silently answer with the shipped one when a deployment had
// configured something else.
export function snapshotIdempotencyBucket(
	now: number,
	manualMinIntervalMs: number
) {
	return Math.floor(now / manualMinIntervalMs).toString(36);
}

export function snapshotEvictionCount(
	activeSnapshotCount: number,
	cap: number
) {
	return activeSnapshotCount >= cap ? activeSnapshotCount - cap + 1 : 0;
}
