import type { WorkflowCtx } from "@convex-dev/workflow";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { boxPlanServerType, type BoxPlan } from "../../model/box/plan";

// Delete the box's DNS and server, waiting for Hetzner to finish, so the server
// name/labels are free to reuse. Shared by resetBox and deleteBox.
//
// The box's Primary IPs are deliberately not touched here. Hetzner creates them
// itself for a server asked for with `enable_ipv4`/`enable_ipv6` (see
// `createServerPayload`), marks them `auto_delete`, and removes them along with
// the server - asynchronously, and on its own schedule. Deleting them from here
// therefore raced Hetzner's own cleanup and lost: the step answered
// "Primary IP must be unassigned" and left the box in `delete_failed` with its
// server already gone. That was the second failure of the same step, after a
// lookup form Hetzner rejected with 422 wedged deletion in an hourly retry loop,
// so the step itself is the defect rather than either symptom.
//
// Nothing silently replaces it: `reconcileHetznerResources` reports any Primary
// IP left attached to nothing, so a leak surfaces as a staff alert instead of a
// quiet bill - and it does so off the deletion path, where being a day late
// costs nothing and failing costs a box that can never finish deleting.
export async function deleteRuntime(step: WorkflowCtx, box: Doc<"boxes">) {
	await step.runAction(
		internal.boxes.infra.cloudflareDns.deleteRuntimeDnsRecords,
		{
			aRecordId: box.dns_record_id,
			aaaaRecordId: box.dns_record_aaaa_id
		},
		{ retry: true }
	);
	await step.runAction(
		internal.boxes.infra.hetznerVps.deleteServer,
		{ serverId: box.hetzner_server_id },
		{ retry: true }
	);
	await step.runAction(
		internal.boxes.infra.hetznerVps.waitServerDeleted,
		{ serverId: box.hetzner_server_id },
		{ retry: true }
	);
}

// Create a server and DNS, then bootstrap the runtime, recording each step.
// Shared by createBox and resetBox.
// `image` provisions the box from a snapshot instead of the deployment's base
// image, which is what makes a duplicate a duplicate. Absent everywhere else,
// including on the reset path that also calls this: a reset exists to rebuild a
// box from the base image, so passing the source's snapshot there would be the
// opposite of what it means.
export async function createRuntime(
	step: WorkflowCtx,
	boxId: Id<"boxes">,
	slug: string,
	plan: BoxPlan,
	image?: number | string
) {
	const server = await step.runAction(
		internal.boxes.infra.hetznerVps.createServer,
		{ boxId, image, slug, serverType: boxPlanServerType(plan) },
		{ retry: true }
	);

	await step.runMutation(internal.boxes.operation.record.recordServerCreated, {
		boxId,
		serverId: server.serverId,
		serverType: server.serverType,
		location: server.location,
		ipv4: server.ipv4,
		ipv6: server.ipv6
	});

	const dns = await step.runAction(
		internal.boxes.infra.cloudflareDns.createRuntimeDnsRecords,
		{ slug, ipv4: server.ipv4, ipv6: server.ipv6 },
		{ retry: true }
	);

	await step.runMutation(internal.boxes.operation.record.recordDnsCreated, {
		boxId,
		aRecordId: dns.aRecordId,
		aaaaRecordId: dns.aaaaRecordId
	});

	await step.runAction(
		internal.boxes.infra.host.bootstrapRuntime,
		{ boxId },
		{ retry: true }
	);
}
