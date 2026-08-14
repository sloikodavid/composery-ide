import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Doc } from "@/convex/_generated/dataModel";
import { boxStatusesExcept } from "@/convex/model/box/status";
import {
	FLAG_COOLOFF_MS,
	RAW_RETENTION_MS,
	ROLLUP_RETENTION_MS,
	boxMetricsSamples,
	rollupMetricMeans,
	type RollupMetricSample
} from "@/convex/boxes/metrics";

import {
	scheduledArgs,
	scheduledJobs,
	seedBox,
	seedSettings,
	seedUser,
	staffAlerts,
	stubDeploymentEnv,
	testConvex,
	type Harness
} from "../../../support/convex.ts";

function sample(value: number): RollupMetricSample {
	return {
		cpu_percent: value,
		ingress_bps: value + 1,
		egress_bps: value + 2,
		ingress_pps: value + 3,
		egress_pps: value + 4,
		disk_read_bps: value + 5,
		disk_write_bps: value + 6
	};
}

describe("rollupMetricMeans", () => {
	test("averages every rolled metric independently", () => {
		expect(rollupMetricMeans([sample(10), sample(20)])).toEqual({
			cpu_percent: 15,
			ingress_bps: 16,
			egress_bps: 17,
			ingress_pps: 18,
			egress_pps: 19,
			disk_read_bps: 20,
			disk_write_bps: 21
		});
	});

	test("does not mutate input samples", () => {
		const samples = [sample(1), sample(2)];
		const before = structuredClone(samples);

		rollupMetricMeans(samples);

		expect(samples).toEqual(before);
	});
});

const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	stubDeploymentEnv();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

const READING = {
	cpu_percent: 1,
	ingress_bps: 1,
	egress_bps: 1,
	ingress_pps: 1,
	egress_pps: 1,
	disk_read_bps: 1,
	disk_write_bps: 1
};

// Which table a range reads from.
//
// Raw samples are kept for two days and rolled up hourly for thirty, so a range
// longer than the raw window has to read the rollups or it silently returns a
// truncated series - a 30-day chart showing two days of data and no gap.
describe("the window a metrics range reads", () => {
	async function seedBoth(t: Harness, boxId: Id<"boxes">) {
		await t.run(async (ctx) => {
			await ctx.db.insert("box_metrics", {
				...READING,
				box_id: boxId,
				sampled_at: NOW - HOUR
			});
			await ctx.db.insert("box_metrics_hourly", {
				...READING,
				cpu_percent: 99,
				box_id: boxId,
				hour_start: NOW - 3 * 24 * HOUR,
				sample_count: 6
			});
		});
	}

	test("reads raw samples for a short range", async () => {
		const t = testConvex();
		await seedSettings(t);
		const boxId = await seedBox(t, { user_id: "owner" });
		await seedBoth(t, boxId);

		const samples = await t.run((ctx) => boxMetricsSamples(ctx, boxId, "1h"));

		expect(samples).toHaveLength(1);
		expect(samples[0]?.cpuPercent).toBe(1);
	});

	// Three days back: past the raw retention entirely, so only the rollup can
	// answer.
	test("reads the hourly rollups for a range longer than raw retention", async () => {
		const t = testConvex();
		await seedSettings(t);
		const boxId = await seedBox(t, { user_id: "owner" });
		await seedBoth(t, boxId);

		const samples = await t.run((ctx) => boxMetricsSamples(ctx, boxId, "30d"));

		expect(samples).toHaveLength(1);
		expect(samples[0]?.cpuPercent).toBe(99);
	});

	test("defaults to the raw window when no range is asked for", async () => {
		const t = testConvex();
		await seedSettings(t);
		const boxId = await seedBox(t, { user_id: "owner" });
		await seedBoth(t, boxId);

		const samples = await t.run((ctx) => boxMetricsSamples(ctx, boxId));

		expect(samples).toHaveLength(1);
		expect(samples[0]?.cpuPercent).toBe(1);
	});
});

// A box that stays over a threshold is still over it on the next poll, so the
// same signal would open a flag every ten minutes. The cooloff is what keeps one
// sustained problem to one flag - staff act on flags, and a hundred rows for one
// box is the same as none.
describe("the repeat-flag cooloff", () => {
	// Flags are evaluated as each sample is recorded, so driving the real
	// mutation is what exercises the cooloff.
	async function pollOverThreshold(t: Harness, boxId: Id<"boxes">) {
		for (let index = 0; index < 6; index += 1) {
			await t.mutation(internal.boxes.metrics.recordSample, {
				boxId,
				cpuPercent: 1,
				ingressBps: 1,
				egressBps: 500_000_000,
				ingressPps: 1,
				egressPps: 1,
				diskReadBps: 1,
				diskWriteBps: 1
			});
		}
	}

	async function flagCount(t: Harness) {
		return (await t.run((ctx) => ctx.db.query("box_flags").collect())).length;
	}

	test("opens one flag for a sustained crossing, not one per poll", async () => {
		const t = testConvex();
		await seedSettings(t);
		const boxId = await seedBox(t, { user_id: "owner" });

		await pollOverThreshold(t, boxId);
		const first = await flagCount(t);
		vi.setSystemTime(NOW + FLAG_COOLOFF_MS - 1);
		await pollOverThreshold(t, boxId);

		expect(first).toBeGreaterThan(0);
		expect(await flagCount(t)).toBe(first);
	});

	test("flags again once the cooloff has elapsed", async () => {
		const t = testConvex();
		await seedSettings(t);
		const boxId = await seedBox(t, { user_id: "owner" });

		await pollOverThreshold(t, boxId);
		const first = await flagCount(t);
		vi.setSystemTime(NOW + FLAG_COOLOFF_MS);
		await pollOverThreshold(t, boxId);

		expect(await flagCount(t)).toBeGreaterThan(first);
	});
});

// Recording a sample is also where a box gets flagged and, if staff have armed
// it, suspended. Everything below runs the real mutation, because "which sample
// crosses" is a property of the loop over thresholds and not of any helper.
describe("flagging a box from its samples", () => {
	// Comfortably over the shipped 25 Mbit/s egress default, and comfortably over
	// the 30k packets/s one, so a poll can cross either or both.
	const OVER_BANDWIDTH = 500_000_000;
	const OVER_PPS = 100_000;

	async function poll(
		t: Harness,
		boxId: Id<"boxes">,
		over: { bandwidth?: boolean; pps?: boolean } = { bandwidth: true }
	) {
		return await t.mutation(internal.boxes.metrics.recordSample, {
			boxId,
			cpuPercent: 1,
			ingressBps: 1,
			egressBps: over.bandwidth ? OVER_BANDWIDTH : 1,
			ingressPps: 1,
			egressPps: over.pps ? OVER_PPS : 1,
			diskReadBps: 1,
			diskWriteBps: 1
		});
	}

	// Returns the poll that crossed, not the last one: a threshold flags on the
	// sample that completes its window, and the repeat cooloff keeps every later
	// poll in the same window quiet.
	async function pollUntilSustained(
		t: Harness,
		boxId: Id<"boxes">,
		over: { bandwidth?: boolean; pps?: boolean } = { bandwidth: true }
	) {
		let crossing = { suspendFlagId: null, suspendReason: null } as Awaited<
			ReturnType<typeof poll>
		>;
		for (let index = 0; index < 4; index += 1) {
			const result = await poll(t, boxId, over);
			if (crossing.suspendFlagId === null) crossing = result;
		}
		return crossing;
	}

	const flags = (t: Harness) =>
		t.run((ctx) => ctx.db.query("box_flags").collect());
	const samples = (t: Harness) =>
		t.run((ctx) => ctx.db.query("box_metrics").collect());

	// A sample is telemetry first: it is stored whatever the box's status, so the
	// chart on a stopped box still shows the hours before it stopped.
	test("stores the sample even for a box that is not running", async () => {
		const t = testConvex();
		await seedSettings(t);
		const boxId = await seedBox(t, { user_id: "owner", status: "stopped" });

		await pollUntilSustained(t, boxId);

		expect(await samples(t)).toHaveLength(4);
		expect(await flags(t)).toEqual([]);
	});

	test("stores nothing for a box that is gone", async () => {
		const t = testConvex();
		await seedSettings(t);
		const boxId = await seedBox(t, { user_id: "owner" });
		await t.run(async (ctx) => await ctx.db.delete(boxId));

		expect(await poll(t, boxId)).toEqual({
			suspendFlagId: null,
			suspendReason: null
		});
		expect(await samples(t)).toEqual([]);
	});

	// Zero is the documented "off" value for a threshold, and a disabled signal
	// must not flag however far over it a box goes.
	test("never flags a signal whose threshold is disabled", async () => {
		const t = testConvex();
		await seedSettings(t, {
			thresholds: [
				{ signal: "egress_bandwidth", value: 0, sustained_samples: 3 },
				{ signal: "egress_pps", value: 0, sustained_samples: 3 }
			]
		});
		const boxId = await seedBox(t, { user_id: "owner" });

		await pollUntilSustained(t, boxId, { bandwidth: true, pps: true });

		expect(await flags(t)).toEqual([]);
	});

	test("records what crossed, and what it was measured against", async () => {
		const t = testConvex();
		await seedSettings(t);
		const boxId = await seedBox(t, { user_id: "owner" });

		await pollUntilSustained(t, boxId);

		expect(await flags(t)).toMatchObject([
			{
				signal: "egress_bandwidth",
				value: OVER_BANDWIDTH,
				threshold: 25_000_000,
				auto_suspended: false
			}
		]);
	});

	// The flag's message is what the owner's suspension email quotes, so it has to
	// name the signal in a sentence, the measurement, the threshold, and how long
	// the crossing lasted.
	test("explains the crossing in the words the owner will read", async () => {
		const t = testConvex();
		await seedSettings(t);
		const boxId = await seedBox(t, { user_id: "owner" });

		await pollUntilSustained(t, boxId);

		const [flag] = await flags(t);
		expect(flag.message).toBe(
			"Sustained outbound bandwidth at 4,000 Mbit/s (threshold 200 Mbit/s) over the last 30 minutes."
		);
	});

	// Staff have to arm it. Flagging is observation; suspending is an action
	// against a paying customer's box, and it never happens by default.
	test("flags without suspending while automatic suspension is off", async () => {
		const t = testConvex();
		await seedSettings(t, { auto_suspend_enabled: false });
		const boxId = await seedBox(t, { user_id: "owner" });

		const result = await pollUntilSustained(t, boxId);

		expect(result).toEqual({ suspendFlagId: null, suspendReason: null });
		expect(await flags(t)).toMatchObject([{ auto_suspended: false }]);
	});

	test("suspends on a sustained crossing once staff have armed it", async () => {
		const t = testConvex();
		await seedSettings(t, { auto_suspend_enabled: true });
		const boxId = await seedBox(t, { user_id: "owner" });

		const result = await pollUntilSustained(t, boxId);

		expect(result.suspendFlagId).not.toBeNull();
		expect(result.suspendReason).toMatch(
			/^Automatic suspension: Sustained outbound bandwidth/
		);
		expect(await flags(t)).toMatchObject([{ auto_suspended: true }]);
	});

	// One suspension, however many signals crossed on the same sample. The second
	// flag is still recorded - it is what the box did - but it does not claim to
	// have suspended a box that was already being suspended.
	test("suspends once when two signals cross together", async () => {
		const t = testConvex();
		await seedSettings(t, { auto_suspend_enabled: true });
		const boxId = await seedBox(t, { user_id: "owner" });

		await pollUntilSustained(t, boxId, { bandwidth: true, pps: true });

		expect(
			(await flags(t)).map((flag) => [flag.signal, flag.auto_suspended])
		).toEqual([
			["egress_bandwidth", true],
			["egress_pps", false]
		]);
	});

	// Severity follows the consequence, not the signal: a flag that only told
	// staff about a box is a warning, and one that took the box off the air is
	// something a person has to look at now.
	test("pages staff only when the flag actually suspended the box", async () => {
		const t = testConvex();
		await seedSettings(t, { auto_suspend_enabled: true });
		const boxId = await seedBox(t, { user_id: "owner", slug: "noisy" });

		await pollUntilSustained(t, boxId);

		const [alert] = await staffAlerts(t);
		expect(alert).toMatchObject({
			severity: "critical",
			subject: "Box noisy flagged: outbound bandwidth"
		});
		expect(alert.text).toContain("The box was automatically suspended.");
	});

	test("warns staff without the suspension line when nothing was suspended", async () => {
		const t = testConvex();
		await seedSettings(t, { auto_suspend_enabled: false });
		const boxId = await seedBox(t, { user_id: "owner", slug: "noisy" });

		await pollUntilSustained(t, boxId);

		const [alert] = await staffAlerts(t);
		expect(alert).toMatchObject({ severity: "warning" });
		expect(alert.text).not.toContain("automatically suspended");
	});

	// The window is the point of a threshold: a single spike is a build, not
	// abuse, and flagging it would make the signal useless.
	test("says nothing about a spike shorter than the sustained window", async () => {
		const t = testConvex();
		await seedSettings(t);
		const boxId = await seedBox(t, { user_id: "owner" });

		await poll(t, boxId);
		await poll(t, boxId, {});

		expect(await flags(t)).toEqual([]);
	});
});

// Metrics retention, and the rollup that makes it possible.
//
// Raw samples are kept for two days and rolled into hours kept for thirty, so
// the chart survives long after the samples do. Both halves cost money to get
// wrong in opposite directions: a rollup that skips boxes loses their history
// permanently, and a retention sweep that misses rows grows a table nothing ever
// shrinks.
describe("rolling samples up into hours", () => {
	const HOUR = 60 * 60 * 1000;
	const hourStart = Math.floor(NOW / HOUR) * HOUR - HOUR;

	async function boxWithSamples(
		t: Harness,
		values: number[],
		seed: { at?: number[]; status?: Doc<"boxes">["status"]; slug?: string } = {}
	) {
		const owner = await seedUser(t, {
			clerkUserId: `user_${seed.slug ?? "atlas"}`
		});
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: seed.slug ?? "atlas",
			status: seed.status ?? "running"
		});
		await t.run(async (ctx) => {
			for (const [index, value] of values.entries()) {
				await ctx.db.insert("box_metrics", {
					box_id: boxId,
					sampled_at: seed.at?.[index] ?? hourStart + index * 60_000,
					cpu_percent: value,
					ingress_bps: value,
					egress_bps: value,
					ingress_pps: value,
					egress_pps: value,
					disk_read_bps: value,
					disk_write_bps: value
				});
			}
		});
		return boxId;
	}

	const rollups = (t: Harness) =>
		t.run((ctx) => ctx.db.query("box_metrics_hourly").collect());

	// The walk handles one status per transaction and schedules itself for the
	// next, so a box is only reached once those continuations have run. Rolling
	// up one status and stopping is what the continuation exists to prevent.
	// The walk handles one status per transaction and schedules the next, so it is
	// a chain as long as the status union - and `finishInProgressScheduledFunctions`
	// runs one link of it. Draining once reaches the second status and stops,
	// which is exactly the bug the continuation exists to prevent, so the whole
	// chain is walked here.
	async function rollup(t: Harness) {
		await t.mutation(internal.boxes.metrics.rollupHourlyMetrics, {});
		// Each link schedules the next with `runAfter(0)`, which a frozen clock
		// never reaches - so the chain is driven by advancing timers, not by
		// waiting on the jobs already in flight.
		await t.finishAllScheduledFunctions(vi.runAllTimers);
	}

	test("averages an hour of samples into one row", async () => {
		const t = testConvex();
		const boxId = await boxWithSamples(t, [10, 20, 30]);

		await rollup(t);

		expect(await rollups(t)).toMatchObject([
			{ box_id: boxId, hour_start: hourStart, sample_count: 3, cpu_percent: 20 }
		]);
	});

	// Every status but `deleted`, read from the schema rather than listed - which
	// is how `repair_failed` came to be missing and its boxes silently skipped.
	test.each(["running", "stopped", "repair_failed", "update_failed"] as const)(
		"rolls up a %s box",
		async (status) => {
			const t = testConvex();
			await boxWithSamples(t, [10], { status });

			await rollup(t);

			expect(await rollups(t)).toHaveLength(1);
		}
	);

	// Idempotent: the cron can be re-driven, and a second row for the same hour
	// would double-count that box in every chart that reads it.
	test("writes one row per box per hour however often it runs", async () => {
		const t = testConvex();
		await boxWithSamples(t, [10, 20]);

		await rollup(t);
		await rollup(t);

		expect(await rollups(t)).toHaveLength(1);
	});

	// Only the hour being rolled. A sample from the hour after belongs to the
	// next run, and averaging it in here would report it twice.
	test("reads only the samples inside the hour it is rolling", async () => {
		const t = testConvex();
		await boxWithSamples(t, [10, 999], {
			at: [hourStart + 1000, hourStart + HOUR + 1000]
		});

		await rollup(t);

		expect(await rollups(t)).toMatchObject([
			{ sample_count: 1, cpu_percent: 10 }
		]);
	});

	// A box with no samples in the hour gets no row at all, rather than a row of
	// zeroes that would read as a box sitting perfectly idle.
	test("writes nothing for a box that reported nothing", async () => {
		const t = testConvex();
		await boxWithSamples(t, []);

		await rollup(t);

		expect(await rollups(t)).toEqual([]);
	});

	// The walk is per status and paged, and it continues itself: a fleet whose
	// first status has boxes must still reach the ones after it.
	test("carries on to the statuses after the one it started with", async () => {
		const t = testConvex();
		await boxWithSamples(t, [10], { slug: "first", status: "running" });
		await boxWithSamples(t, [20], { slug: "second", status: "stopped" });

		await rollup(t);
		await t.finishInProgressScheduledFunctions();

		expect(await rollups(t)).toHaveLength(2);
	});
});

describe("deleting metrics past their retention", () => {
	async function seedOld(
		t: Harness,
		counts: { hourly?: number; raw?: number },
		age: { hourly?: number; raw?: number } = {}
	) {
		const owner = await seedUser(t);
		const boxId = await seedBox(t, { user_id: owner.clerkUserId });
		await t.run(async (ctx) => {
			for (let index = 0; index < (counts.raw ?? 0); index += 1) {
				await ctx.db.insert("box_metrics", {
					box_id: boxId,
					sampled_at: NOW - (age.raw ?? RAW_RETENTION_MS + 1),
					cpu_percent: 1,
					ingress_bps: 1,
					egress_bps: 1,
					ingress_pps: 1,
					egress_pps: 1,
					disk_read_bps: 1,
					disk_write_bps: 1
				});
			}
			for (let index = 0; index < (counts.hourly ?? 0); index += 1) {
				await ctx.db.insert("box_metrics_hourly", {
					box_id: boxId,
					hour_start: NOW - (age.hourly ?? ROLLUP_RETENTION_MS + 1),
					sample_count: 1,
					cpu_percent: 1,
					ingress_bps: 1,
					egress_bps: 1,
					ingress_pps: 1,
					egress_pps: 1,
					disk_read_bps: 1,
					disk_write_bps: 1
				});
			}
		});
		return boxId;
	}

	const counts = (t: Harness) =>
		t.run(async (ctx) => ({
			hourly: (await ctx.db.query("box_metrics_hourly").collect()).length,
			raw: (await ctx.db.query("box_metrics").collect()).length
		}));

	test("removes raw samples and hourly rows past their own windows", async () => {
		const t = testConvex();
		await seedOld(t, { raw: 2, hourly: 2 });

		await t.mutation(internal.boxes.metrics.deleteOldSamples, {});

		expect(await counts(t)).toEqual({ hourly: 0, raw: 0 });
	});

	// The two windows are different lengths on purpose: the rollup is what the
	// chart falls back to once the raw samples are gone, so a sweep that applied
	// the raw window to both would take the history with it.
	test("keeps hourly rows that are older than the raw window", async () => {
		const t = testConvex();
		await seedOld(t, { raw: 1, hourly: 1 }, { hourly: RAW_RETENTION_MS + 1 });

		await t.mutation(internal.boxes.metrics.deleteOldSamples, {});

		expect(await counts(t)).toEqual({ hourly: 1, raw: 0 });
	});

	test("keeps everything still inside its window", async () => {
		const t = testConvex();
		await seedOld(t, { raw: 1, hourly: 1 }, { raw: 1000, hourly: 1000 });

		await t.mutation(internal.boxes.metrics.deleteOldSamples, {});

		expect(await counts(t)).toEqual({ hourly: 1, raw: 1 });
	});

	// Bounded per transaction and re-driven, so a fleet with more than one batch
	// of expired rows is still fully swept rather than shrinking by one batch a
	// day for ever.
	test("comes back for the rest when it fills a batch", async () => {
		const t = testConvex();
		await seedOld(t, { raw: 1000 });

		await t.mutation(internal.boxes.metrics.deleteOldSamples, {});

		expect(
			await scheduledJobs(t, "boxes/metrics:deleteOldSamples")
		).toHaveLength(1);
	});

	test("stops when it did not fill a batch", async () => {
		const t = testConvex();
		await seedOld(t, { raw: 2 });

		await t.mutation(internal.boxes.metrics.deleteOldSamples, {});

		expect(await scheduledJobs(t, "boxes/metrics:deleteOldSamples")).toEqual(
			[]
		);
	});
});

// A chart is read left to right in time, and the query that feeds it reads the
// newest rows first because that is the only way to bound what it takes. The
// series it hands back has to be put back in order, or every chart on the box
// page runs backwards - which looks like a plausible chart, not like a bug.
describe("the order a chart's series comes back in", () => {
	async function seedHours(t: Harness, boxId: Id<"boxes">, count: number) {
		await t.run(async (ctx) => {
			for (let index = 0; index < count; index += 1) {
				await ctx.db.insert("box_metrics_hourly", {
					...READING,
					box_id: boxId,
					cpu_percent: index,
					hour_start: NOW - (count - index) * HOUR,
					sample_count: 6
				});
			}
		});
	}

	async function seedRaw(t: Harness, boxId: Id<"boxes">, count: number) {
		await t.run(async (ctx) => {
			for (let index = 0; index < count; index += 1) {
				await ctx.db.insert("box_metrics", {
					...READING,
					box_id: boxId,
					cpu_percent: index,
					sampled_at: NOW - (count - index) * 60_000
				});
			}
		});
	}

	test("hands back raw samples oldest first", async () => {
		const t = testConvex();
		await seedSettings(t);
		const boxId = await seedBox(t, { user_id: "owner" });
		await seedRaw(t, boxId, 5);

		const samples = await t.run((ctx) => boxMetricsSamples(ctx, boxId, "1h"));

		expect(samples.map((sample) => sample.cpuPercent)).toEqual([0, 1, 2, 3, 4]);
	});

	test("hands back hourly samples oldest first", async () => {
		const t = testConvex();
		await seedSettings(t);
		const boxId = await seedBox(t, { user_id: "owner" });
		await seedHours(t, boxId, 5);

		const samples = await t.run((ctx) => boxMetricsSamples(ctx, boxId, "30d"));

		expect(samples.map((sample) => sample.cpuPercent)).toEqual([0, 1, 2, 3, 4]);
	});

	// The bound has to cover the window it was asked for. A week holds 168
	// hourly rows, and a ceiling below that returns a chart that starts partway
	// through the week with no sign that anything is missing.
	test("covers a whole week of hourly rows", async () => {
		const t = testConvex();
		await seedSettings(t);
		const boxId = await seedBox(t, { user_id: "owner" });
		await seedHours(t, boxId, 168);

		const samples = await t.run((ctx) => boxMetricsSamples(ctx, boxId, "7d"));

		expect(samples).toHaveLength(168);
		expect(samples[0]?.cpuPercent).toBe(0);
	});

	// The same for the raw series: an hour holds six ten-minute samples, and the
	// bound is generous on purpose because polls can land closer together.
	test("covers a whole hour of raw samples however densely they landed", async () => {
		const t = testConvex();
		await seedSettings(t);
		const boxId = await seedBox(t, { user_id: "owner" });
		await seedRaw(t, boxId, 12);

		const samples = await t.run((ctx) => boxMetricsSamples(ctx, boxId, "1h"));

		expect(samples).toHaveLength(12);
	});
});

// The rollup walks every box status in turn, a page at a time. Two things make
// it finish: the cursor that gets it to the next page, and the index that gets
// it to the next status.
describe("walking the fleet to roll its metrics up", () => {
	const rollup = (t: Harness, args: object = {}) =>
		t.mutation(internal.boxes.metrics.rollupHourlyMetrics, args);

	async function boxWithSamples(t: Harness, status: Doc<"boxes">["status"]) {
		const hourStart = Math.floor(NOW / HOUR) * HOUR - HOUR;
		const boxId = await seedBox(t, { user_id: "owner", status, slug: status });
		await t.run(async (ctx) => {
			await ctx.db.insert("box_metrics", {
				...READING,
				box_id: boxId,
				cpu_percent: 50,
				sampled_at: hourStart + 60_000
			});
		});
		return { boxId, hourStart };
	}

	// Every status but `deleted` is walked, so a box that was stopped for the
	// hour still gets its rollup - and a chart of a stopped box is not a gap.
	test("rolls up a box that was not running", async () => {
		const t = testConvex();
		await seedSettings(t);
		const { boxId, hourStart } = await boxWithSamples(t, "stopped");

		// Driven by index rather than by draining the scheduler, so the test does
		// not depend on where `stopped` happens to sit in the status list.
		for (let statusIndex = 0; statusIndex < 20; statusIndex += 1) {
			await rollup(t, { hourStart, statusIndex });
		}

		expect(
			await t.run((ctx) => ctx.db.query("box_metrics_hourly").collect())
		).toMatchObject([
			{ box_id: boxId, hour_start: hourStart, cpu_percent: 50 }
		]);
	});

	// The walk moves to the next status when a page is done, and stops when the
	// statuses run out - a walk that never advanced would roll up one status for
	// ever and never reach the rest.
	test("moves on to the next status when a page is finished", async () => {
		const t = testConvex();
		await seedSettings(t);

		await rollup(t);

		expect(
			await scheduledArgs<{ statusIndex: number }>(
				t,
				"boxes/metrics:rollupHourlyMetrics"
			)
		).toMatchObject([{ statusIndex: 1 }]);
	});

	test("stops once it has walked every status", async () => {
		const t = testConvex();
		await seedSettings(t);

		await rollup(t, { statusIndex: 99 });

		expect(await scheduledJobs(t, "boxes/metrics:rollupHourlyMetrics")).toEqual(
			[]
		);
	});

	// The hour being rolled up travels with the walk. Reading it again on the
	// next page would roll different boxes into different hours whenever a walk
	// crosses an hour boundary.
	test("carries the hour it started with to the next status", async () => {
		const t = testConvex();
		await seedSettings(t);

		await rollup(t, { hourStart: NOW - 5 * HOUR });

		expect(
			await scheduledArgs<{ hourStart: number }>(
				t,
				"boxes/metrics:rollupHourlyMetrics"
			)
		).toMatchObject([{ hourStart: NOW - 5 * HOUR }]);
	});

	// A box already rolled up for the hour is left alone, so a re-run of the
	// walk cannot double-count an hour.
	test("does not roll the same hour up twice", async () => {
		const t = testConvex();
		await seedSettings(t);
		const { hourStart } = await boxWithSamples(t, "running");
		for (let statusIndex = 0; statusIndex < 20; statusIndex += 1) {
			await rollup(t, { hourStart, statusIndex });
		}

		for (let statusIndex = 0; statusIndex < 20; statusIndex += 1) {
			await rollup(t, { hourStart, statusIndex });
		}

		expect(
			await t.run((ctx) => ctx.db.query("box_metrics_hourly").collect())
		).toHaveLength(1);
	});

	// An hour a box recorded nothing in is a gap, not a row of zeroes.
	test("writes no row for an hour a box recorded nothing in", async () => {
		const t = testConvex();
		await seedSettings(t);
		await seedBox(t, { user_id: "owner", status: "running" });

		for (let statusIndex = 0; statusIndex < 20; statusIndex += 1) {
			await rollup(t, { hourStart: NOW - 5 * HOUR, statusIndex });
		}

		expect(
			await t.run((ctx) => ctx.db.query("box_metrics_hourly").collect())
		).toEqual([]);
	});
});

// The rollup is bounded per transaction, so a fleet larger than one page is
// walked across several. The cursor is the whole of what makes the second page
// different from the first: without it the walk re-does page one for ever and
// every box past it never gets an hourly row - which shows up months later as a
// 30-day chart with nothing on it.
describe("rolling up a fleet larger than one page", () => {
	const rollup = (t: Harness, args: object = {}) =>
		t.mutation(internal.boxes.metrics.rollupHourlyMetrics, args);
	const hourStart = () => Math.floor(NOW / HOUR) * HOUR - HOUR;

	// One more than the page, so exactly one box is left for the second page and
	// its hourly row is the proof the walk got there.
	async function fleet(t: Harness, count: number) {
		await t.run(async (ctx) => {
			for (let index = 0; index < count; index += 1) {
				const boxId = await ctx.db.insert("boxes", {
					user_id: "owner",
					slug: `box-${index}`,
					plan: "air",
					manual_snapshot_cap: 0,
					status: "running",
					created_at: 1,
					updated_at: 1
				});
				await ctx.db.insert("box_metrics", {
					...READING,
					box_id: boxId,
					cpu_percent: 50,
					sampled_at: hourStart() + 60_000
				});
			}
		});
	}

	async function statusIndexOfRunning(t: Harness) {
		// Found rather than assumed: the walk's order is the schema's status
		// order, and a status added to that union would shift it.
		for (let statusIndex = 0; statusIndex < 20; statusIndex += 1) {
			await rollup(t, { hourStart: hourStart(), statusIndex });
			const rows = await t.run((ctx) =>
				ctx.db.query("box_metrics_hourly").collect()
			);
			if (rows.length > 0) return statusIndex;
		}
		throw new Error("no status index rolled anything up");
	}

	test("comes back for the boxes past the first page", async () => {
		const t = testConvex();
		await seedSettings(t);
		await fleet(t, 201);

		const statusIndex = await statusIndexOfRunning(t);
		// The walk queued a job for each status it finished on the way here; the
		// one that matters is the unfinished page it left behind.
		const next = (
			await scheduledArgs<{
				cursor?: string | null;
				hourStart: number;
				statusIndex: number;
			}>(t, "boxes/metrics:rollupHourlyMetrics")
		).find((job) => job.cursor);
		expect(next).toMatchObject({ hourStart: hourStart(), statusIndex });
		expect(next?.cursor).toEqual(expect.any(String));

		await rollup(t, next);

		expect(
			await t.run((ctx) => ctx.db.query("box_metrics_hourly").collect())
		).toHaveLength(201);
	});

	// The last status is the end of the walk. Scheduling one more job past it
	// would be an hourly no-op for ever, and a walk that stepped backwards would
	// never end at all.
	test("stops after the last status rather than stepping past it", async () => {
		const t = testConvex();
		await seedSettings(t);
		const statuses = boxStatusesExcept("deleted");

		await rollup(t, {
			hourStart: hourStart(),
			statusIndex: statuses.length - 1
		});

		expect(await scheduledJobs(t, "boxes/metrics:rollupHourlyMetrics")).toEqual(
			[]
		);
	});

	test("steps forward from the status before the last", async () => {
		const t = testConvex();
		await seedSettings(t);
		const statuses = boxStatusesExcept("deleted");

		await rollup(t, {
			hourStart: hourStart(),
			statusIndex: statuses.length - 2
		});

		expect(
			await scheduledArgs<{ statusIndex: number }>(
				t,
				"boxes/metrics:rollupHourlyMetrics"
			)
		).toMatchObject([{ statusIndex: statuses.length - 1 }]);
	});
});

// The alerts a flag raises, and the window the samples for it are read over.
describe("what a flag tells staff", () => {
	const OVER_BANDWIDTH = 500_000_000;
	const OVER_PPS = 100_000;

	async function runningBox(t: Harness) {
		const owner = await seedUser(t);
		return await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas",
			status: "running"
		});
	}

	const poll = (t: Harness, boxId: Id<"boxes">, both = false) =>
		t.mutation(internal.boxes.metrics.recordSample, {
			boxId,
			cpuPercent: 1,
			ingressBps: 1,
			egressBps: OVER_BANDWIDTH,
			ingressPps: 1,
			egressPps: both ? OVER_PPS : 1,
			diskReadBps: 1,
			diskWriteBps: 1
		});

	// Two signals crossing at once are two problems, and an alert key that did
	// not name the flag would collapse them into one - so the second signal
	// would be raised once and never again for any box.
	test("raises one alert per flag, not one per box", async () => {
		const t = testConvex();
		await seedSettings(t);
		const boxId = await runningBox(t);

		for (let index = 0; index < 4; index += 1) await poll(t, boxId, true);

		const alerts = await staffAlerts(t);
		expect(alerts.length).toBeGreaterThan(1);
		expect(new Set(alerts.map((alert) => alert.key)).size).toBe(alerts.length);
		expect(alerts.every((alert) => alert.key.startsWith("box-flag:"))).toBe(
			true
		);
	});

	// The sentence about suspension belongs only to an alert whose box was
	// actually suspended. A deployment with automatic suspension off must not
	// tell staff a box was suspended when it is still serving.
	test("does not claim a box was suspended when it was not", async () => {
		const t = testConvex();
		await seedSettings(t, { auto_suspend_enabled: false });
		const boxId = await runningBox(t);

		for (let index = 0; index < 4; index += 1) await poll(t, boxId);

		// The problem and where to look, and nothing between them: a sentence
		// about a suspension that did not happen would sit right here.
		const [alert] = await staffAlerts(t);
		expect(alert?.text.split("\n\n")[1]).toMatch(/^https?:/);
		expect(alert?.text).not.toContain("suspended");
		expect(alert?.severity).toBe("warning");
	});

	test("says so when the box was suspended", async () => {
		const t = testConvex();
		await seedSettings(t, { auto_suspend_enabled: true });
		const boxId = await runningBox(t);

		for (let index = 0; index < 4; index += 1) await poll(t, boxId);

		const [alert] = await staffAlerts(t);
		expect(alert?.text).toContain("automatically suspended");
		expect(alert?.severity).toBe("critical");
	});

	// The samples are read once for every threshold, so the read has to cover
	// the longest window any of them needs. Reading the shortest instead would
	// leave a slow-burning threshold permanently one sample short of crossing.
	test("reads enough samples for the most patient threshold", async () => {
		const t = testConvex();
		await seedSettings(t, {
			thresholds: [
				{ signal: "egress_bandwidth", value: 1, sustained_samples: 6 },
				{ signal: "egress_pps", value: 1_000_000_000, sustained_samples: 1 }
			]
		});
		const boxId = await runningBox(t);

		for (let index = 0; index < 6; index += 1) await poll(t, boxId);

		expect(
			await t.run((ctx) => ctx.db.query("box_flags").collect())
		).toMatchObject([{ signal: "egress_bandwidth" }]);
	});
});

// The retention sweep deletes from two tables and comes back while either is
// still full. A fleet's rollups outlast its raw samples by four weeks, so the
// rollup table is the one that keeps a sweep going after the raw one is drained
// - and a sweep that only watched the raw table would delete one batch a day
// for ever while reporting success.
describe("a retention sweep with more rollups than one batch", () => {
	test("comes back while the rollup table is still full", async () => {
		const t = testConvex();
		const boxId = await seedBox(t, { user_id: "owner" });
		await t.run(async (ctx) => {
			for (let index = 0; index < 1000; index += 1) {
				await ctx.db.insert("box_metrics_hourly", {
					...READING,
					box_id: boxId,
					hour_start: NOW - 60 * 24 * HOUR - index * HOUR,
					sample_count: 6
				});
			}
		});

		await t.mutation(internal.boxes.metrics.deleteOldSamples, {});

		expect(
			await scheduledJobs(t, "boxes/metrics:deleteOldSamples")
		).toHaveLength(1);
	});

	test("stops when neither table filled its batch", async () => {
		const t = testConvex();
		const boxId = await seedBox(t, { user_id: "owner" });
		await t.run(async (ctx) => {
			await ctx.db.insert("box_metrics_hourly", {
				...READING,
				box_id: boxId,
				hour_start: NOW - 60 * 24 * HOUR,
				sample_count: 6
			});
		});

		await t.mutation(internal.boxes.metrics.deleteOldSamples, {});

		expect(await scheduledJobs(t, "boxes/metrics:deleteOldSamples")).toEqual(
			[]
		);
	});
});
