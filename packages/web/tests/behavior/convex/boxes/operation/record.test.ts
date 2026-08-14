import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { internal } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import {
	BOX_OPERATIONS,
	BOX_OPERATION_TYPES,
	type BoxOperationType
} from "@/convex/model/box/operation";
import type { OperationTrigger } from "@/convex/schema";

import {
	boxEvents,
	readBox,
	readOperation,
	seedBox,
	scheduledArgs,
	scheduledJobs,
	seedUser,
	staffAlerts,
	stubDeploymentEnv,
	testConvex,
	type Harness
} from "../../../../support/convex.ts";

// How a box's operations end. The invariant every test here defends is that a
// finished operation is never left active: an active operation blocks every
// later action on its box, so a failure that fails to record itself is worse
// than the failure.

const NOW = Date.UTC(2026, 3, 4, 5, 6, 7);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	stubDeploymentEnv();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

async function openOperation(
	t: Harness,
	boxId: Id<"boxes">,
	type: BoxOperationType = "reset",
	metadata?: Record<string, unknown>
) {
	return await t.run(
		async (ctx) =>
			await ctx.db.insert("box_operations", {
				box_id: boxId,
				type,
				status: "pending",
				idempotency_key: `${type}:${boxId}`,
				trigger: "owner",
				workflow_id: "wf_1",
				metadata,
				created_at: NOW,
				updated_at: NOW
			})
	);
}

// What an owner was told, read from the box's own log - which is where the
// record of every owner notice lives, beside the event that prompted it.
async function sentOwnerEmails(t: Harness, boxId: Id<"boxes">) {
	return (await boxEvents(t, boxId))
		.filter((event) => event.type === "box.owner_emailed")
		.map((event) => event.metadata);
}

describe("recording an operation failure", () => {
	test("closes the operation with the error the caller reported", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "resetting"
		});
		const operationId = await openOperation(t, boxId);

		await t.mutation(internal.boxes.operation.record.markOperationFailed, {
			boxId,
			error: "the host never answered",
			operationId,
			targetBoxStatus: "reset_failed"
		});

		expect(await readOperation(t, operationId)).toMatchObject({
			status: "failed",
			last_error: "the host never answered",
			finished_at: NOW
		});
	});

	test("puts the box into the status that failure leaves it in", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "resetting"
		});
		const operationId = await openOperation(t, boxId);

		await t.mutation(internal.boxes.operation.record.markOperationFailed, {
			boxId,
			error: "boom",
			operationId,
			targetBoxStatus: "reset_failed"
		});

		expect(await readBox(t, boxId)).toMatchObject({ status: "reset_failed" });
	});

	// A snapshot never moved the box, so its failure has nothing to put back.
	test("leaves the box alone for a failure with no status to restore", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "running"
		});
		const operationId = await openOperation(t, boxId, "snapshot");

		await t.mutation(internal.boxes.operation.record.markOperationFailed, {
			boxId,
			error: "hetzner said no",
			operationId
		});

		expect(await readBox(t, boxId)).toMatchObject({ status: "running" });
		expect(await readOperation(t, operationId)).toMatchObject({
			status: "failed"
		});
	});

	test("writes the failure to the box's event log", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "repairing"
		});
		const operationId = await openOperation(t, boxId, "repair");

		await t.mutation(internal.boxes.operation.record.markOperationFailed, {
			boxId,
			error: "ssh refused",
			operationId,
			targetBoxStatus: "repair_failed"
		});

		expect(await boxEvents(t, boxId)).toMatchObject([
			{ type: "box.repair_failed", message: "ssh refused" }
		]);
	});

	// A box deleted while one of its operations was in flight used to leave that
	// operation active forever, because recording the failure threw on the missing
	// box before it got to the row. Closing the operation is the part that has to
	// happen regardless.
	test("still closes the operation when the box it belonged to is gone", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, { user_id: owner.clerkUserId });
		const operationId = await openOperation(t, boxId);
		await t.run(async (ctx) => await ctx.db.delete(boxId));

		await t.mutation(internal.boxes.operation.record.markOperationFailed, {
			boxId,
			error: "box vanished",
			operationId,
			targetBoxStatus: "reset_failed"
		});

		expect(await readOperation(t, operationId)).toMatchObject({
			status: "failed",
			last_error: "box vanished"
		});
	});
});

describe("staff alerting on failure", () => {
	// Every type, not a sample. The severity used to be decided by testing a set
	// of type names against the operation's prose label, which silently downgraded
	// every type whose label differs from its identifier - `delete`, labelled
	// "Remove", is the one that matters and it is the one a two-case test missed.
	test.each(
		BOX_OPERATION_TYPES.map((type) => [
			type,
			BOX_OPERATIONS[type].critical
		]) as [BoxOperationType, boolean][]
	)(
		"a failed %s alerts staff at the severity its blast radius earns",
		async (type, critical) => {
			const t = testConvex();
			const owner = await seedUser(t);
			const boxId = await seedBox(t, {
				user_id: owner.clerkUserId,
				status: "running"
			});
			const operationId = await openOperation(t, boxId, type);

			await t.mutation(internal.boxes.operation.record.markOperationFailed, {
				boxId,
				error: "ssh refused",
				operationId,
				targetBoxStatus: BOX_OPERATIONS[type].onFailure ?? undefined
			});

			expect(await staffAlerts(t)).toMatchObject([
				{
					severity: critical ? "critical" : "warning",
					key: `box-operation-failed:${operationId}`
				}
			]);
		}
	);

	// Everything this records - the event name, the alert's severity and subject,
	// the owner mail - is named from the operation row, so a missing one has no
	// tolerable reading. It refuses rather than filing an unattributed alert.
	test("refuses to record a failure whose operation row is gone", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "stopping"
		});
		const operationId = await openOperation(t, boxId, "stop");
		await t.run(async (ctx) => await ctx.db.delete(operationId));

		await expect(
			t.mutation(internal.boxes.operation.record.markOperationFailed, {
				boxId,
				error: "transient",
				operationId,
				targetBoxStatus: "running"
			})
		).rejects.toThrow("Box operation not found.");
		expect(await staffAlerts(t)).toEqual([]);
	});

	test("carries the recorded error into the alert staff read", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "resetting"
		});
		const operationId = await openOperation(t, boxId);

		await t.mutation(internal.boxes.operation.record.markOperationFailed, {
			boxId,
			error: "the host never answered",
			operationId,
			targetBoxStatus: "reset_failed"
		});

		const [alert] = await staffAlerts(t);
		expect(alert.text).toContain("the host never answered");
	});

	// Prose, and the operation named in the middle of a sentence. Identifiers and
	// prose are separate vocabularies here, so a subject built from the raw type
	// would read "Box x: change_slug failed" and a capitalised label would read as
	// a proper noun mid-sentence.
	test("names the operation in the sentence the subject is", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "renamed",
			status: "running"
		});
		const operationId = await openOperation(t, boxId, "change_slug");

		await t.mutation(internal.boxes.operation.record.markOperationFailed, {
			boxId,
			error: "cloudflare said no",
			operationId,
			targetBoxStatus: "running"
		});

		const [alert] = await staffAlerts(t);
		expect(alert.subject).toBe("Box renamed: slug change failed");
	});

	// The alert key is per operation, so one failure raises one alert however
	// many times the recorder runs - a retried mutation must not page staff twice.
	test("raises one alert however often the same failure is recorded", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, { user_id: owner.clerkUserId });
		const operationId = await openOperation(t, boxId);

		for (let attempt = 0; attempt < 3; attempt += 1) {
			await t.mutation(internal.boxes.operation.record.markOperationFailed, {
				boxId,
				error: "boom",
				operationId,
				targetBoxStatus: "reset_failed"
			});
		}

		expect(await staffAlerts(t)).toHaveLength(1);
	});
});

describe("settling an operation", () => {
	test("closes an operation the workflow body left open", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, { user_id: owner.clerkUserId });
		const operationId = await openOperation(t, boxId);

		await t.mutation(internal.boxes.operation.record.settleOperation, {
			operationId
		});

		expect(await readOperation(t, operationId)).toMatchObject({
			status: "succeeded",
			finished_at: NOW
		});
	});

	// The safety net must never overwrite a real outcome. A failed operation that
	// got settled to "succeeded" would tell the owner their box is fine.
	test("leaves an operation that already failed as failed", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, { user_id: owner.clerkUserId });
		const operationId = await openOperation(t, boxId);
		await t.mutation(internal.boxes.operation.record.markOperationFailed, {
			boxId,
			error: "boom",
			operationId,
			targetBoxStatus: "reset_failed"
		});

		await t.mutation(internal.boxes.operation.record.settleOperation, {
			operationId
		});

		expect(await readOperation(t, operationId)).toMatchObject({
			status: "failed",
			last_error: "boom"
		});
	});
});

// The component's own terminal callback. It is the only thing that can see a
// workflow cancelled from outside, or one whose failure recording itself threw.
describe("the workflow completion callback", () => {
	test("fails an operation whose workflow was cancelled", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "resetting"
		});
		const operationId = await openOperation(t, boxId);

		await t.mutation(internal.boxes.operation.record.finishBoxOperation, {
			workflowId: "wf_1" as never,
			result: { kind: "canceled" },
			context: { boxId, operationId }
		});

		expect(await readOperation(t, operationId)).toMatchObject({
			status: "failed",
			last_error: "The operation was cancelled before it finished."
		});
		expect(await readBox(t, boxId)).toMatchObject({ status: "reset_failed" });
	});

	// Every box workflow closes its own operation on the way out, so a "success"
	// that left one open means the closing step never committed - which means we
	// do not actually know what the box did. Recording success there would assert
	// something unverified.
	test("fails an operation a successful workflow left open", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "resetting"
		});
		const operationId = await openOperation(t, boxId);

		await t.mutation(internal.boxes.operation.record.finishBoxOperation, {
			workflowId: "wf_1" as never,
			result: { kind: "success", returnValue: null },
			context: { boxId, operationId }
		});

		expect(await readOperation(t, operationId)).toMatchObject({
			status: "failed",
			last_error: "The operation stopped without recording an outcome."
		});
	});

	test("repeats the error the component reported for a failed workflow", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, { user_id: owner.clerkUserId });
		const operationId = await openOperation(t, boxId);

		await t.mutation(internal.boxes.operation.record.finishBoxOperation, {
			workflowId: "wf_1" as never,
			result: { kind: "failed", error: "out of retries" },
			context: { boxId, operationId }
		});

		expect(await readOperation(t, operationId)).toMatchObject({
			last_error: "out of retries"
		});
	});

	// The normal case: the body already recorded the outcome, so the callback has
	// nothing to do and must not overwrite it.
	test("does not touch an operation that already finished", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "running"
		});
		const operationId = await openOperation(t, boxId);
		await t.mutation(internal.boxes.operation.record.settleOperation, {
			operationId
		});

		await t.mutation(internal.boxes.operation.record.finishBoxOperation, {
			workflowId: "wf_1" as never,
			result: { kind: "failed", error: "late news" },
			context: { boxId, operationId }
		});

		const operation = await readOperation(t, operationId);
		expect(operation).toMatchObject({ status: "succeeded" });
		expect(operation?.last_error).toBeUndefined();
		expect(await readBox(t, boxId)).toMatchObject({ status: "running" });
	});
});

describe("the event an ended operation records", () => {
	// The name is derived from the operation row rather than passed in, because
	// passing it in is how five workflows came to be writing their own spellings
	// of "this ended" - `box.stopped`, `box.suspended`, `box.update_not_needed` -
	// none of which the one grammar can produce. Deriving it makes those
	// unrepresentable, and the schema's own event union now refuses them too.
	test("names the operation that ended, in the one grammar", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "stopping"
		});
		const operationId = await openOperation(t, boxId, "stop");

		await t.mutation(
			internal.boxes.operation.record.setBoxStatusWithOperationSucceeded,
			{
				boxId,
				operationId,
				status: "stopped"
			}
		);

		expect((await boxEvents(t, boxId)).map((event) => event.type)).toEqual([
			"box.stop_succeeded"
		]);
	});

	test("says an operation found nothing to do rather than that it did it", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "updating"
		});
		const operationId = await openOperation(t, boxId, "update");

		await t.mutation(
			internal.boxes.operation.record.setBoxStatusWithOperationSucceeded,
			{
				boxId,
				operationId,
				outcome: "skipped",
				status: "running"
			}
		);

		expect((await boxEvents(t, boxId)).map((event) => event.type)).toEqual([
			"box.update_skipped"
		]);
	});

	test("names the failed operation from its own row", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "repairing"
		});
		const operationId = await openOperation(t, boxId, "repair");

		await t.mutation(internal.boxes.operation.record.markOperationFailed, {
			boxId,
			error: "the host never answered",
			operationId,
			targetBoxStatus: "repair_failed"
		});

		expect((await boxEvents(t, boxId)).map((event) => event.type)).toEqual([
			"box.repair_failed"
		]);
	});
});

// The last mutation of a slug change, and the one every slug change died on.
//
// A change_slug operation writes `reserved_slug` when it starts, precisely so
// nothing else can take the name while the DNS records and the proxy reload are
// in flight. That reservation then met the rename it was protecting: `swapSlug`
// asked whether the slug was free, its own operation said no, and the mutation
// threw after every external step had already succeeded.
describe("committing a slug change", () => {
	async function openSlugChange(t: Harness, boxId: Id<"boxes">, slug: string) {
		return await t.run(
			async (ctx) =>
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: "change_slug",
					status: "running",
					idempotency_key: `change-slug:${boxId}:${slug}`,
					reserved_slug: slug,
					trigger: "owner",
					created_at: NOW,
					updated_at: NOW
				})
		);
	}

	test("takes the slug its own operation reserved", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, { user_id: owner.clerkUserId, slug: "old" });
		const operationId = await openSlugChange(t, boxId, "new");

		await t.mutation(internal.boxes.operation.record.swapSlug, {
			boxId,
			operationId,
			newSlug: "new",
			newARecordId: "a-record",
			newAaaaRecordId: "aaaa-record"
		});

		expect(await readBox(t, boxId)).toMatchObject({
			slug: "new",
			status: "running",
			dns_record_id: "a-record",
			dns_record_aaaa_id: "aaaa-record"
		});
		expect(await readOperation(t, operationId)).toMatchObject({
			status: "succeeded"
		});
	});

	// Ignoring one reservation must not ignore the rest: a slug another operation
	// is holding is still taken, and the rename has to refuse rather than land two
	// boxes on one hostname.
	test("refuses a slug a different operation has reserved", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, { user_id: owner.clerkUserId, slug: "old" });
		const otherId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "other"
		});
		const operationId = await openSlugChange(t, boxId, "new");
		await openSlugChange(t, otherId, "new");

		await expect(
			t.mutation(internal.boxes.operation.record.swapSlug, {
				boxId,
				operationId,
				newSlug: "new",
				newARecordId: "a-record",
				newAaaaRecordId: "aaaa-record"
			})
		).rejects.toThrow("Slug is unavailable.");
		expect(await readBox(t, boxId)).toMatchObject({ slug: "old" });
	});

	test("refuses a slug a live box already answers on", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, { user_id: owner.clerkUserId, slug: "old" });
		await seedBox(t, { user_id: owner.clerkUserId, slug: "new" });
		const operationId = await openSlugChange(t, boxId, "new");

		await expect(
			t.mutation(internal.boxes.operation.record.swapSlug, {
				boxId,
				operationId,
				newSlug: "new",
				newARecordId: "a-record",
				newAaaaRecordId: "aaaa-record"
			})
		).rejects.toThrow("Slug is unavailable.");
	});
});

// The end of a deletion: the tombstone, the cascade, and the one email an owner
// gets about work becoming permanently unavailable while they are not looking.
describe("recording a completed deletion", () => {
	async function deletedBox(
		t: Harness,
		seed: Partial<Doc<"boxes">> = {},
		trigger: OperationTrigger = "system:subscription_revoked"
	) {
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "deleting",
			...seed
		});
		const operationId = await t.run(
			async (ctx) =>
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: "delete",
					status: "running",
					idempotency_key: `delete:${boxId}`,
					trigger,
					created_at: NOW,
					updated_at: NOW
				})
		);
		return { boxId, operationId };
	}

	test("leaves a tombstone and closes the operation", async () => {
		const t = testConvex();
		const { boxId, operationId } = await deletedBox(t);

		await t.mutation(internal.boxes.operation.record.markDeleted, {
			boxId,
			operationId
		});

		expect(await readBox(t, boxId)).toMatchObject({
			status: "deleted",
			deleted_at: NOW
		});
		expect(await readOperation(t, operationId)).toMatchObject({
			status: "succeeded"
		});
		expect((await boxEvents(t, boxId)).map((event) => event.type)).toContain(
			"box.delete_succeeded"
		);
	});

	test("refuses to finish a deletion whose operation row is gone", async () => {
		const t = testConvex();
		const { boxId, operationId } = await deletedBox(t);
		await t.run(async (ctx) => await ctx.db.delete(operationId));

		await expect(
			t.mutation(internal.boxes.operation.record.markDeleted, {
				boxId,
				operationId
			})
		).rejects.toThrow("Operation not found.");
	});

	test("refuses to finish a deletion whose box is gone", async () => {
		const t = testConvex();
		const { boxId, operationId } = await deletedBox(t);
		await t.run(async (ctx) => await ctx.db.delete(boxId));

		await expect(
			t.mutation(internal.boxes.operation.record.markDeleted, {
				boxId,
				operationId
			})
		).rejects.toThrow("Box not found.");
	});

	// The server is already gone, which detaches the volume, so a repair that was
	// in flight leaves a pure orphan billing by the hour. It has to be removed
	// before the patch below drops the only pointer to it.
	test("removes a parking volume the deleted box still pointed at", async () => {
		const t = testConvex();
		const { boxId, operationId } = await deletedBox(t, {
			parking_volume_id: 4242,
			parking_volume_stage: "restoring"
		});

		await t.mutation(internal.boxes.operation.record.markDeleted, {
			boxId,
			operationId
		});

		expect(
			await scheduledArgs<{ volumeId: number }>(
				t,
				"boxes/infra/hetznerVps:deleteParkingVolume"
			)
		).toEqual([{ volumeId: 4242 }]);
	});

	test("schedules no volume delete for a box that had none", async () => {
		const t = testConvex();
		const { boxId, operationId } = await deletedBox(t);

		await t.mutation(internal.boxes.operation.record.markDeleted, {
			boxId,
			operationId
		});

		expect(
			await scheduledJobs(t, "boxes/infra/hetznerVps:deleteParkingVolume")
		).toEqual([]);
	});
});

// A settled operation is named from its own row, so the row has to be there.
describe("settling an operation into a terminal box status", () => {
	test("refuses to settle against an operation row that is gone", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "running"
		});
		const operationId = await openOperation(t, boxId, "stop");
		await t.run(async (ctx) => await ctx.db.delete(operationId));

		await expect(
			t.mutation(
				internal.boxes.operation.record.setBoxStatusWithOperationSucceeded,
				{
					boxId,
					operationId,
					status: "stopped"
				}
			)
		).rejects.toThrow("Operation not found.");
	});
});

// The terminal mutations: what a workflow writes to the box row when its work is
// done. Between them they are the whole of what a box's record says about
// itself, and each was reached only through a workflow no test runs - so a field
// written to the wrong column, or an operation left open, would look identical
// to success from everywhere else in this file.
describe("what a workflow records when it finishes", () => {
	async function boxWithOperation(
		t: Harness,
		type: BoxOperationType,
		seed: Partial<Doc<"boxes">> = {}
	) {
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas",
			...seed
		});
		const operationId = await openOperation(t, boxId, type);
		return { boxId, operationId, owner };
	}

	const events = async (t: Harness, boxId: Id<"boxes">) =>
		(await boxEvents(t, boxId)).map((event) => event.type);

	test("marks an operation running with the moment it started", async () => {
		const t = testConvex();
		const { operationId } = await boxWithOperation(t, "reset");

		await t.mutation(internal.boxes.operation.record.markOperationRunning, {
			operationId
		});

		expect(await readOperation(t, operationId)).toMatchObject({
			status: "running",
			started_at: NOW,
			updated_at: NOW
		});
	});

	// The addresses are what DNS is pointed at and what SSH connects to, so a box
	// that records the wrong one is unreachable in two different ways.
	test("records the server a create or a repair built", async () => {
		const t = testConvex();
		const { boxId } = await boxWithOperation(t, "create");

		await t.mutation(internal.boxes.operation.record.recordServerCreated, {
			boxId,
			serverId: 77,
			serverType: "cx23",
			location: "nbg1",
			ipv4: "1.2.3.4",
			ipv6: "2a01:4f8:c17:1::1"
		});

		expect(await readBox(t, boxId)).toMatchObject({
			hetzner_server_id: 77,
			hetzner_server_type: "cx23",
			hetzner_location: "nbg1",
			hetzner_ipv4: "1.2.3.4",
			hetzner_ipv6: "2a01:4f8:c17:1::1"
		});
		expect(await events(t, boxId)).toEqual(["server.created"]);
	});

	// A rebuild writes the same fields but is a different fact about the box, and
	// the audit history is the only place the difference survives.
	test("records a rebuild as a rebuild, not as a create", async () => {
		const t = testConvex();
		const { boxId } = await boxWithOperation(t, "repair");

		await t.mutation(internal.boxes.operation.record.recordServerRebuilt, {
			boxId,
			serverId: 77,
			serverType: "cx23",
			location: "nbg1",
			ipv4: "5.6.7.8",
			ipv6: "2a01:4f8:c17:2::1"
		});

		expect(await readBox(t, boxId)).toMatchObject({ hetzner_ipv4: "5.6.7.8" });
		expect(await events(t, boxId)).toEqual(["server.rebuilt"]);
	});

	test("records the DNS records a box answers on", async () => {
		const t = testConvex();
		const { boxId } = await boxWithOperation(t, "create");

		await t.mutation(internal.boxes.operation.record.recordDnsCreated, {
			boxId,
			aRecordId: "rec_a",
			aaaaRecordId: "rec_aaaa"
		});

		expect(await readBox(t, boxId)).toMatchObject({
			dns_record_id: "rec_a",
			dns_record_aaaa_id: "rec_aaaa"
		});
		expect(await events(t, boxId)).toEqual(["dns.record_created"]);
	});

	test("opens a box for business when its creation finishes", async () => {
		const t = testConvex();
		const { boxId, operationId } = await boxWithOperation(t, "create", {
			status: "creating"
		});

		await t.mutation(internal.boxes.operation.record.markCreateSucceeded, {
			boxId,
			operationId
		});

		expect(await readBox(t, boxId)).toMatchObject({
			status: "running",
			ready_at: NOW
		});
		expect(await readOperation(t, operationId)).toMatchObject({
			status: "succeeded"
		});
		expect(await events(t, boxId)).toEqual(["box.create_succeeded"]);
	});

	test.each([
		["repair", "markRepairSucceeded", "box.repair_succeeded"],
		["reset", "markResetSucceeded", "box.reset_succeeded"]
	] as const)(
		"brings a box back to running after a %s",
		async (type, mutation, event) => {
			const t = testConvex();
			const { boxId, operationId } = await boxWithOperation(t, type, {
				status: type === "repair" ? "repairing" : "resetting"
			});

			await t.mutation(internal.boxes.operation.record[mutation], {
				boxId,
				operationId
			});

			expect(await readBox(t, boxId)).toMatchObject({ status: "running" });
			expect(await readOperation(t, operationId)).toMatchObject({
				status: "succeeded"
			});
			expect(await events(t, boxId)).toEqual([event]);
		}
	);
});

// The one field an update advances, and the ordering that makes a failed update
// recoverable without a rollback path of its own.
describe("advancing a box to a new runtime image", () => {
	async function updatingBox(t: Harness) {
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas",
			status: "updating",
			runtime_image: "sha256:old",
			runtime_version: "1.0.0"
		});
		const operationId = await openOperation(t, boxId, "update");
		return { boxId, operationId };
	}

	test("records the image and version the box came up on", async () => {
		const t = testConvex();
		const { boxId, operationId } = await updatingBox(t);

		await t.mutation(internal.boxes.operation.record.markUpdateSucceeded, {
			boxId,
			operationId,
			runtimeImage: "sha256:new",
			runtimeVersion: "1.1.0"
		});

		expect(await readBox(t, boxId)).toMatchObject({
			status: "running",
			runtime_image: "sha256:new",
			runtime_version: "1.1.0"
		});
	});

	// The event names both ends, because "which version did this box move from"
	// is a question support gets and the row only holds the answer to one half.
	test("names both versions in the event it records", async () => {
		const t = testConvex();
		const { boxId, operationId } = await updatingBox(t);

		await t.mutation(internal.boxes.operation.record.markUpdateSucceeded, {
			boxId,
			operationId,
			runtimeImage: "sha256:new",
			runtimeVersion: "1.1.0"
		});

		expect(await boxEvents(t, boxId)).toMatchObject([
			{
				type: "box.update_succeeded",
				metadata: { from: "sha256:old", to: "sha256:new" }
			}
		]);
	});

	// An image built without a version label still moves the box. Storing the
	// null would leave the row claiming a version of "null"; the field is simply
	// absent instead.
	test("advances an image whose build carries no version label", async () => {
		const t = testConvex();
		const { boxId, operationId } = await updatingBox(t);

		await t.mutation(internal.boxes.operation.record.markUpdateSucceeded, {
			boxId,
			operationId,
			runtimeImage: "sha256:new",
			runtimeVersion: null
		});

		const box = await readBox(t, boxId);
		expect(box).toMatchObject({ runtime_image: "sha256:new" });
		expect(box).not.toHaveProperty("runtime_version");
	});

	// `setRuntimeImage` is the *other* writer, used by a rebuild that resolves the
	// channel before it boots. It moves the image without touching the box's
	// status or any operation, which is what keeps it out of the update path.
	test("sets an image during a rebuild without settling anything", async () => {
		const t = testConvex();
		const { boxId, operationId } = await updatingBox(t);

		await t.mutation(internal.boxes.operation.record.setRuntimeImage, {
			boxId,
			runtimeImage: "sha256:rebuilt",
			runtimeVersion: "2.0.0"
		});

		expect(await readBox(t, boxId)).toMatchObject({
			status: "updating",
			runtime_image: "sha256:rebuilt"
		});
		expect(await readOperation(t, operationId)).toMatchObject({
			status: "pending"
		});
	});
});

// A configuration change, and the reason its event carries keys and not values.
describe("applying a configuration change", () => {
	async function configuringBox(t: Harness) {
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas",
			runtime_config: { COMPOSERY_DISABLE_FILE_UPLOADS: "1" }
		});
		const operationId = await openOperation(t, boxId, "change_config");
		return { boxId, operationId };
	}

	test("replaces the stored configuration wholesale", async () => {
		const t = testConvex();
		const { boxId, operationId } = await configuringBox(t);

		await t.mutation(internal.boxes.operation.record.markConfigApplied, {
			boxId,
			operationId,
			config: { COMPOSERY_GITHUB_TOKEN: "ghp_secret" }
		});

		expect(await readBox(t, boxId)).toMatchObject({
			runtime_config: { COMPOSERY_GITHUB_TOKEN: "ghp_secret" }
		});
		expect(await readOperation(t, operationId)).toMatchObject({
			status: "succeeded"
		});
	});

	// The keys, never the values. A box's configuration can hold a GitHub token
	// and the event log is read by staff, so a value here is a credential handed
	// to somebody who had no reason to see it.
	test("logs which settings changed without logging what they are", async () => {
		const t = testConvex();
		const { boxId, operationId } = await configuringBox(t);

		await t.mutation(internal.boxes.operation.record.markConfigApplied, {
			boxId,
			operationId,
			config: { COMPOSERY_GITHUB_TOKEN: "ghp_secret", COMPOSERY_TZ: "UTC" }
		});

		const [event] = await boxEvents(t, boxId);
		expect(event?.metadata).toEqual({
			keys: ["COMPOSERY_GITHUB_TOKEN", "COMPOSERY_TZ"]
		});
		expect(JSON.stringify(event)).not.toContain("ghp_secret");
	});
});

// A password change, and the pending flag it clears. Until that flag is gone the
// box is still advertising that it has no password set.
describe("recording a password change", () => {
	async function passwordBox(t: Harness) {
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas",
			password_setup_pending_at: NOW - 1000
		});
		const operationId = await openOperation(t, boxId, "change_password");
		return { boxId, operationId };
	}

	test("stores the new hash and clears the pending flag", async () => {
		const t = testConvex();
		const { boxId, operationId } = await passwordBox(t);

		await t.mutation(internal.boxes.operation.record.updateRuntimeAuthHash, {
			boxId,
			operationId,
			runtimeAuthHash: "$argon2id$new"
		});

		const box = await readBox(t, boxId);
		expect(box).toMatchObject({ runtime_auth_hash: "$argon2id$new" });
		expect(box).not.toHaveProperty("password_setup_pending_at");
		expect(await readOperation(t, operationId)).toMatchObject({
			status: "succeeded"
		});
	});

	// The operation has to belong to this box. Settling somebody else's would
	// close an operation on a box that is still waiting for it.
	test("refuses an operation that belongs to a different box", async () => {
		const t = testConvex();
		const { boxId } = await passwordBox(t);
		const other = await seedBox(t, { user_id: "someone", slug: "theirs" });
		const otherOperation = await openOperation(t, other, "change_password");

		await expect(
			t.mutation(internal.boxes.operation.record.updateRuntimeAuthHash, {
				boxId,
				operationId: otherOperation,
				runtimeAuthHash: "$argon2id$new"
			})
		).rejects.toThrow("Box operation not found.");
	});
});

// The parking volume's three stages. They are the crash-safety record of a
// repair: which of them the row is in decides whether a resumed repair copies
// the box's files onto the volume or off it, so a stage written at the wrong
// moment is the difference between recovering a box and overwriting it.
describe("tracking a repair's parking volume", () => {
	async function repairingBox(t: Harness) {
		const owner = await seedUser(t);
		return await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas",
			status: "repairing"
		});
	}

	test("records the volume the instant it exists, before anything is copied", async () => {
		const t = testConvex();
		const boxId = await repairingBox(t);

		await t.mutation(internal.boxes.operation.record.recordParkingVolume, {
			boxId,
			volumeId: 909
		});

		// "parking" means the box's own server still holds the authoritative
		// files - a resumed repair reads this and copies server to volume.
		expect(await readBox(t, boxId)).toMatchObject({
			parking_volume_id: 909,
			parking_volume_stage: "parking"
		});
		expect(await boxEvents(t, boxId)).toMatchObject([
			{ type: "box.parking_volume_created", metadata: { volumeId: 909 } }
		]);
	});

	// The one-way gate. Past it the volume is authoritative and the destructive
	// rebuild is allowed; a resumed repair must never copy server to volume again.
	test("crosses to restoring once the copy has verified", async () => {
		const t = testConvex();
		const boxId = await repairingBox(t);
		await t.mutation(internal.boxes.operation.record.recordParkingVolume, {
			boxId,
			volumeId: 909
		});

		await t.mutation(internal.boxes.operation.record.markParkingRestoring, {
			boxId
		});

		expect(await readBox(t, boxId)).toMatchObject({
			parking_volume_id: 909,
			parking_volume_stage: "restoring"
		});
	});

	// The pointer goes only after the volume is actually deleted, so the field is
	// never dropped while an owner's files still live on it.
	test("clears the pointer only once the volume is gone", async () => {
		const t = testConvex();
		const boxId = await repairingBox(t);
		await t.mutation(internal.boxes.operation.record.recordParkingVolume, {
			boxId,
			volumeId: 909
		});

		await t.mutation(internal.boxes.operation.record.clearParkingVolume, {
			boxId
		});

		const box = await readBox(t, boxId);
		expect(box).not.toHaveProperty("parking_volume_id");
		expect(box).not.toHaveProperty("parking_volume_stage");
		expect((await boxEvents(t, boxId)).map((event) => event.type)).toEqual([
			"box.parking_volume_created",
			"box.parking_volume_deleted"
		]);
	});

	// All three name the box in the event they write, so none of them has a
	// tolerable reading of a box that is not there.
	test("refuses to record a volume against a box that is gone", async () => {
		const t = testConvex();
		const boxId = await repairingBox(t);
		await t.run(async (ctx) => await ctx.db.delete(boxId));

		await expect(
			t.mutation(internal.boxes.operation.record.recordParkingVolume, {
				boxId,
				volumeId: 909
			})
		).rejects.toThrow("Box not found.");
	});

	test.each(["markParkingRestoring", "clearParkingVolume"] as const)(
		"refuses %s against a box that is gone",
		async (mutation) => {
			const t = testConvex();
			const boxId = await repairingBox(t);
			await t.run(async (ctx) => await ctx.db.delete(boxId));

			await expect(
				t.mutation(internal.boxes.operation.record[mutation], { boxId })
			).rejects.toThrow("Box not found.");
		}
	);
});

// Every callback a workflow step makes on its way through an operation, driven
// against a box that is no longer there.
//
// This is one race rather than fifteen: a workflow holds a boxId across steps
// that talk to Hetzner and Cloudflare and take minutes, and a staff purge or a
// finished delete can remove the row underneath it. Each of these reads the box
// and then patches it, so without the check what an operator reads is Convex's
// own message about a document id rather than "that box is gone".
//
// A table rather than fifteen tests because there is one rule here, and
// `tests/invariants/convex/missing-box-guards.test.ts` is what stops a callback
// added later from quietly not having it.
describe("a callback whose box was deleted underneath it", () => {
	const SERVER = {
		ipv4: "1.2.3.4",
		ipv6: "2a01::1",
		location: "nbg1",
		serverId: 77,
		serverType: "cx23"
	} as const;

	// Named exactly as they are reached, so this reads as the set of callbacks
	// rather than as a set of test cases. Each names its own arguments, because
	// only the ones that close an operation take one.
	const CALLBACKS = {
		clearParkingVolume: () => ({}),
		markConfigApplied: (operationId: Id<"box_operations">) => ({
			config: { COMPOSERY_DISABLE_FILE_UPLOADS: "1" },
			operationId
		}),
		markCreateSucceeded: (operationId: Id<"box_operations">) => ({
			operationId
		}),
		markDeleted: (operationId: Id<"box_operations">) => ({ operationId }),
		markParkingRestoring: () => ({}),
		markRepairSucceeded: (operationId: Id<"box_operations">) => ({
			operationId
		}),
		markResetSucceeded: (operationId: Id<"box_operations">) => ({
			operationId
		}),
		markUpdateSucceeded: (operationId: Id<"box_operations">) => ({
			operationId,
			runtimeImage: "ghcr.io/composery/composery@sha256:next",
			runtimeVersion: "1.4.0"
		}),
		recordDnsCreated: () => ({ aRecordId: "a-1", aaaaRecordId: "aaaa-1" }),
		recordParkingVolume: () => ({ volumeId: 909 }),
		recordServerCreated: () => SERVER,
		recordServerRebuilt: () => SERVER,
		setBoxStatusWithOperationSucceeded: (
			operationId: Id<"box_operations">
		) => ({ operationId, status: "running" }),
		swapSlug: (operationId: Id<"box_operations">) => ({
			newARecordId: "a-2",
			newAaaaRecordId: "aaaa-2",
			newSlug: "renamed",
			operationId
		}),
		updateRuntimeAuthHash: (operationId: Id<"box_operations">) => ({
			operationId,
			runtimeAuthHash: "$argon2id$new"
		})
	} as const;

	test.each(Object.keys(CALLBACKS))(
		"%s refuses to record anything",
		async (name) => {
			const t = testConvex();
			const owner = await seedUser(t);
			const boxId = await seedBox(t, { user_id: owner.clerkUserId });
			const operationId = await openOperation(t, boxId, "create");
			await t.run(async (ctx) => await ctx.db.delete(boxId));

			await expect(
				t.mutation(
					internal.boxes.operation.record[name as keyof typeof CALLBACKS],
					{
						boxId,
						...CALLBACKS[name as keyof typeof CALLBACKS](operationId)
					} as never
				)
			).rejects.toThrow("Box not found.");
		}
	);
});

// What a box's history says a step did. The event is written beside the patch
// and is the only durable record of it: the row keeps the current value, so a
// box that was rebuilt onto a new server shows the change only here.
describe("the record a step leaves in the box's history", () => {
	const SERVER = {
		ipv4: "1.2.3.4",
		ipv6: "2a01:4f8::1",
		location: "fsn1",
		serverId: 4242,
		serverType: "cx43"
	} as const;

	async function box(t: Harness) {
		const owner = await seedUser(t);
		return await seedBox(t, { user_id: owner.clerkUserId });
	}

	test.each([
		["recordServerCreated", "server.created"],
		["recordServerRebuilt", "server.rebuilt"]
	] as const)("%s names the machine it recorded", async (action, type) => {
		const t = testConvex();
		const boxId = await box(t);

		await t.mutation(internal.boxes.operation.record[action], {
			boxId,
			...SERVER
		});

		expect(await boxEvents(t, boxId)).toMatchObject([
			{
				type,
				metadata: {
					serverId: 4242,
					serverType: "cx43",
					location: "fsn1",
					ipv4: "1.2.3.4",
					ipv6: "2a01:4f8::1"
				}
			}
		]);
		expect(await readBox(t, boxId)).toMatchObject({
			hetzner_server_id: 4242,
			hetzner_server_type: "cx43",
			hetzner_location: "fsn1",
			hetzner_ipv4: "1.2.3.4",
			hetzner_ipv6: "2a01:4f8::1"
		});
	});

	// Both record ids, because deleting a box means deleting both, and a record
	// whose id was never written down is one that keeps resolving to a host that
	// is gone.
	test("recordDnsCreated names both records it created", async () => {
		const t = testConvex();
		const boxId = await box(t);

		await t.mutation(internal.boxes.operation.record.recordDnsCreated, {
			boxId,
			aRecordId: "a-1",
			aaaaRecordId: "aaaa-1"
		});

		expect(await boxEvents(t, boxId)).toMatchObject([
			{
				type: "dns.record_created",
				metadata: { aRecordId: "a-1", aaaaRecordId: "aaaa-1" }
			}
		]);
		expect(await readBox(t, boxId)).toMatchObject({
			dns_record_id: "a-1",
			dns_record_aaaa_id: "aaaa-1"
		});
	});

	test("a slug change records what it was and what it became", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas"
		});
		const operationId = await openOperation(t, boxId, "change_slug");

		await t.mutation(internal.boxes.operation.record.swapSlug, {
			boxId,
			operationId,
			newARecordId: "a-2",
			newAaaaRecordId: "aaaa-2",
			newSlug: "borealis"
		});

		expect(await boxEvents(t, boxId)).toMatchObject([
			{
				type: "box.change_slug_succeeded",
				metadata: { oldSlug: "atlas", newSlug: "borealis" }
			}
		]);
		expect(await readBox(t, boxId)).toMatchObject({ slug: "borealis" });
	});

	// The keys, never the values: a box's configuration can hold anything its
	// owner typed, and the history is read by staff.
	test("a configuration change records which settings changed, in order", async () => {
		const t = testConvex();
		const boxId = await box(t);
		const operationId = await openOperation(t, boxId, "change_config");

		await t.mutation(internal.boxes.operation.record.markConfigApplied, {
			boxId,
			operationId,
			config: {
				COMPOSERY_DISABLE_WORKSPACE_TRUST: "1",
				COMPOSERY_DISABLE_FILE_UPLOADS: "1"
			}
		});

		const [event] = await boxEvents(t, boxId);
		expect(event).toMatchObject({ type: "box.change_config_succeeded" });
		expect(event?.metadata).toMatchObject({
			keys: [
				"COMPOSERY_DISABLE_FILE_UPLOADS",
				"COMPOSERY_DISABLE_WORKSPACE_TRUST"
			]
		});
		expect(JSON.stringify(event?.metadata)).not.toContain("COMPOSERY_PASSWORD");
	});

	test("a password change records that one happened", async () => {
		const t = testConvex();
		const boxId = await box(t);
		const operationId = await openOperation(t, boxId, "change_password");

		await t.mutation(internal.boxes.operation.record.updateRuntimeAuthHash, {
			boxId,
			operationId,
			runtimeAuthHash: "$argon2id$new"
		});

		expect(await boxEvents(t, boxId)).toMatchObject([
			{ type: "box.change_password_succeeded" }
		]);
		// Never the hash itself: the history is a list an operator reads.
		expect(JSON.stringify(await boxEvents(t, boxId))).not.toContain("argon2id");
		expect(await readBox(t, boxId)).toMatchObject({
			runtime_auth_hash: "$argon2id$new"
		});
	});

	test("restoring a box's parked files says so", async () => {
		const t = testConvex();
		const boxId = await box(t);

		await t.mutation(internal.boxes.operation.record.markParkingRestoring, {
			boxId
		});

		expect(await boxEvents(t, boxId)).toMatchObject([
			{ type: "box.parking_volume_restoring" }
		]);
	});
});

// The image a box is recorded as running, which is what every update decision
// compares against.
describe("recording the image a box runs", () => {
	test("records the digest and the label beside it", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, { user_id: owner.clerkUserId });

		await t.mutation(internal.boxes.operation.record.setRuntimeImage, {
			boxId,
			runtimeImage: "ghcr.io/composery/composery@sha256:next",
			runtimeVersion: "1.4.0"
		});

		expect(await readBox(t, boxId)).toMatchObject({
			runtime_image: "ghcr.io/composery/composery@sha256:next",
			runtime_version: "1.4.0"
		});
	});

	// A digest whose label could not be read is still the digest to record, and
	// the label has to be cleared rather than left showing the previous build's.
	test("clears a label that could not be read this time", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			runtime_version: "1.3.0"
		});

		await t.mutation(internal.boxes.operation.record.setRuntimeImage, {
			boxId,
			runtimeImage: "ghcr.io/composery/composery@sha256:next",
			runtimeVersion: null
		});

		expect(await readBox(t, boxId)).not.toHaveProperty("runtime_version");
	});
});

// The sweep that closes an operation a workflow left open. It is the last
// guarantee that a finished workflow leaves no active operation, because an
// active one blocks every later action on the box.
describe("settling an operation a workflow left open", () => {
	async function operationWith(
		t: Harness,
		status: Doc<"box_operations">["status"]
	) {
		const owner = await seedUser(t);
		const boxId = await seedBox(t, { user_id: owner.clerkUserId });
		const operationId = await openOperation(t, boxId, "start");
		await t.run(async (ctx) => await ctx.db.patch(operationId, { status }));
		return operationId;
	}

	test.each(["pending", "running"] as const)(
		"closes an operation still %s",
		async (status) => {
			const t = testConvex();
			const operationId = await operationWith(t, status);

			await t.mutation(internal.boxes.operation.record.settleOperation, {
				operationId
			});

			expect(await readOperation(t, operationId)).toMatchObject({
				status: "succeeded",
				finished_at: NOW
			});
		}
	);

	// An operation that already ended keeps how it ended. Overwriting a failure
	// with a success here would erase the only record of what went wrong.
	test.each(["failed", "succeeded"] as const)(
		"leaves an operation that already %s alone",
		async (status) => {
			const t = testConvex();
			const operationId = await operationWith(t, status);

			await t.mutation(internal.boxes.operation.record.settleOperation, {
				operationId
			});

			expect(await readOperation(t, operationId)).toMatchObject({ status });
		}
	);

	// The component calls this on every terminal outcome, including for
	// operations whose rows a purge already removed.
	test("says nothing about an operation that is gone", async () => {
		const t = testConvex();
		const operationId = await operationWith(t, "running");
		await t.run(async (ctx) => await ctx.db.delete(operationId));

		await expect(
			t.mutation(internal.boxes.operation.record.settleOperation, {
				operationId
			})
		).resolves.not.toThrow();
	});
});

// The mutation every lifecycle workflow ends at: it settles the box, settles the
// operation, and names the event from the operation row rather than from the
// caller. Stop, start, suspend, unsuspend and a settled update all arrive here.
describe("settling a box and its operation together", () => {
	// A sender has to be configured or `sendOwnerNotice` returns before doing
	// anything, and every announcement here would silently pass.
	beforeEach(() => {
		vi.stubEnv(
			"RESEND_NOTICES_FROM",
			"Composery Notices <notices@composery.test>"
		);
		vi.stubEnv("RESEND_API_KEY", "re_test");
	});

	async function ready(
		t: Harness,
		type: BoxOperationType,
		metadata?: Record<string, unknown>
	) {
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "running"
		});
		const operationId = await openOperation(t, boxId, type, metadata);
		return { boxId, operationId, owner };
	}

	const settle = (
		t: Harness,
		boxId: Id<"boxes">,
		operationId: Id<"box_operations">,
		args: object = {}
	) =>
		t.mutation(
			internal.boxes.operation.record.setBoxStatusWithOperationSucceeded,
			{
				boxId,
				operationId,
				status: "stopped",
				...args
			}
		);

	test("leaves the box at the status it was told and the operation closed", async () => {
		const t = testConvex();
		const { boxId, operationId } = await ready(t, "stop");

		await settle(t, boxId, operationId);

		expect(await readBox(t, boxId)).toMatchObject({
			status: "stopped",
			updated_at: NOW
		});
		expect(await readOperation(t, operationId)).toMatchObject({
			status: "succeeded",
			finished_at: NOW
		});
	});

	// The event is named from the operation, so one caller cannot record a stop
	// as a start by passing the wrong word.
	test.each([
		["stop", "stopped", "box.stop_succeeded"],
		["start", "running", "box.start_succeeded"]
	] as const)("names a %s from its operation", async (type, status, event) => {
		const t = testConvex();
		const { boxId, operationId } = await ready(t, type);

		await settle(t, boxId, operationId, { status });

		expect(await boxEvents(t, boxId)).toMatchObject([{ type: event }]);
	});

	// The outcome may be stated rather than left to the default, and both
	// spellings have to be accepted: a caller that names the one the default
	// already means must not be rejected by the validator.
	test("accepts an outcome the caller stated outright", async () => {
		const t = testConvex();
		const { boxId, operationId } = await ready(t, "stop");

		await settle(t, boxId, operationId, { outcome: "succeeded" });

		expect(await boxEvents(t, boxId)).toMatchObject([
			{ type: "box.stop_succeeded" }
		]);
	});

	// An operation that found nothing to do still closes, and says so - a box
	// already stopped records a skip rather than a stop that never happened.
	test("records an operation that found nothing to do as skipped", async () => {
		const t = testConvex();
		const { boxId, operationId } = await ready(t, "stop");

		await settle(t, boxId, operationId, { outcome: "skipped" });

		expect(await boxEvents(t, boxId)).toMatchObject([
			{ type: "box.stop_skipped" }
		]);
	});

	test("refuses to settle against an operation that is gone", async () => {
		const t = testConvex();
		const { boxId, operationId } = await ready(t, "stop");
		await t.run(async (ctx) => await ctx.db.delete(operationId));

		await expect(settle(t, boxId, operationId)).rejects.toThrow(
			"Operation not found."
		);
	});

	// Suspension happens to an owner without them asking and cannot be undone
	// from their own page, so it is the one ending here that mails them.
	test("tells the owner their box was suspended, and why", async () => {
		const t = testConvex();
		const { boxId, operationId } = await ready(t, "suspend", {
			reason: "unpaid"
		});

		await settle(t, boxId, operationId, { status: "suspended" });

		expect(await sentOwnerEmails(t, boxId)).toMatchObject([
			{ notice: "suspended" }
		]);
	});

	test("tells the owner their box came back", async () => {
		const t = testConvex();
		const { boxId, operationId } = await ready(t, "unsuspend");

		await settle(t, boxId, operationId, { status: "running" });

		expect(await sentOwnerEmails(t, boxId)).toMatchObject([
			{ notice: "unsuspended" }
		]);
	});

	// The owner's own actions finish while they are watching, so they mail
	// nobody. Announcing them would train people to ignore the address the
	// suspension notice arrives at.
	test.each([
		["stop", "stopped"],
		["start", "running"],
		["update", "running"]
	] as const)("says nothing to the owner about a %s", async (type, status) => {
		const t = testConvex();
		const { boxId, operationId } = await ready(t, type);

		await settle(t, boxId, operationId, { status });

		expect(await sentOwnerEmails(t, boxId)).toEqual([]);
	});

	// This mutation also carries the transient statuses, so the announcement is
	// gated on where the box actually landed - a suspension that is still under
	// way has not happened yet.
	// The gate is the operation's type, not the status it settled at. A caller
	// that parked some other operation's box at `suspended` must not make this
	// announce a suspension nobody ordered.
	test("says nothing about a box some other operation left suspended", async () => {
		const t = testConvex();
		const { boxId, operationId } = await ready(t, "stop");

		await settle(t, boxId, operationId, { status: "suspended" });

		expect(await sentOwnerEmails(t, boxId)).toEqual([]);
	});

	test("says nothing while a suspension is still under way", async () => {
		const t = testConvex();
		const { boxId, operationId } = await ready(t, "suspend", {
			reason: "unpaid"
		});

		await settle(t, boxId, operationId, { status: "suspending" });

		expect(await sentOwnerEmails(t, boxId)).toEqual([]);
	});

	test("says nothing while an unsuspension is still under way", async () => {
		const t = testConvex();
		const { boxId, operationId } = await ready(t, "unsuspend");

		await settle(t, boxId, operationId, { status: "unsuspending" });

		expect(await sentOwnerEmails(t, boxId)).toEqual([]);
	});
});

// A finished update leaves the box running the image it moved to, and closes the
// operation that carried it.
describe("finishing an update", () => {
	test("records the move and closes the operation", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "updating",
			runtime_image: "ghcr.io/composery/composery@sha256:old"
		});
		const operationId = await openOperation(t, boxId, "update");

		await t.mutation(internal.boxes.operation.record.markUpdateSucceeded, {
			boxId,
			operationId,
			runtimeImage: "ghcr.io/composery/composery@sha256:new",
			runtimeVersion: "1.4.0"
		});

		expect(await readBox(t, boxId)).toMatchObject({
			status: "running",
			runtime_image: "ghcr.io/composery/composery@sha256:new",
			runtime_version: "1.4.0"
		});
		expect(await readOperation(t, operationId)).toMatchObject({
			status: "succeeded",
			finished_at: NOW
		});
		expect(await boxEvents(t, boxId)).toMatchObject([
			{
				type: "box.update_succeeded",
				metadata: {
					from: "ghcr.io/composery/composery@sha256:old",
					to: "ghcr.io/composery/composery@sha256:new"
				}
			}
		]);
	});
});

// What a completed delete hands on. The box row survives as a tombstone, and
// four sweeps are queued to take its history and its billing records apart on
// their own schedules - none of which happens if one of them is queued without
// the box it is for.
describe("what a completed delete hands on", () => {
	async function deleted(t: Harness) {
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			status: "deleting"
		});
		const operationId = await openOperation(t, boxId, "delete");
		await t.mutation(internal.boxes.operation.record.markDeleted, {
			boxId,
			operationId
		});
		return boxId;
	}

	test.each(["deleteRuntimeData", "sanitizeOperations", "sanitizeEvents"])(
		"queues %s for the box that was deleted",
		async (step) => {
			const t = testConvex();
			const boxId = await deleted(t);

			expect(await scheduledArgs(t, `boxes/cleanup:${step}`)).toEqual([
				{ boxId }
			]);
		}
	);

	// The retention window is measured from when the delete finished, so the
	// date travels with the job rather than being read again later.
	test("queues the checkout retention with the date it finished", async () => {
		const t = testConvex();
		const boxId = await deleted(t);

		expect(
			await scheduledArgs(t, "boxes/cleanup:startCheckoutRetention")
		).toEqual([{ boxId, deletedAt: NOW }]);
	});
});
