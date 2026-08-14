import { describe, expect, test } from "vitest";
import {
	BOX_OPERATION_TYPES,
	BOX_OPERATIONS,
	boxEventLabel,
	boxEventType,
	failureNotice,
	isActiveOperationStatus,
	isOperationAllowed,
	OPERATION_OUTCOMES,
	type BoxOperationType
} from "@/convex/model/box/operation";
import { BOX_STATUSES } from "@/convex/model/box/status";

// The catalogue is the subject, so the list of operations comes from the
// catalogue itself. Restating it here would mean a new operation gets an empty
// row and is simply never permitted, with every test still green.
const TYPES = BOX_OPERATION_TYPES;

describe("the operation catalogue", () => {
	// A row with no starting status is an operation nothing can ever begin. The
	// type checker cannot catch it - an empty array satisfies `BoxStatus[]` - so
	// this is the one shape of a wrong row that has to be asserted.
	test.each(TYPES)("gives %s at least one status it can start from", (type) => {
		expect(BOX_OPERATIONS[type].from.length).toBeGreaterThan(0);
	});

	test.each(TYPES)("never allows %s on a deleted or dying box", (type) => {
		expect(isOperationAllowed("deleted", type)).toBe(false);
		expect(isOperationAllowed("deleting", type)).toBe(false);
	});

	// `during` and `onFailure` are what the begin-status and failure-status
	// validators are derived from, so a row naming a status that does not exist
	// would silently widen both.
	test.each(TYPES)("names only real statuses for %s", (type) => {
		const { during, onFailure } = BOX_OPERATIONS[type];
		if (during !== null) expect(BOX_STATUSES).toContain(during);
		if (onFailure !== null) expect(BOX_STATUSES).toContain(onFailure);
	});
});

describe("isOperationAllowed", () => {
	test("starts a box only from stopped", () => {
		expect(isOperationAllowed("stopped", "start")).toBe(true);
		expect(isOperationAllowed("running", "start")).toBe(false);
		expect(isOperationAllowed("suspended", "start")).toBe(false);
	});

	test("stops a box only while running", () => {
		expect(isOperationAllowed("running", "stop")).toBe(true);
		expect(isOperationAllowed("stopped", "stop")).toBe(false);
		expect(isOperationAllowed("suspended", "stop")).toBe(false);
	});

	test("suspends from running or stopped, unsuspends only from suspended", () => {
		expect(isOperationAllowed("running", "suspend")).toBe(true);
		expect(isOperationAllowed("stopped", "suspend")).toBe(true);
		expect(isOperationAllowed("suspended", "suspend")).toBe(false);
		expect(isOperationAllowed("suspended", "unsuspend")).toBe(true);
		expect(isOperationAllowed("running", "unsuspend")).toBe(false);
	});

	test("resets from running or reset_failed", () => {
		expect(isOperationAllowed("running", "reset")).toBe(true);
		expect(isOperationAllowed("reset_failed", "reset")).toBe(true);
		expect(isOperationAllowed("stopped", "reset")).toBe(false);
	});

	test("snapshots and restores only a running box", () => {
		expect(isOperationAllowed("running", "snapshot")).toBe(true);
		expect(isOperationAllowed("stopped", "snapshot")).toBe(false);
		expect(isOperationAllowed("running", "restore")).toBe(true);
		expect(isOperationAllowed("suspended", "restore")).toBe(false);
	});

	test("retries creation from creating or create_failed", () => {
		expect(isOperationAllowed("creating", "create")).toBe(true);
		expect(isOperationAllowed("create_failed", "create")).toBe(true);
		expect(isOperationAllowed("running", "create")).toBe(false);
	});

	// Repair needs a running box with real files and a reachable host, and must be
	// retryable from its own failed state so a crashed repair can resume from its
	// parking volume. A box that never finished being created has no files worth
	// keeping, so it is excluded; a powered-off box has no host to reach over SSH,
	// which is every repair step.
	test("repairs a usable box or retries a failed repair, but not empty or off boxes", () => {
		expect(isOperationAllowed("running", "repair")).toBe(true);
		expect(isOperationAllowed("repair_failed", "repair")).toBe(true);
		expect(isOperationAllowed("reset_failed", "repair")).toBe(true);
		expect(isOperationAllowed("restore_failed", "repair")).toBe(true);
		expect(isOperationAllowed("create_failed", "repair")).toBe(false);
		expect(isOperationAllowed("stopped", "repair")).toBe(false);
		expect(isOperationAllowed("suspended", "repair")).toBe(false);
		expect(isOperationAllowed("repairing", "repair")).toBe(false);
	});

	// The rollback path. A box broken by an update is recovered by repairing it:
	// Repair renders the compose file from `box.runtime_image`, which an update
	// only advances after the new image has answered, so repairing a failed update
	// reinstates the last image known to serve. If this ever returns false, a
	// failed update has no recovery that keeps the box's files.
	test("repairs a box left broken by a failed update", () => {
		expect(isOperationAllowed("update_failed", "repair")).toBe(true);
	});

	// Update recreates the container on a new image, so it needs a live host to
	// reach over SSH, exactly like Repair. Retrying from its own failed state
	// covers the transient case (registry unreachable, pull timed out).
	test("updates a running box or retries a failed update, but not an off box", () => {
		expect(isOperationAllowed("running", "update")).toBe(true);
		expect(isOperationAllowed("update_failed", "update")).toBe(true);
		expect(isOperationAllowed("stopped", "update")).toBe(false);
		expect(isOperationAllowed("suspended", "update")).toBe(false);
		expect(isOperationAllowed("updating", "update")).toBe(false);
		expect(isOperationAllowed("create_failed", "update")).toBe(false);
	});

	test("allows deleting from every live state except deleting and deleted", () => {
		for (const status of BOX_STATUSES) {
			const allowed = isOperationAllowed(status, "delete");
			if (status === "deleting" || status === "deleted") {
				expect(allowed).toBe(false);
			} else {
				expect(allowed).toBe(true);
			}
		}
	});
});

describe("isActiveOperationStatus", () => {
	test("treats pending and running as active, the rest as settled", () => {
		expect(isActiveOperationStatus("pending")).toBe(true);
		expect(isActiveOperationStatus("running")).toBe(true);
		expect(isActiveOperationStatus("succeeded")).toBe(false);
		expect(isActiveOperationStatus("failed")).toBe(false);
	});
});

describe("failureNotice", () => {
	test("says nothing when the last operation did not fail", () => {
		expect(failureNotice(null, "owner")).toBeNull();
	});

	// The whole point: before this, only repair and update explained a failure,
	// and every other operation left the owner with a status word and no reason
	// anywhere in the interface.
	test.each(TYPES)("has an answer for a failed %s", (type) => {
		const notice = failureNotice(
			{ error: "boom", finishedAt: 1, type },
			"staff"
		);
		expect(notice).not.toBeNull();
		expect(notice?.title.length).toBeGreaterThan(0);
		expect(notice?.detail).toBe("boom");
	});

	// An error with no recorded reason must say so rather than render an empty
	// line, which reads as "nothing wrong here" - the failure mode this whole
	// change is about.
	test("says when no reason was recorded", () => {
		expect(
			failureNotice({ error: null, finishedAt: 1, type: "reset" }, "owner")
				?.detail
		).toBe("No reason was recorded.");
	});

	// Failures an owner cannot act on stay in the console. A scheduled snapshot
	// hitting a fleet-wide Hetzner limit is not something a box owner can fix, and
	// telling them their box failed something would be alarming and useless.
	test.each(["snapshot", "suspend", "unsuspend"] as BoxOperationType[])(
		"hides a failed %s from the owner but not from staff",
		(type) => {
			expect(
				failureNotice({ error: "x", finishedAt: 1, type }, "owner")
			).toBeNull();
			expect(
				failureNotice({ error: "x", finishedAt: 1, type }, "staff")
			).not.toBeNull();
		}
	);

	// The ones an owner is expected to act on carry the action. Without this the
	// notice states a problem and stops, which is the shape of an error message
	// nobody can use.
	test.each([
		"create",
		"reset",
		"restore",
		"repair",
		"update",
		"change_slug",
		"change_config"
	] as BoxOperationType[])(
		"tells the owner what to do about a failed %s",
		(type) => {
			expect(
				failureNotice({ error: "x", finishedAt: 1, type }, "owner")?.hint
			).toBeTruthy();
		}
	);
});

describe("boxEventLabel", () => {
	// The audit history used to print the stored identifier, so a staff page read
	// "box.change_config_failed". Every name the grammar can produce has to come
	// back as words, and the pair is asserted through `boxEventType` so the two
	// halves cannot drift apart.
	test.each(
		TYPES.flatMap((type) =>
			OPERATION_OUTCOMES.map((outcome) => [type, outcome] as const)
		)
	)("names a %s that %s", (type, outcome) => {
		const label = boxEventLabel(boxEventType(type, outcome));

		expect(label).not.toContain("_");
		expect(label).not.toContain("box.");
		expect(label.endsWith(outcome)).toBe(true);
	});

	test("names the facts a box records that are not an operation", () => {
		expect(boxEventLabel("server.created")).toBe("Server created");
		expect(boxEventLabel("box.parking_volume_restoring")).toBe(
			"Parking volume restoring"
		);
	});
});
