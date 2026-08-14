import { describe, expect, test } from "vitest";
import {
	DEFAULT_SNAPSHOT_POLICY,
	SNAPSHOT_CAPTURE_DEADLINE_MS,
	SNAPSHOT_POLL_FAST_MS,
	SNAPSHOT_POLL_FAST_WINDOW_MS,
	SNAPSHOT_POLL_SLOW_MS,
	manualSnapshotIntervalMs,
	SNAPSHOT_SCHEDULE_STAGGER_MS,
	resolveSnapshotPolicy,
	snapshotEvictionCount,
	snapshotImagePollStatus,
	snapshotPollOutcome,
	snapshotSizeBytes,
	snapshotExpiry,
	snapshotIdempotencyBucket,
	snapshotPolicyToStored,
	snapshotPollDelayMs,
	snapshotScheduleDelayMs
} from "@/convex/boxes/snapshotPolicy";

const DAY = 24 * 60 * 60 * 1000;

// Which snapshots are kept on a timer and which are kept until somebody removes
// them. Every class is named, so adding one without deciding this fails here as
// well as at the type level.
describe("snapshot retention", () => {
	const created = 1_000_000;

	// The owner's own checkpoint outlives every window. Their allowance is what
	// bounds how many they hold; a retention window could only ever delete work
	// somebody deliberately kept.
	test("gives a manual snapshot no expiry at all", () => {
		expect(
			snapshotExpiry("manual", created, DEFAULT_SNAPSHOT_POLICY)
		).toBeUndefined();
	});

	test.each([["scheduled"], ["rollback"]] as const)(
		"expires a %s snapshot on the automatic window",
		(cls) => {
			expect(snapshotExpiry(cls, created, DEFAULT_SNAPSHOT_POLICY)).toBe(
				created + 5 * DAY
			);
			expect(
				snapshotExpiry(cls, created, {
					...DEFAULT_SNAPSHOT_POLICY,
					automaticRetentionDays: 1
				})
			).toBe(created + DAY);
		}
	);
});

describe("resolveSnapshotPolicy", () => {
	test("returns defaults without a stored policy", () => {
		expect(resolveSnapshotPolicy(undefined)).toEqual(DEFAULT_SNAPSHOT_POLICY);
	});

	test("keeps safe stored values and falls back unsafe fields independently", () => {
		expect(
			resolveSnapshotPolicy({
				manual_min_interval_minutes: 14,
				automatic_retention_days: Number.POSITIVE_INFINITY
			})
		).toEqual({
			manualMinIntervalMinutes: 14,
			automaticRetentionDays: DEFAULT_SNAPSHOT_POLICY.automaticRetentionDays
		});
	});

	test("rejects unsafe policy values before storage conversion", () => {
		expect(() =>
			snapshotPolicyToStored({
				...DEFAULT_SNAPSHOT_POLICY,
				automaticRetentionDays: 0
			})
		).toThrow("automaticRetentionDays must be a positive integer.");
	});
});

// Which Hetzner image status means the snapshot is usable. Everything else is
// "not yet", including a status this deployment has never seen - the capture
// waits and the deadline ends it, rather than reporting a way back that the
// provider has not confirmed exists.
describe("reading a Hetzner image status", () => {
	test("treats an available image as the capture finishing", () => {
		expect(snapshotImagePollStatus("available")).toBe("success");
	});

	test.each([["creating"], ["unavailable"], [undefined]])(
		"treats %s as still running",
		(status) => {
			expect(snapshotImagePollStatus(status)).toBe("running");
		}
	);
});

describe("snapshot poll backoff", () => {
	test("polls fast inside the opening window, then backs off", () => {
		expect(snapshotPollDelayMs(0)).toBe(SNAPSHOT_POLL_FAST_MS);
		expect(snapshotPollDelayMs(SNAPSHOT_POLL_FAST_WINDOW_MS - 1)).toBe(
			SNAPSHOT_POLL_FAST_MS
		);
		expect(snapshotPollDelayMs(SNAPSHOT_POLL_FAST_WINDOW_MS)).toBe(
			SNAPSHOT_POLL_SLOW_MS
		);
		expect(snapshotPollDelayMs(SNAPSHOT_CAPTURE_DEADLINE_MS)).toBe(
			SNAPSHOT_POLL_SLOW_MS
		);
	});

	test("walks the whole deadline in a finite number of polls", () => {
		// The capture loop adds snapshotPollDelayMs each iteration until the
		// deadline; a regression that returned 0 here would spin forever.
		let waited = 0;
		let polls = 0;
		while (waited < SNAPSHOT_CAPTURE_DEADLINE_MS) {
			waited += snapshotPollDelayMs(waited);
			polls += 1;
			expect(polls).toBeLessThan(10_000);
		}
		expect(polls).toBeGreaterThan(0);
	});
});

describe("snapshotScheduleDelayMs", () => {
	test("staggers scheduled snapshots by their fleet index", () => {
		expect(snapshotScheduleDelayMs(0)).toBe(0);
		expect(snapshotScheduleDelayMs(1)).toBe(SNAPSHOT_SCHEDULE_STAGGER_MS);
		expect(snapshotScheduleDelayMs(5)).toBe(5 * SNAPSHOT_SCHEDULE_STAGGER_MS);
	});
});

describe("snapshotIdempotencyBucket", () => {
	test("collapses requests inside one min-interval window, separates later ones", () => {
		const now = 1_000_000_000;
		const interval = manualSnapshotIntervalMs(DEFAULT_SNAPSHOT_POLICY);
		const bucket = snapshotIdempotencyBucket(now, interval);
		expect(snapshotIdempotencyBucket(now + 1000, interval)).toBe(bucket);
		expect(snapshotIdempotencyBucket(now + interval, interval)).not.toBe(
			bucket
		);
	});

	// The window is the configured one, not the shipped default: a deployment
	// that lengthened the interval must collapse requests the default would
	// have separated.
	test("follows a configured interval rather than the default", () => {
		const now = 1_000_000_000;
		const shipped = manualSnapshotIntervalMs(DEFAULT_SNAPSHOT_POLICY);
		const longer = manualSnapshotIntervalMs({
			...DEFAULT_SNAPSHOT_POLICY,
			manualMinIntervalMinutes:
				DEFAULT_SNAPSHOT_POLICY.manualMinIntervalMinutes * 4
		});
		expect(snapshotIdempotencyBucket(now + shipped, longer)).toBe(
			snapshotIdempotencyBucket(now, longer)
		);
	});
});

describe("snapshotEvictionCount", () => {
	test("requires no eviction below the cap", () => {
		expect(snapshotEvictionCount(6, 7)).toBe(0);
	});

	test("evicts one snapshot at the cap to leave room for the new row", () => {
		expect(snapshotEvictionCount(7, 7)).toBe(1);
	});

	test("evicts enough snapshots to land at the cap after inserting", () => {
		expect(snapshotEvictionCount(9, 7)).toBe(3);
	});
});

// Well below the cap the answer is "none", not a negative number. The guard is
// what makes that true: the arithmetic alone returns a negative count, and a
// caller passing it to `.take()` would ask the database for a negative page.
describe("evictions well below the cap", () => {
	test("asks for no evictions rather than a negative count", () => {
		expect(snapshotEvictionCount(0, 7)).toBe(0);
		expect(snapshotEvictionCount(3, 7)).toBe(0);
	});
});

// The capture loop's whole decision, lifted out of the workflow body where no
// test could reach any of its four branches. A snapshot is an owner's only copy
// of their files at a point in time, so each terminal answer here is one that
// either keeps it or throws it away.
describe("what the capture loop does about one Hetzner action", () => {
	test("finishes on success", () => {
		expect(snapshotPollOutcome({ status: "success", waitedMs: 0 })).toEqual({
			type: "complete"
		});
	});

	test("repeats the reason Hetzner gave for an error", () => {
		expect(
			snapshotPollOutcome({
				status: "error",
				error: "server has a running action",
				waitedMs: 0
			})
		).toEqual({ type: "failed", error: "server has a running action" });
	});

	// A failure with no reason still has to say something: "no error recorded"
	// reaching an operator as an empty string is a failure nobody can triage.
	test("names the failure even when Hetzner gave no reason", () => {
		expect(
			snapshotPollOutcome({ status: "error", error: null, waitedMs: 0 })
		).toEqual({
			type: "failed",
			error: "Hetzner snapshot creation failed."
		});
	});

	test("waits while the action is still running", () => {
		expect(snapshotPollOutcome({ status: "running", waitedMs: 0 })).toEqual({
			type: "wait",
			delayMs: SNAPSHOT_POLL_FAST_MS
		});
	});

	test("backs off once the fast window has passed", () => {
		expect(
			snapshotPollOutcome({ status: "running", waitedMs: 5 * 60_000 })
		).toEqual({ type: "wait", delayMs: SNAPSHOT_POLL_SLOW_MS });
	});

	test("gives up on an action still running past the deadline", () => {
		expect(
			snapshotPollOutcome({
				status: "running",
				waitedMs: SNAPSHOT_CAPTURE_DEADLINE_MS
			})
		).toEqual({
			type: "failed",
			error: "Snapshot creation did not finish before the deadline."
		});
	});

	// Ordering, and the reason it is the order it is: an action that has already
	// succeeded is a success however long the loop took to notice. Failing it
	// would abandon a snapshot image that exists and bills until reconciliation
	// finds it - and would tell the owner their snapshot failed when it did not.
	test("honours a success that arrived after the deadline", () => {
		expect(
			snapshotPollOutcome({
				status: "success",
				waitedMs: SNAPSHOT_CAPTURE_DEADLINE_MS * 10
			})
		).toEqual({ type: "complete" });
	});

	test("still reports Hetzner's own error past the deadline", () => {
		expect(
			snapshotPollOutcome({
				status: "error",
				error: "quota exceeded",
				waitedMs: SNAPSHOT_CAPTURE_DEADLINE_MS * 10
			})
		).toEqual({ type: "failed", error: "quota exceeded" });
	});
});

// Hetzner reports gigabytes; the row stores bytes. The snapshot list prints it.
describe("recording how big a snapshot is", () => {
	test("converts gigabytes to bytes", () => {
		expect(snapshotSizeBytes(2.5)).toBe(2_500_000_000);
	});

	test("rounds to whole bytes", () => {
		expect(snapshotSizeBytes(1.0000000004)).toBe(1_000_000_000);
	});

	// No size yet is no size, not zero: a stored 0 renders as a snapshot that
	// captured nothing, which is a different and alarming claim.
	test.each([
		["an image with no size reported", undefined],
		["a size of zero", 0]
	])("records nothing for %s", (_name, sizeGb) => {
		expect(snapshotSizeBytes(sizeGb)).toBeUndefined();
	});
});
