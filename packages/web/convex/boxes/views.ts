import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { ideUrl } from "../env";
import { ACTIVE_OPERATION_STATUSES } from "../model/box/operation";
import { readGlobalSettings } from "../settings";
import { runtimeStanding } from "./version";
import { resolveSnapshotSplit } from "../model/box/plan";

type OperationSummary = {
	status: Doc<"box_operations">["status"];
	error: string | null;
	finishedAt: number | null;
};

// The latest operation of one type on a box, flattened to what a progress dialog
// shows. Both detail views read it, so they cannot disagree about what the owner
// and staff are told.
async function latestOperationSummary(
	db: DatabaseReader,
	boxId: Id<"boxes">,
	type: Doc<"box_operations">["type"]
): Promise<OperationSummary | null> {
	const operation = await db
		.query("box_operations")
		.withIndex("box_id_type_created_at", (query) =>
			query.eq("box_id", boxId).eq("type", type)
		)
		.order("desc")
		.first();
	if (!operation) return null;
	return {
		status: operation.status,
		error: operation.last_error ?? null,
		finishedAt: operation.finished_at ?? null
	};
}

// Repair moves the box into a visible `repairing`/`repair_failed` status, but
// the Repair dialog still reads this record for the precise progress and the
// error text behind a failure.
export function latestRepair(db: DatabaseReader, boxId: Id<"boxes">) {
	return latestOperationSummary(db, boxId, "repair");
}

// The same for Update. A failed update leaves the box's row on the image that
// last served (see workflows/updateBox.ts), so the status says an attempt failed
// and this record is the only thing that says why.
export function latestUpdate(db: DatabaseReader, boxId: Id<"boxes">) {
	return latestOperationSummary(db, boxId, "update");
}

// The operation currently holding this box's lock, if any. One definition, read by
// the console (to offer cancelling a wedged one) and by the sweep that rescues
// them, so neither can disagree about what "busy" means.
export async function activeOperation(db: DatabaseReader, boxId: Id<"boxes">) {
	for (const status of ACTIVE_OPERATION_STATUSES) {
		const operation = await db
			.query("box_operations")
			.withIndex("box_id_status", (query) =>
				query.eq("box_id", boxId).eq("status", status)
			)
			.first();
		if (operation) {
			return {
				createdAt: operation.created_at,
				operationId: operation._id,
				type: operation.type,
				workflowId: operation.workflow_id
			};
		}
	}
	return null;
}

// "Did the last thing that happened to this box fail?" - the box's most recent
// operation, reported only when it failed.
//
// Deliberately the latest operation rather than the latest *failure*: a failure
// that something has since succeeded past is history, not the box's current state,
// and this self-clears the moment anything else finishes. That is what lets one
// notice cover every operation instead of a per-operation dialog each owner has to
// think to open - repair and update had one, and reset, restore, creation,
// slug changes and configuration applies had nothing at all.
export async function latestFailure(
	db: DatabaseReader,
	boxId: Id<"boxes">
): Promise<{
	error: string | null;
	finishedAt: number | null;
	type: Doc<"box_operations">["type"];
} | null> {
	const operation = await db
		.query("box_operations")
		.withIndex("box_id_created_at", (query) => query.eq("box_id", boxId))
		.order("desc")
		.first();
	if (!operation || operation.status !== "failed") return null;
	return {
		error: operation.last_error ?? null,
		finishedAt: operation.finished_at ?? null,
		type: operation.type
	};
}

// A box's version standing, read once against the cached fleet release so the
// owner page and the staff console cannot disagree about whether an update is
// available or overdue.
export async function boxRuntimeStanding(
	db: DatabaseReader,
	box: Doc<"boxes">
) {
	const settings = await readGlobalSettings({ db });
	return runtimeStanding({
		boxImage: box.runtime_image,
		boxVersion: box.runtime_version,
		fleet: settings.runtimeRelease,
		minimum: settings.minimumRuntime
	});
}

// What a box's own owner is sent. Nothing else: a field here is shipped to a
// browser for every row of every box list, so the billing identifiers, the
// retention dates and the raw image version live one function down, where only
// the console reads them.
export function safeBox(box: Doc<"boxes">) {
	return {
		id: box._id,
		slug: box.slug,
		plan: box.plan,
		// Resolved, never the raw column: every reader gets the same coherent pair
		// and none of them has to know the automatic half is a remainder.
		snapshots: resolveSnapshotSplit(box.plan, box.manual_snapshot_cap),
		status: box.status,
		runtimeUrl: ideUrl(box.slug),
		createdAt: box.created_at,
		comp: box.comped_at !== undefined
	};
}

export function staffBox(box: Doc<"boxes">, user?: Doc<"users"> | null) {
	return {
		...safeBox(box),
		runtimeUrl: box.status === "deleted" ? null : ideUrl(box.slug),
		deletedAt: box.deleted_at,
		purgeAt: box.purge_at,
		polarSubscriptionId: box.polar_subscription_id ?? null,
		userId: box.user_id,
		userEmail: user?.email ?? "",
		polarCustomerId: box.polar_customer_id ?? null,
		compedBy: box.comped_by ?? null,
		compReason: box.comp_reason ?? null,
		runtimeImage: box.runtime_image,
		hetznerServerId: box.hetzner_server_id,
		hetznerServerType: box.hetzner_server_type,
		hetznerLocation: box.hetzner_location,
		hetznerIpv4: box.hetzner_ipv4,
		hetznerIpv6: box.hetzner_ipv6,
		dnsRecordId: box.dns_record_id,
		dnsRecordAaaaId: box.dns_record_aaaa_id
	};
}
