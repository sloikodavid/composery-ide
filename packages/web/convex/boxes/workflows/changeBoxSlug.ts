import { v } from "convex/values";
import { internal } from "../../_generated/api";
import { defineBoxWorkflow } from "./boxWorkflow";

// Moving a box to a new slug means new DNS records and a reverse proxy reload,
// neither of which is atomic with the row. So the box only takes the new slug
// once both have landed, and anything that throws before that unwinds the DNS it
// created rather than leaving a record pointing at a box that never answered on
// it.
//
// The unwind lives inside `run` and rethrows, so the failure itself is still
// recorded by `defineBoxWorkflow` from `OPERATION_FAILURE_STATUS`. This used to hand-roll
// the whole wrapper - marking the operation running and failed itself - which
// meant it was the one workflow that could disagree with every other about where
// a failure leaves the box.
export const changeBoxSlug = defineBoxWorkflow({
	extraArgs: { newSlug: v.string() },
	type: "change_slug",
	run: async (step, args) => {
		const box = await step.runQuery(
			internal.boxes.queries.getBoxLifecycleSnapshot,
			{ boxId: args.boxId }
		);
		let dns: { aRecordId: string; aaaaRecordId: string } | null = null;

		try {
			if (!box.hetzner_ipv4 || !box.hetzner_ipv6) {
				throw new Error("Box does not have both public IP addresses.");
			}

			dns = await step.runAction(
				internal.boxes.infra.cloudflareDns.createRuntimeDnsRecords,
				{
					slug: args.newSlug,
					ipv4: box.hetzner_ipv4,
					ipv6: box.hetzner_ipv6
				},
				{ retry: true }
			);

			if (!dns) throw new Error("DNS records were not created.");

			await step.runAction(
				internal.boxes.infra.host.reloadSlug,
				{
					boxId: args.boxId,
					newSlug: args.newSlug
				},
				{ retry: true }
			);

			await step.runMutation(internal.boxes.operation.record.swapSlug, {
				boxId: args.boxId,
				operationId: args.operationId,
				newSlug: args.newSlug,
				newARecordId: dns.aRecordId,
				newAaaaRecordId: dns.aaaaRecordId
			});

			try {
				await step.runAction(
					internal.boxes.infra.cloudflareDns.deleteRuntimeDnsRecords,
					{
						aRecordId: box.dns_record_id,
						aaaaRecordId: box.dns_record_aaaa_id
					},
					{ retry: true }
				);
			} catch {
				// Old DNS cleanup is best-effort after the slug swap has committed.
			}
		} catch (error) {
			if (dns) {
				await step
					.runAction(
						internal.boxes.infra.host.reloadSlug,
						{
							boxId: args.boxId,
							newSlug: box.slug
						},
						{ retry: true }
					)
					.catch(() => undefined);
				await step
					.runAction(
						internal.boxes.infra.cloudflareDns.deleteRuntimeDnsRecords,
						{
							aRecordId: dns.aRecordId,
							aaaaRecordId: dns.aaaaRecordId
						},
						{ retry: true }
					)
					.catch(() => undefined);
			}
			throw error;
		}
	}
});
