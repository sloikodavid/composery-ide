"use node";

// The one action that leaves the isolate: polling Hetzner for every running
// box's sample. It is a file of its own because Convex puts a whole module in
// the Node runtime or none of it, and `metrics.ts` - the validators, the
// rollup, the thresholds - has to stay in the isolate where the rest of the
// deployment can call it. Merging the two is not a filing choice; it is a
// runtime boundary.
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, type ActionCtx } from "../_generated/server";
import { fetchServerMetricsSample, fetchServerUsage } from "./infra/hetznerVps";
import { startBoxSuspension } from "./operation/start";
import { METRICS_POLL_INTERVAL_MS, POLLED_STATUSES } from "./metrics";

// How many boxes are polled at once. Hetzner rate-limits per project, and the
// sweep must finish inside one cron interval for every box the fleet has.
const POLL_CONCURRENCY = 10;

type PollTarget = {
	boxId: Id<"boxes">;
	serverId: number;
	slug: string;
};

type PollTargetsPage = {
	continueCursor: string;
	isDone: boolean;
	page: PollTarget[];
};

async function pollTargets(ctx: ActionCtx, targets: PollTarget[]) {
	for (let index = 0; index < targets.length; index += POLL_CONCURRENCY) {
		await Promise.all(
			targets.slice(index, index + POLL_CONCURRENCY).map(async (target) => {
				// One box failing must not stop the rest of the fleet.
				try {
					const sample = await fetchServerMetricsSample(
						target.serverId,
						METRICS_POLL_INTERVAL_MS
					);
					const { suspendFlagId, suspendReason } = await ctx.runMutation(
						internal.boxes.metrics.recordSample,
						{ boxId: target.boxId, ...sample }
					);

					if (suspendFlagId && suspendReason) {
						await startBoxSuspension(ctx, {
							boxId: target.boxId,
							idempotencyKeyPrefix: `flag:${suspendFlagId}`,
							reason: suspendReason,
							suspend: true,
							trigger: "system:abuse_suspension"
						});
					}
				} catch (error) {
					console.error(`Metrics poll failed for box ${target.slug}.`, error);
				}

				// Traffic rides this sweep rather than getting one of its own: it is
				// read from the same provider, for the same set of boxes, on an
				// interval that already fits a counter which moves over a month. What
				// it is not is a metric - it is a level against the allowance the plan
				// sold - so it is recorded through `boxes/usage.ts` and not beside the
				// rates above.
				//
				// After the abuse path, and in a catch of its own, because the two are
				// not one job. A provider that answers the metrics endpoint and not the
				// server one used to take the suspension down with it - the sweep had
				// already flagged the box for its own rate, and a failed usage
				// read meant nothing was done about it. Ordering alone is not enough:
				// the reading is the less important of the two, so it goes last and it
				// fails alone.
				try {
					const usage = await fetchServerUsage(target.serverId);
					if (usage) {
						await ctx.runMutation(internal.boxes.usage.recordTrafficUsage, {
							boxId: target.boxId,
							outgoingBytes: usage.outgoingBytes
						});
					}
				} catch (error) {
					console.error(`Usage poll failed for box ${target.slug}.`, error);
				}
			})
		);
	}
}

export const pollBoxMetrics = internalAction({
	args: {},
	handler: async (ctx) => {
		for (const status of POLLED_STATUSES) {
			let cursor: string | null = null;

			for (;;) {
				const page: PollTargetsPage = await ctx.runQuery(
					internal.boxes.metrics.pollTargetsPage,
					{ cursor, status }
				);
				await pollTargets(ctx, page.page);

				if (page.isDone) break;
				cursor = page.continueCursor;
			}
		}
	}
});
