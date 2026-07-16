import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
	internalAction,
	internalMutation,
	internalQuery,
	type DatabaseReader,
	type MutationCtx
} from "../_generated/server";
import { consoleBoxPath } from "../model/box/path";
import { staffConsoleUrl } from "../env";
import { raiseAlert } from "../staff/alerts";
import { sendOwnerNotice } from "../notice/owner";
import {
	USAGE_FULL_STEP,
	USAGE_SIGNALS,
	formatBytes,
	planTrafficAllowanceBytes,
	trafficAllowanceGap,
	usagePercent,
	usageStepReached,
	type UsageSignal,
	type UsageStep
} from "../model/box/usage";
import { BOX_PLANS } from "../model/box/plan";

// What a box has run out of, and who is told.
//
// Reading is split by where the answer comes from and nothing else: the
// provider knows the traffic, the host knows the disk, and each has its own
// entry point below saying so in its own arguments. What they share - when a
// crossing is worth telling somebody about - is one function, because that is
// the part with a judgement in it and a second copy of it would be a second
// answer to "have they already been told".

const DISK_SWEEP_PAGE_SIZE = 200;
// How many hosts are asked at once. An SSH round trip is far more expensive than
// the provider's HTTP one, so this is deliberately below the metrics poll's
// concurrency: the sweep has an hour to finish, not ten minutes.
const DISK_SWEEP_CONCURRENCY = 5;

// One staff alert per box per signal per calendar month.
//
// The month is in the key rather than a timestamp, because `raiseAlert`
// deduplicates by key for the life of the row: a key without a period in it
// would report a full disk once and then stay silent through every later month
// it stayed full, which is the shape this repository calls silent success. The
// month is also the period the provider resets traffic on, so for the signal
// that resets the bucket and the counter agree.
export function usageAlertKey(
	boxId: Id<"boxes">,
	signal: UsageSignal,
	at: number
) {
	const month = new Date(at).toISOString().slice(0, 7);
	return `box-usage:${signal}:${boxId}:${month}`;
}

export type UsageRecord = {
	// The step the box now stands at, which is what gets stored. It is the whole
	// state: a step below the recorded one clears the way for that step to be
	// announced again, and that single rule is also how a provider counter
	// resetting at the start of a billing month is handled - a counter that went
	// down is no longer at the level the owner was told about.
	step: UsageStep | null;
	// Whether this crossing is new, which is the only thing that sends anything.
	announce: boolean;
};

// The decision, as a pure function of the two numbers and what was last said.
export function usageCrossing(
	previousStep: number | null | undefined,
	percent: number | null
): UsageRecord {
	const step = usageStepReached(percent);
	if (step === null) return { step: null, announce: false };
	const previous = previousStep ?? null;
	// The null arm is written out because it is the case this function exists for -
	// nobody has been told anything yet - but it cannot be observed separately:
	// every step is a positive number, and `step > null` coerces to `step > 0`,
	// which is already true. So the mutant that drops it agrees with it on every
	// input, and killing it would take a test asserting a thing JavaScript does
	// rather than a thing this decides.
	// Stryker disable next-line ConditionalExpression: `step > null` is `step > 0` and every step is positive, so both arms answer alike.
	return { step, announce: previous === null || step > previous };
}

async function usageRow(
	db: DatabaseReader,
	boxId: Id<"boxes">,
	signal: UsageSignal
) {
	return await db
		.query("box_usage")
		.withIndex("box_id_signal", (query) =>
			query.eq("box_id", boxId).eq("signal", signal)
		)
		.first();
}

// Store a reading, and tell the owner if it has crossed a step it had not
// crossed before.
//
// The order matters and is the same one every lifecycle mutation here follows:
// the row is written first, so a notice that fails to send cannot leave the
// deployment believing it never took the reading. `sendOwnerNotice` never
// throws, which is what makes that safe rather than merely assumed.
async function recordUsage(
	ctx: MutationCtx,
	box: Doc<"boxes">,
	signal: UsageSignal,
	usedBytes: number,
	allowanceBytes: number
) {
	const existing = await usageRow(ctx.db, box._id, signal);
	const now = Date.now();
	const percent = usagePercent(usedBytes, allowanceBytes);
	const { step, announce } = usageCrossing(existing?.noticed_step, percent);

	// A counter that went down has rolled over into a new period - but only for a
	// signal that has periods. `USAGE_SIGNALS[signal].resets` says which do, and
	// asking it first is what stops a disk emptied by a `docker prune` from being
	// recorded as the start of a billing month.
	const reset =
		USAGE_SIGNALS[signal].resets &&
		existing !== null &&
		usedBytes < existing.used_bytes;

	const row = {
		box_id: box._id,
		signal,
		used_bytes: usedBytes,
		allowance_bytes: allowanceBytes,
		noticed_step: step ?? undefined,
		counter_reset_at: reset ? now : existing?.counter_reset_at,
		sampled_at: now
	};
	if (existing) {
		await ctx.db.patch(existing._id, row);
	} else {
		await ctx.db.insert("box_usage", row);
	}

	// `usageCrossing` never announces without a step, so the second test is the
	// type checker's rather than a case that happens: it is what narrows `step`
	// from `UsageStep | null` to `UsageStep` for the notice below. Kept rather
	// than asserted around, because a non-null assertion here would be a claim
	// nothing checks again once that function changes.
	// Stryker disable next-line ConditionalExpression: an announced crossing always carries a step, so this arm is unreachable.
	if (!announce || step === null) return;

	await sendOwnerNotice(ctx, box, {
		type: "usage",
		signal,
		step,
		usedBytes,
		allowanceBytes
	});

	// Staff hear only about the top step. The first one is the owner's to act on
	// and there is nothing for a person here to do about it; the second means the
	// allowance is gone, which for traffic is a bill and for a disk is a box about
	// to start failing operations.
	if (step !== USAGE_FULL_STEP) return;
	await raiseAlert(ctx, {
		key: usageAlertKey(box._id, signal, now),
		severity: "warning",
		subject: `Box ${box.slug} has used ${step}% of its ${USAGE_SIGNALS[
			signal
		].label.toLowerCase()}`,
		text: `Box ${box.slug} (${box._id}) has used ${formatBytes(
			usedBytes
		)} of ${formatBytes(allowanceBytes)}.\n\n${
			USAGE_SIGNALS[signal].consequence
		}\n\nThe owner has been emailed. Nothing is suspended or throttled automatically for this - the abuse thresholds handle a box behaving badly right now, and an allowance quietly spent over a month is a conversation rather than an incident.\n\n${staffConsoleUrl(
			consoleBoxPath(box._id)
		)}`
	});
}

// -- Traffic ----------------------------------------------------------------

// Outbound bytes this billing period, as the provider counts them.
//
// It records and nothing else. Whether the machine behind a plan includes as much
// as that plan sells is a question about the catalogue rather than about this
// box, it has the same answer for every box on the type, and it changes about
// never - so it is asked once a day by `boxes/reconcile.ts` rather than by every
// box on every poll. This path stays a recording.
export const recordTrafficUsage = internalMutation({
	args: {
		boxId: v.id("boxes"),
		outgoingBytes: v.number()
	},
	handler: async (ctx, args) => {
		const box = await ctx.db.get(args.boxId);
		if (!box) return;

		const allowance = planTrafficAllowanceBytes(box.plan);
		await recordUsage(ctx, box, "traffic", args.outgoingBytes, allowance);
	}
});

// The catalogue audit: does the machine behind each plan include as much traffic
// as that plan sells?
//
// Raised from the daily reconciliation rather than from the poll, because it is a
// fact about a server type and not about any box - so asking it once a day covers
// the whole fleet, including plans that happen to have no running box today, and
// the poll goes back to being a recording.
//
// Keyed by the type and the figure reported, so a second type - or the same type
// drifting to a different figure - is a second alert rather than one swallowed by
// the first.
export const alertTrafficAllowanceGap = internalMutation({
	args: {
		serverType: v.string(),
		includedBytes: v.number()
	},
	handler: async (ctx, args) => {
		const gap = trafficAllowanceGap(args.serverType, args.includedBytes);
		if (!gap) return;

		const { plan, allowanceBytes, includedBytes } = gap;
		await raiseAlert(ctx, {
			key: `usage-allowance:${args.serverType}:${includedBytes}`,
			severity: "critical",
			subject: `${BOX_PLANS[plan].label} sells more traffic than its machine includes`,
			text: `${BOX_PLANS[plan].label} publishes ${formatBytes(
				allowanceBytes
			)} of outbound traffic a month, but ${
				args.serverType
			} reports only ${formatBytes(
				includedBytes
			)} included.\n\nEvery box on this plan can therefore stay inside its published allowance and still be billed for the excess, so no box's own meter will ever show this.\n\nEither lower trafficTb in convex/model/box/plan.ts - which is a change to what the plan sells, so it needs a pricing-page update and a legal notice - or move the plan to a machine that includes what it sells.`
		});
	}
});

// -- Disk -------------------------------------------------------------------

export const recordDiskUsage = internalMutation({
	args: {
		boxId: v.id("boxes"),
		usedBytes: v.number(),
		totalBytes: v.number()
	},
	handler: async (ctx, args) => {
		const box = await ctx.db.get(args.boxId);
		if (!box) return;
		// The filesystem's own size, not the plan's advertised disk. They differ by
		// the image and by what the filesystem keeps for itself, and an owner watching
		// a meter fill needs it to reach the end when their disk does.
		await recordUsage(ctx, box, "disk", args.usedBytes, args.totalBytes);
	}
});

// Running boxes only. A stopped box has a powered-off host, so asking it would
// fail; a suspended one is powered off too. Either would replace a real reading
// with nothing, so neither is asked and the last reading stands with its own
// timestamp beside it.
export const diskSweepTargetsPage = internalQuery({
	args: { cursor: v.union(v.string(), v.null()) },
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query("boxes")
			.withIndex("status", (query) => query.eq("status", "running"))
			.paginate({ cursor: args.cursor, numItems: DISK_SWEEP_PAGE_SIZE });
		return {
			...page,
			page: page.page.map((box) => ({ boxId: box._id, slug: box.slug }))
		};
	}
});

type DiskSweepTarget = { boxId: Id<"boxes">; slug: string };

type DiskSweepPage = {
	continueCursor: string;
	isDone: boolean;
	page: DiskSweepTarget[];
};

// A list in runs of at most `size`, covering every item exactly once and in
// order. Pure, so what the sweep does concurrently is decided by something with
// a right answer rather than by index arithmetic nothing can check.
export function batches<T>(items: readonly T[], size: number): T[][] {
	const runs: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		runs.push(items.slice(index, index + size));
	}
	return runs;
}

// Ask every running box how full its disk is.
//
// Hourly rather than on the metrics interval, and that is a cost decision with a
// reason: this is the only sweep in the deployment that opens an SSH connection
// per box, which is far more expensive than the provider's HTTP call the
// metrics poll makes. A disk fills over hours, so a reading up to an hour old
// answers the question just as well - and the box page says when it was taken
// rather than implying it is live.
//
// One box failing never stops the rest, for the same reason the metrics poll
// says so: this runs unattended, and a single unreachable host must not mean the
// fleet stops being measured.
export const sweepBoxDiskUsage = internalAction({
	args: {},
	handler: async (ctx) => {
		let cursor: string | null = null;
		for (;;) {
			const page: DiskSweepPage = await ctx.runQuery(
				internal.boxes.usage.diskSweepTargetsPage,
				{ cursor }
			);

			// The batching is a rate limit on how many hosts are asked at once, and a
			// rate limit has no observable answer: recording is an upsert keyed by box
			// and signal, so a batch that ran wide, ran twice, or ran one slice too
			// many leaves exactly the same rows behind.
			//
			// So `batches` is a named function tested on its own rather than index
			// arithmetic inline. That is not decoration: the arithmetic version put its
			// bound inside a multi-line `for` header, where a `Stryker disable
			// next-line` cannot reach the line the mutant lands on - a suppression that
			// reads as deliberate and does nothing. Splitting the list is a pure
			// function with a right answer, and it is checked like one.
			for (const batch of batches(page.page, DISK_SWEEP_CONCURRENCY)) {
				await Promise.all(
					batch.map(async (target) => {
						try {
							const disk = await ctx.runAction(
								internal.boxes.infra.host.inspectDiskUsage,
								{ boxId: target.boxId }
							);
							// A host that could not be read reports null rather than zero, and
							// nothing is stored: the last real reading stays on the page with
							// its own timestamp, which is a truthful "this is what we last
							// saw" instead of an empty disk nobody has.
							//
							// Dropping this guard reads `null.usedBytes`, which throws into the
							// catch below and also stores nothing - so the row is untouched
							// either way and no assertion can tell the two apart. The guard is
							// still the right code: one of those paths is a decision and the
							// other is an exception the sweep merely survives.
							// Stryker disable next-line ConditionalExpression: without it the read throws into the catch, which also stores nothing.
							if (!disk) return;
							await ctx.runMutation(internal.boxes.usage.recordDiskUsage, {
								boxId: target.boxId,
								usedBytes: disk.usedBytes,
								totalBytes: disk.totalBytes
							});
						} catch (error) {
							console.error(
								`Disk usage sweep failed for box ${target.slug}.`,
								error
							);
						}
					})
				);
			}

			// Paging out of a page size of 200 needs a fleet of more than 200 running
			// boxes to observe, which is a fixture no behaviour test should stand up to
			// assert a `for(;;)` continues.
			// Stryker disable next-line ConditionalExpression: one page holds 200 boxes, so no affordable fixture reaches a second one.
			if (page.isDone) return;
			cursor = page.continueCursor;
		}
	}
});

// -- Reading ----------------------------------------------------------------

export type BoxUsageView = {
	signal: UsageSignal;
	usedBytes: number;
	allowanceBytes: number;
	// Derived here rather than stored, so the number the meter draws and the
	// number the notice was decided from come from one place.
	percent: number | null;
	sampledAt: number;
	counterResetAt: number | null;
};

// A box's usage, in the order `USAGE_SIGNALS` declares. A signal never sampled
// is absent rather than zero - "we have not measured this yet" and "this box is
// using nothing" are different facts, and only one of them makes the box look
// fine.
export async function boxUsage(
	db: DatabaseReader,
	boxId: Id<"boxes">
): Promise<BoxUsageView[]> {
	const rows = await db
		.query("box_usage")
		.withIndex("box_id_signal", (query) => query.eq("box_id", boxId))
		.collect();

	return (Object.keys(USAGE_SIGNALS) as UsageSignal[]).flatMap((signal) => {
		const row = rows.find((candidate) => candidate.signal === signal);
		if (!row) return [];
		return [
			{
				signal,
				usedBytes: row.used_bytes,
				allowanceBytes: row.allowance_bytes,
				percent: usagePercent(row.used_bytes, row.allowance_bytes),
				sampledAt: row.sampled_at,
				counterResetAt: row.counter_reset_at ?? null
			}
		];
	});
}
