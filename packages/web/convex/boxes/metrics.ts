import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
	internalMutation,
	internalQuery,
	type DatabaseReader
} from "../_generated/server";
import { boxStatusesExcept, type BoxStatus } from "../model/box/status";
import { readGlobalSettings } from "../settings";
import { staffConsoleUrl } from "../env";
import { raiseAlert } from "../staff/alerts";
import { consoleBoxPath } from "../model/box/path";
import {
	crossedValue,
	FLAG_SIGNALS,
	flagSignalLabel,
	formatFlagValue,
	isEnabled,
	METRICS_RANGES,
	ROLLED_METRICS,
	type MetricsRange,
	type RolledMetric
} from "../model/box/metric";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "../time";

export const METRICS_POLL_INTERVAL_MINUTES = 10;
export const METRICS_POLL_INTERVAL_MS =
	METRICS_POLL_INTERVAL_MINUTES * MINUTE_MS;

const METRICS_SERIES_WINDOW_MS = DAY_MS;
// The annotated windows in this file are exported only because the Fixed windows
// table states them: `// window:` is what binds a number in the doc to the
// constant that produces it, and the test that pins the pair reads the value.
// window: Raw metrics retention
export const RAW_RETENTION_MS = 2 * DAY_MS;
// window: Hourly metrics retention
export const ROLLUP_RETENTION_MS = 30 * DAY_MS;
const ROLLUP_BOX_BATCH = 200;
const ROLLUP_SAMPLE_LIMIT = Math.ceil(HOUR_MS / METRICS_POLL_INTERVAL_MS) + 18;
// window: Repeat flag cooloff per box/signal
export const FLAG_COOLOFF_MS = 6 * HOUR_MS;
const RETENTION_DELETE_BATCH = 1000;
const POLL_TARGET_PAGE_SIZE = 200;

export const POLLED_STATUSES = ["running", "stopped", "suspended"] as const;

// A deleted box has no samples left to roll up; every other status can.
// Previously spelled out, which is how `repair_failed` came to be missing from
// it - the rollup simply skipped those boxes.
const ROLLUP_BOX_STATUSES: readonly BoxStatus[] = boxStatusesExcept("deleted");

export const vPolledStatus = v.union(
	v.literal("running"),
	v.literal("stopped"),
	v.literal("suspended")
);

// Both validators are built from the vocabulary in `convex/model/box/metric.ts`
// rather than restating it, so what the console's pickers offer and what these
// arguments accept are the same list by construction.
export const vRolledMetric = v.union(
	...ROLLED_METRICS.map((metric) => v.literal(metric))
);

export const vMetricsRange = v.union(
	...METRICS_RANGES.map((range) => v.literal(range))
);

// Raw box_metrics samples are retained for two days (polled every
// METRICS_POLL_INTERVAL_MS); beyond that the series falls back to the hourly
// box_metrics_hourly rollups, which are retained for thirty days.
const METRICS_RANGE_CONFIG: Record<
	MetricsRange,
	{ hourly: boolean; windowMs: number }
> = {
	"1h": { hourly: false, windowMs: HOUR_MS },
	"6h": { hourly: false, windowMs: 6 * HOUR_MS },
	"24h": { hourly: false, windowMs: METRICS_SERIES_WINDOW_MS },
	"7d": { hourly: true, windowMs: 7 * DAY_MS },
	"30d": { hourly: true, windowMs: 30 * DAY_MS }
};

export type RollupMetricSample = Record<RolledMetric, number>;

export function rollupMetricMeans<T extends RollupMetricSample>(
	samples: readonly T[]
) {
	return Object.fromEntries(
		ROLLED_METRICS.map((metric) => [
			metric,
			samples.reduce((sum, sample) => sum + sample[metric], 0) / samples.length
		])
	) as Record<RolledMetric, number>;
}

export function metricsSampleView(sample: Doc<"box_metrics">) {
	return {
		sampledAt: sample.sampled_at,
		cpuPercent: sample.cpu_percent,
		ingressBps: sample.ingress_bps,
		egressBps: sample.egress_bps,
		ingressPps: sample.ingress_pps,
		egressPps: sample.egress_pps,
		diskReadBps: sample.disk_read_bps,
		diskWriteBps: sample.disk_write_bps
	};
}

function hourlySampleView(sample: Doc<"box_metrics_hourly">) {
	return {
		sampledAt: sample.hour_start,
		cpuPercent: sample.cpu_percent,
		ingressBps: sample.ingress_bps,
		egressBps: sample.egress_bps,
		ingressPps: sample.ingress_pps,
		egressPps: sample.egress_pps,
		diskReadBps: sample.disk_read_bps,
		diskWriteBps: sample.disk_write_bps
	};
}

export async function boxMetricsSamples(
	ctx: { db: DatabaseReader },
	boxId: Id<"boxes">,
	range: MetricsRange = "24h"
) {
	const { hourly, windowMs } = METRICS_RANGE_CONFIG[range];
	const since = Date.now() - windowMs;
	// How many rows the window can hold, plus slack for polls that landed closer
	// together than the nominal interval. Only an upper bound is needed: the
	// index below already excludes everything older than the window, so any
	// limit at or above the window's capacity selects exactly the same rows.
	const perRow = hourly ? HOUR_MS : METRICS_POLL_INTERVAL_MS;
	// Stryker disable next-line ArithmeticOperator: widening this bound selects the same rows, so no test can observe the change.
	const limit = Math.ceil(windowMs / perRow) + 12;

	// Both branches read newest-first so the bound keeps the newest rows rather
	// than the oldest, then reverse into the order a chart is read in.
	//
	// A surviving `"desc"` mutant on either is a limit of the harness rather
	// than a gap: convex-test sorts descending for every value that is not
	// exactly "asc", so no test can tell the literal from any other. That is
	// recorded once, with the rest of its kind, in tests/support/convex.ts.
	if (hourly) {
		const samples = await ctx.db
			.query("box_metrics_hourly")
			.withIndex("box_id_hour_start", (query) =>
				query.eq("box_id", boxId).gte("hour_start", since)
			)
			.order("desc")
			.take(limit);
		return samples.reverse().map(hourlySampleView);
	}
	const samples = await ctx.db
		.query("box_metrics")
		.withIndex("box_id_sampled_at", (query) =>
			query.eq("box_id", boxId).gte("sampled_at", since)
		)
		.order("desc")
		.take(limit);
	return samples.reverse().map(metricsSampleView);
}

export const pollTargetsPage = internalQuery({
	args: {
		cursor: v.union(v.string(), v.null()),
		status: vPolledStatus
	},
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query("boxes")
			.withIndex("status", (query) => query.eq("status", args.status))
			.paginate({
				cursor: args.cursor,
				numItems: POLL_TARGET_PAGE_SIZE
			});

		return {
			...page,
			page: page.page
				.filter((box) => box.hetzner_server_id)
				.map((box) => ({
					boxId: box._id,
					serverId: box.hetzner_server_id as number,
					slug: box.slug
				}))
		};
	}
});

export const recordSample = internalMutation({
	args: {
		boxId: v.id("boxes"),
		cpuPercent: v.number(),
		ingressBps: v.number(),
		egressBps: v.number(),
		ingressPps: v.number(),
		egressPps: v.number(),
		diskReadBps: v.number(),
		diskWriteBps: v.number()
	},
	handler: async (
		ctx,
		args
	): Promise<{
		suspendFlagId: string | null;
		suspendReason: string | null;
	}> => {
		const none = { suspendFlagId: null, suspendReason: null };
		const box = await ctx.db.get(args.boxId);
		if (!box) return none;

		const now = Date.now();
		await ctx.db.insert("box_metrics", {
			box_id: args.boxId,
			sampled_at: now,
			cpu_percent: args.cpuPercent,
			ingress_bps: args.ingressBps,
			egress_bps: args.egressBps,
			ingress_pps: args.ingressPps,
			egress_pps: args.egressPps,
			disk_read_bps: args.diskReadBps,
			disk_write_bps: args.diskWriteBps
		});

		if (box.status !== "running") return none;

		const settings = await readGlobalSettings(ctx);
		const thresholds = settings.thresholds;

		const longestWindow = Math.max(
			...thresholds.map((threshold) => threshold.sustainedSamples)
		);
		const samples = await ctx.db
			.query("box_metrics")
			.withIndex("box_id_sampled_at", (query) => query.eq("box_id", args.boxId))
			// Newest first: the window below is a count of the most recent samples.
			.order("desc")
			.take(longestWindow);

		let suspendFlagId: string | null = null;
		let suspendReason: string | null = null;

		for (const threshold of thresholds) {
			if (!isEnabled(threshold)) continue;
			const { metric } = FLAG_SIGNALS[threshold.signal];
			const value = crossedValue(
				samples.map((sample) => sample[metric]),
				threshold
			);
			if (value === null) continue;

			const lastFlag = await ctx.db
				.query("box_flags")
				.withIndex("box_id_signal", (query) =>
					query.eq("box_id", args.boxId).eq("signal", threshold.signal)
				)
				// The most recent flag for this signal, which is what the cooloff
				// below is measured from.
				.order("desc")
				.first();
			if (lastFlag && now - lastFlag.created_at < FLAG_COOLOFF_MS) continue;

			const windowMinutes =
				(threshold.sustainedSamples * METRICS_POLL_INTERVAL_MS) / MINUTE_MS;
			const message = `Sustained ${flagSignalLabel(
				threshold.signal,
				true
			)} at ${formatFlagValue(
				threshold.signal,
				value
			)} (threshold ${formatFlagValue(
				threshold.signal,
				threshold.value
			)}) over the last ${windowMinutes} minutes.`;
			const autoSuspend: boolean =
				settings.autoSuspendEnabled && suspendFlagId === null;

			const flagId: Id<"box_flags"> = await ctx.db.insert("box_flags", {
				box_id: args.boxId,
				signal: threshold.signal,
				message,
				value,
				threshold: threshold.value,
				auto_suspended: autoSuspend,
				created_at: now
			});

			if (autoSuspend) {
				suspendFlagId = flagId;
				suspendReason = `Automatic suspension: ${message}`;
			}

			await raiseAlert(ctx, {
				key: `box-flag:${flagId}`,
				severity: autoSuspend ? "critical" : "warning",
				subject: `Box ${box.slug} flagged: ${flagSignalLabel(
					threshold.signal,
					true
				)}`,
				text: `${message}\n\n${
					autoSuspend ? "The box was automatically suspended.\n\n" : ""
				}${staffConsoleUrl(consoleBoxPath(box._id))}`
			});
		}

		return { suspendFlagId, suspendReason };
	}
});

export const deleteOldSamples = internalMutation({
	args: {},
	handler: async (ctx) => {
		const oldSamples = await ctx.db
			.query("box_metrics")
			.withIndex("sampled_at", (query) =>
				query.lt("sampled_at", Date.now() - RAW_RETENTION_MS)
			)
			.take(RETENTION_DELETE_BATCH);
		const oldRollups = await ctx.db
			.query("box_metrics_hourly")
			.withIndex("hour_start", (query) =>
				query.lt("hour_start", Date.now() - ROLLUP_RETENTION_MS)
			)
			.take(RETENTION_DELETE_BATCH);

		for (const row of [...oldSamples, ...oldRollups]) {
			await ctx.db.delete(row._id);
		}

		if (
			oldSamples.length === RETENTION_DELETE_BATCH ||
			oldRollups.length === RETENTION_DELETE_BATCH
		) {
			await ctx.scheduler.runAfter(
				0,
				internal.boxes.metrics.deleteOldSamples,
				{}
			);
		}
	}
});

export const rollupHourlyMetrics = internalMutation({
	args: {
		cursor: v.optional(v.string()),
		hourStart: v.optional(v.number()),
		statusIndex: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const hourStart =
			args.hourStart ?? Math.floor(Date.now() / HOUR_MS) * HOUR_MS - HOUR_MS;
		const statusIndex = args.statusIndex ?? 0;
		const status = ROLLUP_BOX_STATUSES[statusIndex];
		// The walk has run past the end of the list. Stopping here rather than
		// querying for an undefined status is the difference between a no-op and
		// a query nobody meant to make.
		// Stryker disable next-line ConditionalExpression: an index past the end matches no box either way, so both paths write nothing and schedule nothing.
		if (!status) return;

		const page = await ctx.db
			.query("boxes")
			.withIndex("status", (query) => query.eq("status", status))
			.paginate({ cursor: args.cursor ?? null, numItems: ROLLUP_BOX_BATCH });

		for (const box of page.page) {
			const existing = await ctx.db
				.query("box_metrics_hourly")
				.withIndex("box_id_hour_start", (query) =>
					query.eq("box_id", box._id).eq("hour_start", hourStart)
				)
				.first();
			if (existing) continue;

			const samples = await ctx.db
				.query("box_metrics")
				.withIndex("box_id_sampled_at", (query) =>
					query
						.eq("box_id", box._id)
						.gte("sampled_at", hourStart)
						.lt("sampled_at", hourStart + HOUR_MS)
				)
				.take(ROLLUP_SAMPLE_LIMIT);
			if (samples.length === 0) continue;

			const means = rollupMetricMeans(samples);

			await ctx.db.insert("box_metrics_hourly", {
				box_id: box._id,
				hour_start: hourStart,
				sample_count: samples.length,
				...means
			});
		}

		if (!page.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.boxes.metrics.rollupHourlyMetrics,
				{ cursor: page.continueCursor, hourStart, statusIndex }
			);
			return;
		}

		if (statusIndex + 1 < ROLLUP_BOX_STATUSES.length) {
			await ctx.scheduler.runAfter(
				0,
				internal.boxes.metrics.rollupHourlyMetrics,
				{ hourStart, statusIndex: statusIndex + 1 }
			);
		}
	}
});
