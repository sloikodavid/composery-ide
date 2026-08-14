import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { BOX_STATUSES, type BoxStatus } from "@/convex/model/box/status";
import {
	type BoxOperationType,
	BOX_OPERATIONS,
	BOX_OPERATION_TYPES,
	boxEventType
} from "@/convex/model/box/operation";
import { HOUR_MS } from "@/convex/time";
import {
	operationLiveness,
	OPERATION_ORPHAN_GRACE_MS,
	OPERATION_RUNNING_ALERT_MS
} from "@/convex/boxes/operation/sweep";
import { workflow } from "@/convex/boxes/workflows/boxWorkflow";
import {
	readBox,
	readOperation,
	seedBox,
	seedUser,
	staffAlerts,
	stubDeploymentEnv,
	testConvex,
	type Harness
} from "../../../../support/convex.ts";

// "An operation is in flight." Spelled out rather than derived from a name
// pattern: `running` ends the same way and is the healthiest state a box has.
const TRANSIENT_STATUSES: BoxStatus[] = [
	"creating",
	"stopping",
	"starting",
	"resetting",
	"repairing",
	"updating",
	"restoring",
	"suspending",
	"unsuspending",
	"deleting"
];

describe("operationLiveness", () => {
	// The reason this exists at all. An operation whose workflow was never
	// recorded has nothing that will ever close it, and an active operation blocks
	// every later action on its box - so leaving it open makes the box unusable
	// permanently rather than temporarily.
	test("treats an operation with no workflow as orphaned", () => {
		expect(
			operationLiveness({ workflowId: undefined, workflowStatus: null })
		).toMatchObject({ orphaned: true });
	});

	test("treats a workflow the component has lost as orphaned", () => {
		expect(
			operationLiveness({ workflowId: "wf_1", workflowStatus: null })
		).toMatchObject({ orphaned: true });
	});

	test.each(["completed", "failed", "canceled"])(
		"treats a %s workflow with a still-open operation as orphaned",
		(type) => {
			expect(
				operationLiveness({ workflowId: "wf_1", workflowStatus: { type } })
			).toMatchObject({ orphaned: true });
		}
	);

	// The case that must never be closed on a timer. A repair copies a whole disk
	// twice and legitimately runs for hours; failing it while it works would race
	// the workflow for the box's status and could strand the box's files.
	test("leaves a workflow that is still running alone, however long it has run", () => {
		expect(
			operationLiveness({
				workflowId: "wf_1",
				workflowStatus: { type: "inProgress" }
			})
		).toEqual({ orphaned: false });
	});

	// The three reasons are three different facts about the world, and the error
	// is the only record of which one applied - it is what staff read on the
	// rescued operation. Collapsing any two would report a workflow that was never
	// started as one that vanished, which points an investigation at the wrong
	// half of the system.
	test("distinguishes the three reasons an operation is beyond saving", () => {
		const reason = (input: Parameters<typeof operationLiveness>[0]) => {
			const result = operationLiveness(input);
			return result.orphaned ? result.error : null;
		};
		const never = reason({ workflowId: undefined, workflowStatus: null });
		const lost = reason({ workflowId: "wf_1", workflowStatus: null });
		const ended = reason({
			workflowId: "wf_1",
			workflowStatus: { type: "failed" }
		});

		expect(never).toMatch(/No workflow was recorded/);
		expect(lost).toMatch(/no longer exists/);
		expect(ended).toMatch(/ended as "failed"/);
		expect(new Set([never, lost, ended]).size).toBe(3);
	});

	test("always explains why it closed an operation", () => {
		for (const status of [null, { type: "failed" }, { type: "canceled" }]) {
			const result = operationLiveness({
				workflowId: "wf_1",
				workflowStatus: status
			});
			expect(result.orphaned).toBe(true);
			if (result.orphaned) expect(result.error.length).toBeGreaterThan(0);
		}
	});
});

// The sweep puts a rescued box into the status `BOX_OPERATIONS` names,
// so that table has to answer for every operation type - and has to name a status
// that actually exists.
describe("BOX_OPERATIONS", () => {
	const types = BOX_OPERATION_TYPES as BoxOperationType[];

	test("covers every operation type", () => {
		expect(types.length).toBeGreaterThanOrEqual(14);
	});

	test.each(types)("%s names a real box status", (type) => {
		const status = BOX_OPERATIONS[type].onFailure ?? undefined;
		if (status !== undefined) expect(BOX_STATUSES).toContain(status);
	});

	// The event grammar is a function now, so the only thing left to check is that
	// it agrees with the operation type it was derived from.
	test.each(types)("%s derives its failure event from its own name", (type) => {
		expect(boxEventType(type, "failed")).toBe(`box.${type}_failed`);
	});

	// A failure has to leave the box somewhere it can be acted on again, or the
	// rescue puts it in a state nothing can move it out of. Delete is the one that
	// must always work: a box that cannot be removed keeps billing and keeps
	// holding a Hetzner server.
	test.each(types)(
		"%s leaves the box in a status delete can act on",
		(type) => {
			const status = BOX_OPERATIONS[type].onFailure ?? undefined;
			if (status === undefined) return;
			expect(BOX_OPERATIONS.delete.from).toContain(status);
		}
	);

	// A failure must never park the box in a status that means "an operation is in
	// flight" - the operation is precisely what has just stopped, so the box would
	// look busy with nothing running and refuse every action.
	test.each(types)("%s does not leave the box looking busy", (type) => {
		const status = BOX_OPERATIONS[type].onFailure ?? undefined;
		if (status === undefined) return;
		expect(TRANSIENT_STATUSES).not.toContain(status);
	});
});

// The sweep itself, run against the harness. `operationLiveness` above decides
// what is orphaned; these check that the decision is acted on - that a rescued
// operation really is closed, that a live one is left alone, and that the box
// ends up somewhere a person can act on again.
describe("the stuck-operation sweep", () => {
	const NOW = Date.UTC(2026, 5, 6, 7, 8, 9);
	const LONG_AGO = NOW - OPERATION_ORPHAN_GRACE_MS - 1;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		stubDeploymentEnv();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		// The two live-workflow tests below stub the component's `status`. Without
		// this the stub outlives them and every later test reads a workflow that is
		// still running, which is the answer this sweep is built to act on.
		vi.restoreAllMocks();
	});

	async function stuckOperation(
		t: Harness,
		boxId: Id<"boxes">,
		overrides: {
			createdAt?: number;
			type?: BoxOperationType;
			workflowId?: string;
		} = {}
	) {
		return await t.run(
			async (ctx) =>
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: overrides.type ?? "repair",
					status: "pending",
					idempotency_key: `stuck:${boxId}`,
					trigger: "owner",
					workflow_id: overrides.workflowId,
					created_at: overrides.createdAt ?? LONG_AGO,
					updated_at: overrides.createdAt ?? LONG_AGO
				})
		);
	}

	test("closes an operation that never recorded a workflow", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "repairing"
		});
		const operationId = await stuckOperation(t, boxId);

		await t.action(internal.boxes.operation.sweep.sweepStuckOperations, {});

		expect(await readOperation(t, operationId)).toMatchObject({
			status: "failed"
		});
	});

	// The point of the rescue: the box has to come back to a status something can
	// act on, and it has to be the same status an ordinary failure would leave.
	test("leaves the rescued box in the status its failure type names", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "repairing"
		});
		await stuckOperation(t, boxId, { type: "repair" });

		await t.action(internal.boxes.operation.sweep.sweepStuckOperations, {});

		expect(await readBox(t, boxId)).toMatchObject({ status: "repair_failed" });
	});

	test("closes an operation whose workflow the component no longer holds", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "resetting"
		});
		const operationId = await stuckOperation(t, boxId, {
			type: "reset",
			workflowId: "kv;forgotten"
		});

		await t.action(internal.boxes.operation.sweep.sweepStuckOperations, {});

		expect(await readOperation(t, operationId)).toMatchObject({
			status: "failed"
		});
		expect(await readBox(t, boxId)).toMatchObject({ status: "reset_failed" });
	});

	// A just-started operation is the normal state of a busy box. Failing one
	// because its completion callback has not landed yet would break every
	// operation the fleet starts.
	test("ignores an operation younger than the grace period", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "repairing"
		});
		const operationId = await stuckOperation(t, boxId, { createdAt: NOW - 1 });

		await t.action(internal.boxes.operation.sweep.sweepStuckOperations, {});

		expect(await readOperation(t, operationId)).toMatchObject({
			status: "pending"
		});
	});

	test("does not reopen an operation that already finished", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, { user_id: owner.clerkUserId });
		const operationId = await stuckOperation(t, boxId);
		await t.run(
			async (ctx) =>
				await ctx.db.patch(operationId, {
					status: "succeeded",
					finished_at: LONG_AGO
				})
		);

		await t.action(internal.boxes.operation.sweep.sweepStuckOperations, {});

		expect(await readOperation(t, operationId)).toMatchObject({
			status: "succeeded"
		});
	});

	// A repair copies a whole disk twice and legitimately runs for hours, so a
	// workflow that is genuinely in progress goes to a person rather than being
	// cancelled by a sweep.
	test("reports a long-running live operation to staff instead of closing it", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "slow",
			status: "repairing"
		});
		const operationId = await t.run(
			async (ctx) =>
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: "repair",
					status: "running",
					idempotency_key: `slow:${boxId}`,
					trigger: "owner",
					created_at: NOW - OPERATION_RUNNING_ALERT_MS - 1,
					updated_at: NOW
				})
		);

		await t.mutation(internal.boxes.operation.sweep.alertLongRunningOperation, {
			boxId,
			createdAt: NOW - OPERATION_RUNNING_ALERT_MS - 1,
			operationId,
			type: "repair"
		});

		expect(await readOperation(t, operationId)).toMatchObject({
			status: "running"
		});
		expect(await staffAlerts(t)).toMatchObject([
			{ key: `box-operation-long-running:${operationId}`, severity: "warning" }
		]);
	});

	// How long it has been going is the whole of what makes this alert
	// actionable: a person decides whether to cancel a repair from that number,
	// and it is the only part of the message that is computed rather than copied.
	test("says how long the operation has been running, in whole hours", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "slow",
			status: "repairing"
		});
		const operationId = await t.run(
			async (ctx) =>
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: "repair",
					status: "running",
					idempotency_key: `slow:${boxId}`,
					trigger: "owner",
					created_at: NOW - 9 * HOUR_MS,
					updated_at: NOW
				})
		);

		await t.mutation(internal.boxes.operation.sweep.alertLongRunningOperation, {
			boxId,
			createdAt: NOW - 9 * HOUR_MS,
			operationId,
			type: "repair"
		});

		const [alert] = await staffAlerts(t);
		expect(alert.subject).toBe("Box slow: repair has been running 9h");
		// Lower case in both places, because both are sentences: "a repair
		// operation on box slow", not "a Repair operation".
		expect(alert.text).toContain("A repair operation on box slow");
		expect(alert.text).toContain("running for 9 hours");
	});

	// Reached through the sweep rather than by calling the alert directly: the
	// branch that decides an operation is merely slow, not orphaned, is the one
	// that must never close it, and calling the mutation by hand skips it.
	test("alerts on a live operation past the reporting window without closing it", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "slow",
			status: "repairing"
		});
		const operationId = await stuckOperation(t, boxId, {
			createdAt: NOW - OPERATION_RUNNING_ALERT_MS - 1,
			workflowId: "wf_live"
		});
		vi.spyOn(workflow, "status").mockResolvedValue({
			type: "inProgress"
		} as never);

		await t.action(internal.boxes.operation.sweep.sweepStuckOperations, {});

		expect(await readOperation(t, operationId)).toMatchObject({
			status: "pending"
		});
		expect(await staffAlerts(t)).toMatchObject([
			{ key: `box-operation-long-running:${operationId}`, severity: "warning" }
		]);
	});

	// Slow is not the same as stuck. Inside the grace window between the two
	// thresholds a live operation is simply working, and telling staff about it
	// is how a warning stops being read.
	test("says nothing about a live operation that has not reached the window", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "repairing"
		});
		await stuckOperation(t, boxId, {
			createdAt: NOW - OPERATION_RUNNING_ALERT_MS + 1,
			workflowId: "wf_live"
		});
		vi.spyOn(workflow, "status").mockResolvedValue({
			type: "inProgress"
		} as never);

		await t.action(internal.boxes.operation.sweep.sweepStuckOperations, {});

		expect(await staffAlerts(t)).toEqual([]);
	});

	test("lists only operations older than the cutoff it was given", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, { user_id: owner.clerkUserId });
		const old = await stuckOperation(t, boxId, { createdAt: 1_000 });
		await t.run(
			async (ctx) =>
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: "snapshot",
					status: "running",
					idempotency_key: "recent",
					trigger: "owner",
					created_at: 9_000,
					updated_at: 9_000
				})
		);

		const listed = await t.query(
			internal.boxes.operation.sweep.activeOperationsBefore,
			{ before: 5_000 }
		);

		expect(listed.map((row) => row.operationId)).toEqual([old]);
	});
});

// The two guards that keep the rescue from acting on something it should not.
describe("what the rescue refuses to touch", () => {
	const NOW = Date.UTC(2026, 5, 6, 7, 8, 9);

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		stubDeploymentEnv();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	// An operation that has already settled is somebody else's recorded outcome.
	// Reopening it would overwrite a success with a failure nobody experienced.
	test.each(["succeeded", "failed"] as const)(
		"leaves an operation that already %s alone",
		async (status) => {
			const t = testConvex();
			const owner = await seedUser(t);
			const boxId = await seedBox(t, {
				user_id: owner.clerkUserId,
				status: "running"
			});
			const operationId = await t.run(
				async (ctx) =>
					await ctx.db.insert("box_operations", {
						box_id: boxId,
						type: "repair",
						status,
						idempotency_key: `settled:${boxId}`,
						trigger: "owner",
						created_at: NOW,
						updated_at: NOW
					})
			);

			await t.mutation(internal.boxes.operation.sweep.failOrphanedOperation, {
				error: "should not be recorded",
				operationId
			});

			expect(await readOperation(t, operationId)).toMatchObject({ status });
			expect(await readBox(t, boxId)).toMatchObject({ status: "running" });
		}
	);

	// The alert is named from the box, so a box that has since been deleted has
	// nothing to name it with - and staff already know about a deleted box.
	test("raises no long-running alert for a box that is gone", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, { user_id: owner.clerkUserId });
		const operationId = await t.run(
			async (ctx) =>
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: "repair",
					status: "running",
					idempotency_key: `slow:${boxId}`,
					trigger: "owner",
					created_at: NOW - OPERATION_RUNNING_ALERT_MS - 1,
					updated_at: NOW
				})
		);
		await t.run(async (ctx) => await ctx.db.delete(boxId));

		await t.mutation(internal.boxes.operation.sweep.alertLongRunningOperation, {
			boxId,
			createdAt: NOW - OPERATION_RUNNING_ALERT_MS - 1,
			operationId,
			type: "repair"
		});

		expect(await staffAlerts(t)).toEqual([]);
	});

	// The window is inclusive: an operation that has run for exactly the reporting
	// threshold has reached it.
	test("reports an operation that has run for exactly the window", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "repairing"
		});
		const operationId = await t.run(
			async (ctx) =>
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: "repair",
					status: "pending",
					idempotency_key: `exact:${boxId}`,
					trigger: "owner",
					workflow_id: "wf_live",
					created_at: NOW - OPERATION_RUNNING_ALERT_MS,
					updated_at: NOW
				})
		);
		vi.spyOn(workflow, "status").mockResolvedValue({
			type: "inProgress"
		} as never);

		await t.action(internal.boxes.operation.sweep.sweepStuckOperations, {});
		vi.restoreAllMocks();

		expect(await staffAlerts(t)).toMatchObject([
			{ key: `box-operation-long-running:${operationId}` }
		]);
	});
});
