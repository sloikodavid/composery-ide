import { vResultValidator, vWorkflowId } from "@convex-dev/workflow";
import { ConvexError, v } from "convex/values";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../../_generated/server";
import { vBoxFailureStatus, vServerLocation, vServerType } from "../../schema";
import {
	type BoxFailureStatus,
	boxEventType,
	operationLabel,
	isActiveOperationStatus,
	BOX_OPERATIONS
} from "../../model/box/operation";
import { staffConsoleUrl } from "../../env";
import { raiseAlert } from "../../staff/alerts";
import { sendOwnerNotice } from "../../notice/owner";
import { consoleBoxPath } from "../../model/box/path";
import { appendBoxEvent } from "./event";
import { reconcileCapacityAlert } from "../capacity";
import { deletedBoxDataPatch, suspensionReason } from "../retention";
import { assertSlugAvailable } from "../slugAvailability";

export const markOperationRunning = internalMutation({
	args: {
		operationId: v.id("box_operations")
	},
	handler: async (ctx, args) => {
		const timestamp = Date.now();
		await ctx.db.patch(args.operationId, {
			status: "running",
			started_at: timestamp,
			updated_at: timestamp
		});
	}
});

export const recordServerCreated = internalMutation({
	args: {
		boxId: v.id("boxes"),
		ipv4: v.string(),
		ipv6: v.string(),
		location: vServerLocation,
		serverId: v.number(),
		serverType: vServerType
	},
	handler: async (ctx, args) => {
		const box = await ctx.db.get(args.boxId);
		if (!box) throw new ConvexError("Box not found.");

		await ctx.db.patch(args.boxId, {
			hetzner_server_id: args.serverId,
			hetzner_server_type: args.serverType,
			hetzner_location: args.location,
			hetzner_ipv4: args.ipv4,
			hetzner_ipv6: args.ipv6,
			updated_at: Date.now()
		});

		await appendBoxEvent(ctx, box, "server.created", {
			metadata: {
				serverId: args.serverId,
				serverType: args.serverType,
				location: args.location,
				ipv4: args.ipv4,
				ipv6: args.ipv6
			}
		});
	}
});

export const recordServerRebuilt = internalMutation({
	args: {
		boxId: v.id("boxes"),
		ipv4: v.string(),
		ipv6: v.string(),
		location: vServerLocation,
		serverId: v.number(),
		serverType: vServerType
	},
	handler: async (ctx, args) => {
		const box = await ctx.db.get(args.boxId);
		if (!box) throw new ConvexError("Box not found.");

		await ctx.db.patch(args.boxId, {
			hetzner_server_id: args.serverId,
			hetzner_server_type: args.serverType,
			hetzner_location: args.location,
			hetzner_ipv4: args.ipv4,
			hetzner_ipv6: args.ipv6,
			updated_at: Date.now()
		});

		await appendBoxEvent(ctx, box, "server.rebuilt", {
			metadata: {
				serverId: args.serverId,
				serverType: args.serverType,
				location: args.location,
				ipv4: args.ipv4,
				ipv6: args.ipv6
			}
		});
	}
});

// Written only after `checkCustomDomain` observed the name resolving to this box.
// Null clears it, which is what takes the name back out of the Caddyfile.
export const setCustomDomain = internalMutation({
	args: { boxId: v.id("boxes"), domain: v.union(v.string(), v.null()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		await ctx.db.patch(args.boxId, {
			custom_domain: args.domain ?? undefined,
			updated_at: Date.now()
		});
		return null;
	}
});

export const setRuntimeImage = internalMutation({
	args: {
		boxId: v.id("boxes"),
		runtimeImage: v.string(),
		runtimeVersion: v.optional(v.union(v.string(), v.null()))
	},
	handler: async (ctx, args) => {
		await ctx.db.patch(args.boxId, {
			runtime_image: args.runtimeImage,
			runtime_version: args.runtimeVersion ?? undefined,
			updated_at: Date.now()
		});
	}
});

export const recordDnsCreated = internalMutation({
	args: {
		aRecordId: v.string(),
		aaaaRecordId: v.string(),
		boxId: v.id("boxes")
	},
	handler: async (ctx, args) => {
		const box = await ctx.db.get(args.boxId);
		if (!box) throw new ConvexError("Box not found.");

		await ctx.db.patch(args.boxId, {
			dns_record_id: args.aRecordId,
			dns_record_aaaa_id: args.aaaaRecordId,
			updated_at: Date.now()
		});

		await appendBoxEvent(ctx, box, "dns.record_created", {
			metadata: {
				aRecordId: args.aRecordId,
				aaaaRecordId: args.aaaaRecordId
			}
		});
	}
});

export const markCreateSucceeded = internalMutation({
	args: {
		boxId: v.id("boxes"),
		operationId: v.id("box_operations")
	},
	handler: async (ctx, args) => {
		const box = await ctx.db.get(args.boxId);
		if (!box) throw new ConvexError("Box not found.");

		const timestamp = Date.now();
		await ctx.db.patch(args.boxId, {
			status: "running",
			ready_at: timestamp,
			updated_at: timestamp
		});
		await ctx.db.patch(args.operationId, {
			status: "succeeded",
			finished_at: timestamp,
			updated_at: timestamp
		});
		await appendBoxEvent(ctx, box, boxEventType("create", "succeeded"));
	}
});

// Safety net for the operation lock: every workflow body is expected to close
// its own operation (and set the terminal box status) in a final mutation. If
// one returns without doing so, this closes the still-active operation so a
// forgotten terminal mutation can never brick the box. A no-op when the body
// already settled the operation.
export const settleOperation = internalMutation({
	args: { operationId: v.id("box_operations") },
	handler: async (ctx, args) => {
		const operation = await ctx.db.get(args.operationId);
		if (!operation) return;
		if (operation.status !== "pending" && operation.status !== "running") {
			return;
		}
		const timestamp = Date.now();
		await ctx.db.patch(args.operationId, {
			status: "succeeded",
			finished_at: timestamp,
			updated_at: timestamp
		});
	}
});

// The workflow component calls this on every terminal outcome of every box
// workflow - success, failure, or cancellation.
//
// Normally it finds nothing to do: the workflow body closed its own operation, or
// `defineBoxWorkflow`'s catch already recorded the failure. It exists for the
// outcomes that catch cannot see, and each one used to leave the box unusable
// forever because an active operation blocks every later action on it:
//
//   * the workflow was cancelled from outside, so no user code ran at all;
//   * the workflow failed in a way that never reached the catch (a step throwing
//     during the catch's own mutation, an out-of-retries workpool failure);
//   * the catch ran but its own recording mutation failed - which is why
//     `recordOperationFailure` no longer throws on a missing box.
//
// So this is the one place that can promise the invariant "a finished workflow
// leaves no active operation", and it is the component, not our code, that
// promises to call it.
export const finishBoxOperation = internalMutation({
	args: {
		workflowId: vWorkflowId,
		result: vResultValidator,
		context: v.object({
			boxId: v.id("boxes"),
			operationId: v.id("box_operations")
		})
	},
	handler: async (ctx, args) => {
		const operation = await ctx.db.get(args.context.operationId);
		if (!operation || !isActiveOperationStatus(operation.status)) return;

		// Reached only when the body left the operation open, which means it did not
		// get to record an outcome either. Say what the component told us rather than
		// inventing a reason.
		//
		// Note the "success" case is still recorded as a failure. Every box workflow
		// ends by settling its own operation, so a success that left one open means
		// that final step did not commit and we do not actually know what state the
		// box is in. Closing it as succeeded would assert something unverified; a
		// visible failure the owner can retry from is the honest reading, and it is
		// the difference between a box someone fixes and a box that silently lies
		// about having worked.
		const error =
			args.result.kind === "failed"
				? args.result.error
				: args.result.kind === "canceled"
					? "The operation was cancelled before it finished."
					: "The operation stopped without recording an outcome.";

		await recordOperationFailure(ctx, {
			boxId: args.context.boxId,
			error,
			operationId: args.context.operationId,
			targetBoxStatus: BOX_OPERATIONS[operation.type].onFailure ?? undefined
		});
	}
});

// Record a failed operation: put the box into the status that failure leaves it
// in, close the operation with its error, log the event, and alert staff.
//
// Deliberately tolerant of a missing box. It used to throw `Box not found`, which
// meant a box deleted while one of its operations was in flight left that
// operation active forever - and an active operation blocks every later action on
// the box. Closing the operation is the part that must always happen; the event
// and the alert need a box to hang off and are skipped without one.
export async function recordOperationFailure(
	ctx: MutationCtx,
	input: {
		boxId: Id<"boxes">;
		error: string;
		operationId: Id<"box_operations">;
		targetBoxStatus?: BoxFailureStatus;
	}
) {
	const box = await ctx.db.get(input.boxId);
	const operation = await ctx.db.get(input.operationId);
	// Closing the operation is the part that must always happen, so there is no
	// tolerant reading of a row that is not there: the patch below throws on one
	// regardless. Saying so here is what keeps every line after it from carrying a
	// `null` branch nothing can reach - the shape that had the alert's severity
	// deciding what to do about an operation whose type it could not know.
	if (!operation) throw new ConvexError("Box operation not found.");
	const timestamp = Date.now();

	if (box && input.targetBoxStatus) {
		await ctx.db.patch(input.boxId, {
			status: input.targetBoxStatus,
			updated_at: timestamp
		});
	}

	await ctx.db.patch(input.operationId, {
		status: "failed",
		finished_at: timestamp,
		last_error: input.error,
		updated_at: timestamp
	});
	if (!box) return;

	// Named from the operation row rather than from an argument. Passing the name
	// in as a string is how five workflows once came to write their own spellings
	// of "this failed"; deriving it from the row that already knows the operation
	// type is what makes that unrepresentable.
	await appendBoxEvent(ctx, box, boxEventType(operation.type, "failed"), {
		message: input.error
	});

	const operationType = operationLabel(operation.type, true);
	await raiseAlert(ctx, {
		key: `box-operation-failed:${input.operationId}`,
		severity: BOX_OPERATIONS[operation.type].critical ? "critical" : "warning",
		subject: `Box ${box.slug}: ${operationType} failed`,
		text: `${operationType} failed for box ${box.slug} (${box._id}).\n\n${input.error}\n\nReview the operation: ${staffConsoleUrl(consoleBoxPath(box._id))}`
	});

	// Create is the only failure the owner is mailed about, and the reason is who
	// is left holding it. Every other failed operation was started by someone
	// watching a dialog for its outcome, and leaves a box that still exists; a
	// create that fails leaves a paid checkout with nothing to show for it, and
	// the person who paid may have closed the tab minutes ago. A failed delete is
	// deliberately silent too: the owner never asked for it, `finishFailedDeletions`
	// is already retrying, and there is nothing for them to do but worry.
	//
	// The error itself is not forwarded. It is written for staff and carries host
	// names, provider messages and addresses; the owner is told the outcome and
	// that a person already knows.
	if (operation.type === "create") {
		await sendOwnerNotice(ctx, box, { type: "create_failed" });
	}
}

export const markOperationFailed = internalMutation({
	args: {
		boxId: v.id("boxes"),
		error: v.string(),
		operationId: v.id("box_operations"),
		targetBoxStatus: v.optional(vBoxFailureStatus)
	},
	handler: async (ctx, args) => {
		await recordOperationFailure(ctx, args);
	}
});

export const updateRuntimeAuthHash = internalMutation({
	args: {
		boxId: v.id("boxes"),
		operationId: v.id("box_operations"),
		runtimeAuthHash: v.string()
	},
	handler: async (ctx, args) => {
		const box = await ctx.db.get(args.boxId);
		if (!box) throw new ConvexError("Box not found.");
		const operation = await ctx.db.get(args.operationId);
		if (!operation || operation.box_id !== box._id) {
			throw new ConvexError("Box operation not found.");
		}

		const timestamp = Date.now();
		await ctx.db.patch(args.boxId, {
			runtime_auth_hash: args.runtimeAuthHash,
			password_setup_pending_at: undefined,
			updated_at: timestamp
		});
		await ctx.db.patch(args.operationId, {
			status: "succeeded",
			finished_at: timestamp,
			updated_at: timestamp
		});
		await appendBoxEvent(
			ctx,
			box,
			boxEventType("change_password", "succeeded")
		);
	}
});

export const swapSlug = internalMutation({
	args: {
		boxId: v.id("boxes"),
		newARecordId: v.string(),
		newAaaaRecordId: v.string(),
		newSlug: v.string(),
		operationId: v.id("box_operations")
	},
	handler: async (ctx, args) => {
		const box = await ctx.db.get(args.boxId);
		if (!box) throw new ConvexError("Box not found.");
		// Naming this operation as well as the box: it is the row that reserved the
		// slug in the first place, so without it the rename is refused by its own
		// reservation.
		await assertSlugAvailable(ctx, args.newSlug, {
			boxId: args.boxId,
			operationId: args.operationId
		});

		const oldSlug = box.slug;
		const timestamp = Date.now();
		await ctx.db.patch(args.boxId, {
			slug: args.newSlug,
			dns_record_id: args.newARecordId,
			dns_record_aaaa_id: args.newAaaaRecordId,
			status: "running",
			updated_at: timestamp
		});
		await ctx.db.patch(args.operationId, {
			status: "succeeded",
			finished_at: timestamp,
			updated_at: timestamp
		});
		await appendBoxEvent(ctx, box, boxEventType("change_slug", "succeeded"), {
			metadata: {
				oldSlug,
				newSlug: args.newSlug,
				newARecordId: args.newARecordId,
				newAaaaRecordId: args.newAaaaRecordId
			}
		});
	}
});

// A repair ends where reset does - a healthy "running" box - so this only clears
// the transient `repairing` status and settles the operation the Repair dialog
// reads for the outcome.
export const markRepairSucceeded = internalMutation({
	args: {
		boxId: v.id("boxes"),
		operationId: v.id("box_operations")
	},
	handler: async (ctx, args) => {
		const box = await ctx.db.get(args.boxId);
		if (!box) throw new ConvexError("Box not found.");

		const timestamp = Date.now();
		await ctx.db.patch(args.boxId, {
			status: "running",
			updated_at: timestamp
		});
		await ctx.db.patch(args.operationId, {
			status: "succeeded",
			finished_at: timestamp,
			updated_at: timestamp
		});
		await appendBoxEvent(ctx, box, boxEventType("repair", "succeeded"));
	}
});

// The end of an update, and the only place `runtime_image` advances for one.
//
// Advancing the row is deliberately the *last* thing that happens, in the same
// transaction that settles the operation: until the new image has pulled,
// recreated the container, and answered as a serving editor, the row keeps
// naming the image that last worked. That is what makes a failed update
// recoverable without a dedicated rollback path - Repair renders the compose
// file from this field, so repairing a box whose update died puts the old image
// back. Writing the digest earlier (when the workflow resolves it, or before the
// SSH step) would make Repair reinstall the image that just broke the box, and
// would turn an automatic repair into a loop that reapplies the failure.
export const markUpdateSucceeded = internalMutation({
	args: {
		boxId: v.id("boxes"),
		operationId: v.id("box_operations"),
		runtimeImage: v.string(),
		runtimeVersion: v.union(v.string(), v.null())
	},
	handler: async (ctx, args) => {
		const box = await ctx.db.get(args.boxId);
		if (!box) throw new ConvexError("Box not found.");

		const timestamp = Date.now();
		await ctx.db.patch(args.boxId, {
			status: "running",
			runtime_image: args.runtimeImage,
			runtime_version: args.runtimeVersion ?? undefined,
			updated_at: timestamp
		});
		await ctx.db.patch(args.operationId, {
			status: "succeeded",
			finished_at: timestamp,
			updated_at: timestamp
		});
		await appendBoxEvent(ctx, box, boxEventType("update", "succeeded"), {
			metadata: { from: box.runtime_image, to: args.runtimeImage }
		});
	}
});

// The end of a configuration change, and the only place `runtime_config`
// advances. Written last, after the editor has answered on the new environment,
// for the same reason `markUpdateSucceeded` holds back the image digest: the row
// is what every later env-file render reads, so it must only ever hold a
// configuration the box has actually booted with.
export const markConfigApplied = internalMutation({
	args: {
		boxId: v.id("boxes"),
		config: v.record(v.string(), v.string()),
		operationId: v.id("box_operations")
	},
	handler: async (ctx, args) => {
		const box = await ctx.db.get(args.boxId);
		if (!box) throw new ConvexError("Box not found.");

		const timestamp = Date.now();
		await ctx.db.patch(args.boxId, {
			runtime_config: args.config,
			updated_at: timestamp
		});
		await ctx.db.patch(args.operationId, {
			status: "succeeded",
			finished_at: timestamp,
			updated_at: timestamp
		});
		// The keys, never the values: a box's configuration can hold a GitHub token
		// and an event log is read by staff.
		await appendBoxEvent(ctx, box, boxEventType("change_config", "succeeded"), {
			// Sorted so the history reads the same however the keys arrived.
			// Stryker disable next-line MethodExpression: Convex already returns a record's fields in key order, so no test here can see the difference - the sort is what keeps that true if it ever stops being.
			metadata: { keys: Object.keys(args.config).sort() }
		});
	}
});

export const markResetSucceeded = internalMutation({
	args: {
		boxId: v.id("boxes"),
		operationId: v.id("box_operations")
	},
	handler: async (ctx, args) => {
		const box = await ctx.db.get(args.boxId);
		if (!box) throw new ConvexError("Box not found.");

		const timestamp = Date.now();
		await ctx.db.patch(args.boxId, {
			status: "running",
			updated_at: timestamp
		});
		await ctx.db.patch(args.operationId, {
			status: "succeeded",
			finished_at: timestamp,
			updated_at: timestamp
		});
		await appendBoxEvent(ctx, box, boxEventType("reset", "succeeded"));
	}
});

// Persist the parking volume the instant Hetzner creates it, before anything is
// copied to it. Stage starts at "parking" (the box's server still holds the
// authoritative files). A repair that dies after this can be retried and will
// find the volume instead of orphaning it.
export const recordParkingVolume = internalMutation({
	args: {
		boxId: v.id("boxes"),
		volumeId: v.number()
	},
	handler: async (ctx, args) => {
		const box = await ctx.db.get(args.boxId);
		if (!box) throw new ConvexError("Box not found.");

		await ctx.db.patch(args.boxId, {
			parking_volume_id: args.volumeId,
			parking_volume_stage: "parking",
			updated_at: Date.now()
		});
		await appendBoxEvent(ctx, box, "box.parking_volume_created", {
			metadata: { volumeId: args.volumeId }
		});
	}
});

// The one-way gate of a repair: only after the copy onto the parking volume has
// verified does the box cross into "restoring", where the volume becomes the
// authoritative copy and the destructive server rebuild is allowed to run. A
// resumed repair reads this to know it must never copy server -> volume again.
export const markParkingRestoring = internalMutation({
	args: {
		boxId: v.id("boxes")
	},
	handler: async (ctx, args) => {
		const box = await ctx.db.get(args.boxId);
		if (!box) throw new ConvexError("Box not found.");

		await ctx.db.patch(args.boxId, {
			parking_volume_stage: "restoring",
			updated_at: Date.now()
		});
		await appendBoxEvent(ctx, box, "box.parking_volume_restoring");
	}
});

// Clear the pointer only after the volume is actually deleted, so the field is
// never dropped while data still lives on a volume. Called after copy-back has
// verified and the Hetzner Volume has been removed.
export const clearParkingVolume = internalMutation({
	args: {
		boxId: v.id("boxes")
	},
	handler: async (ctx, args) => {
		const box = await ctx.db.get(args.boxId);
		if (!box) throw new ConvexError("Box not found.");

		await ctx.db.patch(args.boxId, {
			parking_volume_id: undefined,
			parking_volume_stage: undefined,
			updated_at: Date.now()
		});
		await appendBoxEvent(ctx, box, "box.parking_volume_deleted");
	}
});

export const markDeleted = internalMutation({
	args: {
		boxId: v.id("boxes"),
		operationId: v.id("box_operations")
	},
	handler: async (ctx, args) => {
		const box = await ctx.db.get(args.boxId);
		if (!box) throw new ConvexError("Box not found.");
		const operation = await ctx.db.get(args.operationId);
		// The patch below would throw on a missing operation anyway. Saying so
		// here is what keeps the event from being the thing that quietly drops:
		// the row is what names it, so no row means no name.
		if (!operation) throw new ConvexError("Operation not found.");

		const timestamp = Date.now();
		// deleteRuntime already removed the server, which detaches any attached
		// volume, so the parking volume (if a repair was mid-flight) is now a pure
		// orphan. Remove it before the patch below drops the pointer; reconciliation
		// is the backstop if this best-effort delete does not land.
		const parkingVolumeId = box.parking_volume_id;
		await ctx.db.patch(args.boxId, {
			...deletedBoxDataPatch(timestamp),
			updated_at: timestamp
		});
		await ctx.db.patch(args.operationId, {
			status: "succeeded",
			finished_at: timestamp,
			updated_at: timestamp
		});
		await appendBoxEvent(ctx, box, boxEventType("delete", "succeeded"));
		// Nothing else will ever tell them. A deletion is only ever ordered by a
		// subscription ending, an account being deleted, or staff revoking a comp -
		// never by the owner pressing a button and watching it finish - so this is
		// the point at which someone's work becomes permanently unavailable while
		// they are not looking at us. The trigger says which of the three it was.
		await sendOwnerNotice(ctx, box, {
			type: "deleted",
			trigger: operation.trigger
		});
		await ctx.scheduler.runAfter(0, internal.boxes.cleanup.deleteRuntimeData, {
			boxId: box._id
		});
		await ctx.scheduler.runAfter(0, internal.boxes.cleanup.sanitizeOperations, {
			boxId: box._id
		});
		await ctx.scheduler.runAfter(0, internal.boxes.cleanup.sanitizeEvents, {
			boxId: box._id
		});
		await ctx.scheduler.runAfter(
			0,
			internal.boxes.cleanup.startCheckoutRetention,
			{
				boxId: box._id,
				deletedAt: timestamp
			}
		);

		// Snapshot images survive server deletion, so drop them now rather than
		// letting them linger and bill.
		await ctx.runMutation(internal.boxes.snapshots.cascadeDeleteBoxSnapshots, {
			boxId: box._id
		});
		if (parkingVolumeId !== undefined) {
			await ctx.scheduler.runAfter(
				0,
				internal.boxes.infra.hetznerVps.deleteParkingVolume,
				{ volumeId: parkingVolumeId }
			);
		}
		await reconcileCapacityAlert(ctx);
	}
});

export const setBoxStatusWithOperationSucceeded = internalMutation({
	args: {
		boxId: v.id("boxes"),
		operationId: v.id("box_operations"),
		// The event this records is named from the operation row below, so the
		// only thing a caller still chooses is whether the operation did the work
		// or found there was none to do.
		outcome: v.optional(v.union(v.literal("succeeded"), v.literal("skipped"))),
		status: v.union(
			v.literal("running"),
			v.literal("stopped"),
			v.literal("suspended"),
			v.literal("suspending"),
			v.literal("unsuspending")
		)
	},
	handler: async (ctx, args) => {
		const box = await ctx.db.get(args.boxId);
		if (!box) throw new ConvexError("Box not found.");
		const operation = await ctx.db.get(args.operationId);
		// The patch below would throw on a missing operation anyway. Saying so
		// here is what keeps the event from being the thing that quietly drops:
		// the row is what names it, so no row means no name.
		if (!operation) throw new ConvexError("Operation not found.");

		const timestamp = Date.now();
		await ctx.db.patch(args.boxId, {
			status: args.status,
			updated_at: timestamp
		});
		await ctx.db.patch(args.operationId, {
			status: "succeeded",
			finished_at: timestamp,
			updated_at: timestamp
		});
		await appendBoxEvent(
			ctx,
			box,
			boxEventType(operation.type, args.outcome ?? "succeeded")
		);

		// Suspension is the other thing that happens to an owner's box without the
		// owner asking, and unlike a stop it cannot be undone from their own page.
		// Stop, start and a settled update all end here too and mail nobody: those
		// are the owner's own actions, finishing while they watch.
		//
		// Gated on the operation type *and* the status it settled at, because this
		// mutation also carries the transient `suspending`/`unsuspending` statuses -
		// so a future caller that reports progress through it cannot make this
		// announce a suspension that has not happened yet.
		if (operation.type === "suspend" && args.status === "suspended") {
			await sendOwnerNotice(ctx, box, {
				type: "suspended",
				reason: suspensionReason(operation.metadata)
			});
		}
		if (operation.type === "unsuspend" && args.status === "running") {
			await sendOwnerNotice(ctx, box, { type: "unsuspended" });
		}
	}
});
