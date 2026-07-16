import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
	internalAction,
	internalMutation,
	internalQuery
} from "../_generated/server";
import { consoleBoxPath } from "../model/box/path";
import { staffConsoleUrl } from "../env";
import { raiseAlert } from "../staff/alerts";
import { isSystemTrigger, type OperationTrigger } from "../schema";
import { type BoxStatus } from "../model/box/status";
import { startBoxOperation } from "./operation/start";
import { isOperationAllowed, BOX_OPERATIONS } from "../model/box/operation";
import { DAY_MS, HOUR_MS } from "../time";

// Automatic repair: the fleet heals a box that has stopped serving, without its
// owner having to notice and press Repair.
//
// The whole design problem here is that a Composery box is a root-capable
// machine its owner is *supposed* to break. "Not serving" is a normal state for
// someone mid-experiment, so an unconditional healer would fight the owner,
// destroy work in progress, and burn a Hetzner volume per cycle doing it. Every
// constant below exists to make automatic repair rare, late, and bounded, and to
// keep the owner's own hand on the box strictly ahead of ours.

// How many consecutive failed health probes before a box counts as down. The
// sweep runs on the metrics poll interval (`METRICS_POLL_INTERVAL_MINUTES`), so
// at ten minutes this is roughly half an hour of a box not answering - long
// enough that a restart, a slow boot, or a blip has passed.
// window: Consecutive failures before repair
export const SUSTAINED_FAILURES = 3;

// How long after any operation a *person* started automatic repair stays out of
// the way. Someone who just pressed Stop, Reset, Update, or changed
// configuration is working on this box; healing it under them would undo what
// they are doing and look like the product fighting them.
//
// Operations the fleet started itself do not count - see `AutoRepairFacts`.
// window: Automatic repair quiet window
export const OWNER_QUIET_WINDOW_MS = 2 * HOUR_MS;

// Ceiling on automatic repairs per box per window. A box that needs a third
// repair in a day is not having a bad night - either the owner is breaking it
// deliberately or something is wrong that repair does not fix. Both are cases
// for a person to look at, not for the fleet to keep rebuilding hosts: each
// repair creates and deletes a Hetzner Volume and takes the box down while it
// runs, so an unbounded healer is also an unbounded bill.
//
// Both halves carry the same window label because the operator reads them as
// one sentence ("2 per 24 hours"); the test checks the row states each value.
// window: Automatic repairs per box
export const AUTO_REPAIR_WINDOW_MS = DAY_MS;
// window: Automatic repairs per box
export const MAX_AUTO_REPAIRS_PER_WINDOW = 2;

// Which boxes the health sweep probes: exactly the statuses a repair may begin
// from, read from the table that enforces it rather than restated here.
//
// This used to be `status == "running"` alone, which made four of the five
// statuses in that table unreachable - most importantly `update_failed`, the one
// case the whole rollback-by-repair design exists for. A box left broken by an
// update was never probed, so it never accumulated a failure count, so the gate
// that permits repairing it could not fire. There was a passing test asserting
// that it would.
export const SWEPT_STATUSES: readonly BoxStatus[] = BOX_OPERATIONS.repair.from;

// Recorded on every operation this module starts, and the thing that makes an
// automatic repair distinguishable from one a person asked for - in the event
// log, in support, and in the window count below.
export const AUTO_REPAIR_TRIGGER =
	"system:auto_repair" as const satisfies OperationTrigger;

export type AutoRepairFacts = {
	consecutiveFailures: number;
	// The most recent operation a *person* started on this box inside the quiet
	// window, or null if there was none. Operations the fleet started itself are
	// excluded by `trigger`, not by name: a daily automatic snapshot used to read
	// as "the owner just acted" and suppress repair fleet-wide for two hours every
	// night, and a forced floor update used to suppress it for two hours after
	// exactly the event most likely to have broken the box.
	lastOwnerOperationAt: number | null;
	// Timestamps of automatic repairs already started within the window.
	recentAutoRepairs: readonly number[];
	status: BoxStatus;
};

export type AutoRepairRefusal =
	| "healthy"
	| "not_sustained"
	| "status_not_repairable"
	| "owner_recently_acted"
	| "attempt_limit_reached";

export type AutoRepairDecision =
	| { repair: true }
	| {
			repair: false;
			// Why not, for the staff alert on exhaustion and for tests. Every refusal
			// is a deliberate gate, so each one is named rather than collapsed into a
			// single boolean.
			reason: AutoRepairRefusal;
	  };

// Pure so the whole gate matrix is testable without a database, a host, or a
// clock. Every caller decides from this and nothing else.
export function autoRepairDecision(
	facts: AutoRepairFacts,
	now: number
): AutoRepairDecision {
	if (facts.consecutiveFailures === 0) {
		return { repair: false, reason: "healthy" };
	}
	if (facts.consecutiveFailures < SUSTAINED_FAILURES) {
		return { repair: false, reason: "not_sustained" };
	}
	// Asks the same table `startOperation` enforces, so this can never decide
	// to start a repair the backend will refuse - and, more importantly, never
	// touches a box that is mid-operation or deliberately stopped.
	if (!isOperationAllowed(facts.status, "repair")) {
		return { repair: false, reason: "status_not_repairable" };
	}
	if (
		facts.lastOwnerOperationAt !== null &&
		now - facts.lastOwnerOperationAt < OWNER_QUIET_WINDOW_MS
	) {
		return { repair: false, reason: "owner_recently_acted" };
	}

	const withinWindow = facts.recentAutoRepairs.filter(
		(at) => now - at < AUTO_REPAIR_WINDOW_MS
	);
	if (withinWindow.length >= MAX_AUTO_REPAIRS_PER_WINDOW) {
		return { repair: false, reason: "attempt_limit_reached" };
	}

	return { repair: true };
}

// Record one probe result, returning the running consecutive-failure count. A
// success resets the count to zero rather than decrementing it: the gate is
// "down continuously for N checks", and a box that flaps between reachable and
// unreachable is a different problem that repair would not fix.
export const recordProbe = internalMutation({
	args: {
		boxId: v.id("boxes"),
		reachable: v.boolean()
	},
	returns: v.number(),
	handler: async (ctx, args): Promise<number> => {
		const existing = await ctx.db
			.query("box_health")
			.withIndex("box_id", (query) => query.eq("box_id", args.boxId))
			.first();

		const now = Date.now();
		const consecutiveFailures = args.reachable
			? 0
			: (existing?.consecutive_failures ?? 0) + 1;

		if (existing) {
			await ctx.db.patch(existing._id, {
				consecutive_failures: consecutiveFailures,
				last_ok_at: args.reachable ? now : existing.last_ok_at,
				updated_at: now
			});
		} else {
			await ctx.db.insert("box_health", {
				box_id: args.boxId,
				consecutive_failures: consecutiveFailures,
				last_ok_at: args.reachable ? now : undefined,
				updated_at: now
			});
		}

		return consecutiveFailures;
	}
});

// Everything `autoRepairDecision` needs, read in one query so the decision is
// made against a single consistent view rather than several interleaved reads.
//
// Both operation reads are bounded by time rather than by a row count. They used
// to share one `.take(50)`, which meant a box busy enough to fill that window
// could hide its own earlier auto-repairs and so slip past the attempt limit -
// a truncated read that removed a protection. Each question now asks an index for
// exactly the rows it needs.
export const autoRepairFacts = internalQuery({
	args: { boxId: v.id("boxes") },
	handler: async (ctx, args): Promise<AutoRepairFacts | null> => {
		const box = await ctx.db.get(args.boxId);
		if (!box) return null;

		const health = await ctx.db
			.query("box_health")
			.withIndex("box_id", (query) => query.eq("box_id", args.boxId))
			.first();

		const now = Date.now();

		// Only the quiet window matters: an operation older than it would not hold
		// repair off anyway, so there is no reason to read further back.
		const withinQuietWindow = await ctx.db
			.query("box_operations")
			.withIndex("box_id_created_at", (query) =>
				query
					.eq("box_id", args.boxId)
					.gte("created_at", now - OWNER_QUIET_WINDOW_MS)
			)
			.order("desc")
			.collect();

		const autoRepairs = await ctx.db
			.query("box_operations")
			.withIndex("box_id_type_created_at", (query) =>
				query
					.eq("box_id", args.boxId)
					.eq("type", "repair")
					.gte("created_at", now - AUTO_REPAIR_WINDOW_MS)
			)
			.collect();

		return {
			consecutiveFailures: health?.consecutive_failures ?? 0,
			lastOwnerOperationAt:
				withinQuietWindow.find(
					(operation) => !isSystemTrigger(operation.trigger)
				)?.created_at ?? null,
			recentAutoRepairs: autoRepairs
				.filter((operation) => operation.trigger === AUTO_REPAIR_TRIGGER)
				.map((operation) => operation.created_at),
			status: box.status
		};
	}
});

// A box that is down and has used up its automatic repairs is the one refusal
// nobody would otherwise hear about: no operation is started, so the ordinary
// operation-failure alert never fires, and the box simply stays broken. The
// documented promise is that past the limit it becomes a person's problem - this
// is what tells the person.
//
// Keyed per box per window rather than per sweep, so a box that stays down does
// not send an email every ten minutes.
export const alertRepairsExhausted = internalMutation({
	args: {
		boxId: v.id("boxes"),
		consecutiveFailures: v.number()
	},
	handler: async (ctx, args) => {
		const box = await ctx.db.get(args.boxId);
		if (!box) return;
		const window = Math.floor(Date.now() / AUTO_REPAIR_WINDOW_MS);
		await raiseAlert(ctx, {
			key: `auto-repair-exhausted:${args.boxId}:${window}`,
			severity: "critical",
			subject: `Box ${box.slug} is down and automatic repair has given up`,
			text: `Box ${box.slug} (${box._id}) has failed ${args.consecutiveFailures} consecutive health probes and has already been repaired automatically ${MAX_AUTO_REPAIRS_PER_WINDOW} times in the last ${AUTO_REPAIR_WINDOW_MS / HOUR_MS} hours, which is the limit.\n\nNothing further will be attempted automatically. A box needing this many repairs in a day is either being broken deliberately by its owner or has a problem repair does not fix, so it needs a person: check the box's recent operations and repair history, then repair it by hand if that is the right call.\n\n${staffConsoleUrl(consoleBoxPath(box._id))}`
		});
	}
});

// The sweep. Probes every box that could be repaired, records the result, and
// repairs the ones that have been down long enough and pass every gate.
//
// Boxes are handled independently and a failure on one never aborts the rest:
// this runs unattended, and one unreachable box must not stop the fleet's health
// from being tracked at all.
export const sweepBoxHealth = internalAction({
	args: {},
	handler: async (ctx) => {
		const boxIds: Id<"boxes">[] = await ctx.runQuery(
			internal.boxes.autoRepair.sweptBoxes,
			{}
		);

		for (const boxId of boxIds) {
			try {
				const { reachable } = await ctx.runAction(
					internal.boxes.health.probeRuntime,
					{ boxId }
				);
				await ctx.runMutation(internal.boxes.autoRepair.recordProbe, {
					boxId,
					reachable
				});
				if (reachable) continue;

				const facts = await ctx.runQuery(
					internal.boxes.autoRepair.autoRepairFacts,
					{ boxId }
				);
				if (!facts) continue;

				const decision = autoRepairDecision(facts, Date.now());
				if (!decision.repair) {
					if (decision.reason === "attempt_limit_reached") {
						await ctx.runMutation(
							internal.boxes.autoRepair.alertRepairsExhausted,
							{ boxId, consecutiveFailures: facts.consecutiveFailures }
						);
					}
					continue;
				}

				await startBoxOperation(ctx, boxId, "repair", {
					// Deliberately not keyed by time: while an automatic repair is still
					// in flight this key deduplicates the next sweep's attempt, and once
					// it settles a later sweep may try again - bounded by the window
					// count rather than by the key.
					idempotencyKey: `auto-repair:${boxId}`,
					metadata: {
						reason: `Unreachable for ${facts.consecutiveFailures} consecutive health checks.`
					},
					// The constant, not the literal: `autoRepairFacts` counts a box's
					// automatic repairs by matching this exact string, so a second spelling
					// is an attempt limit that stops counting.
					trigger: AUTO_REPAIR_TRIGGER
				});
			} catch (error) {
				// Busy, no longer eligible, or a probe that threw. All are normal and
				// all resolve themselves on the next sweep. Report the skipped box so a
				// broken sweep path cannot look like a healthy fleet.
				console.error(`[auto-repair] could not sweep box ${boxId}`, error);
			}
		}
	}
});

export const sweptBoxes = internalQuery({
	args: {},
	handler: async (ctx) => {
		const boxIds: Id<"boxes">[] = [];
		for (const status of SWEPT_STATUSES) {
			const page = await ctx.db
				.query("boxes")
				.withIndex("status", (query) => query.eq("status", status))
				.collect();
			for (const box of page) boxIds.push(box._id);
		}
		return boxIds;
	}
});
