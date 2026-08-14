import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { internal } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { isSystemTrigger, type OperationTrigger } from "@/convex/schema";
import {
	AUTO_REPAIR_TRIGGER,
	AUTO_REPAIR_WINDOW_MS,
	MAX_AUTO_REPAIRS_PER_WINDOW,
	OWNER_QUIET_WINDOW_MS,
	SUSTAINED_FAILURES,
	SWEPT_STATUSES,
	autoRepairDecision,
	type AutoRepairFacts
} from "@/convex/boxes/autoRepair";
import { BOX_OPERATIONS } from "@/convex/model/box/operation";

import {
	boxOperations,
	seedBox,
	seedUser,
	staffAlerts,
	stubDeploymentEnv,
	testConvex,
	type Harness
} from "../../../support/convex.ts";

const NOW = 10_000_000_000;

// The database-backed half of this file needs the clock pinned: every fact it
// gathers is a window measured back from now.
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	stubDeploymentEnv();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

function facts(over: Partial<AutoRepairFacts> = {}): AutoRepairFacts {
	return {
		consecutiveFailures: SUSTAINED_FAILURES,
		lastOwnerOperationAt: null,
		recentAutoRepairs: [],
		status: "running",
		...over
	};
}

describe("autoRepairDecision", () => {
	test("repairs a box that has been down for the sustained window", () => {
		expect(autoRepairDecision(facts(), NOW)).toEqual({ repair: true });
	});

	test("does nothing for a box that is answering", () => {
		expect(autoRepairDecision(facts({ consecutiveFailures: 0 }), NOW)).toEqual({
			repair: false,
			reason: "healthy"
		});
	});

	// A box restarting, booting slowly, or briefly unreachable is not a box that
	// needs its host rebuilt. The threshold is what separates the two.
	test("waits for the failure to be sustained", () => {
		expect(
			autoRepairDecision(
				facts({ consecutiveFailures: SUSTAINED_FAILURES - 1 }),
				NOW
			)
		).toEqual({ repair: false, reason: "not_sustained" });
	});

	// The owner is root on this box and is expected to break it. Someone who
	// pressed a button minutes ago is working on it, and healing under them would
	// undo what they are doing.
	test("stays out of the way after an owner-initiated operation", () => {
		expect(
			autoRepairDecision(
				facts({ lastOwnerOperationAt: NOW - OWNER_QUIET_WINDOW_MS + 1 }),
				NOW
			)
		).toEqual({ repair: false, reason: "owner_recently_acted" });

		expect(
			autoRepairDecision(
				facts({ lastOwnerOperationAt: NOW - OWNER_QUIET_WINDOW_MS }),
				NOW
			)
		).toEqual({ repair: true });
	});

	// Each repair creates and deletes a Hetzner Volume and takes the box down, so
	// an unbounded healer is an unbounded bill and an unbounded outage. Past the
	// cap it is a person's problem, not the fleet's.
	test("stops after the attempt limit within the window", () => {
		const attempts = Array.from(
			{ length: MAX_AUTO_REPAIRS_PER_WINDOW },
			(_unused, index) => NOW - index * 1000
		);

		expect(
			autoRepairDecision(facts({ recentAutoRepairs: attempts }), NOW)
		).toEqual({ repair: false, reason: "attempt_limit_reached" });
	});

	test("counts only the attempts inside the window", () => {
		const expired = Array.from(
			{ length: MAX_AUTO_REPAIRS_PER_WINDOW },
			() => NOW - AUTO_REPAIR_WINDOW_MS
		);

		expect(
			autoRepairDecision(facts({ recentAutoRepairs: expired }), NOW)
		).toEqual({ repair: true });
	});

	// Asks the same table the backend enforces. A stopped or suspended box has no
	// host answering over SSH, and a box mid-operation must never have a repair
	// queued behind it.
	test("never repairs a box whose status does not allow it", () => {
		for (const status of [
			"stopped",
			"suspended",
			"repairing",
			"updating",
			"create_failed",
			"deleting",
			"deleted"
		] as const) {
			expect(autoRepairDecision(facts({ status }), NOW)).toEqual({
				repair: false,
				reason: "status_not_repairable"
			});
		}
	});

	// A failed update leaves the box on its old image in the row, so repairing it
	// rolls the update back. That makes it exactly the state automatic repair
	// should act on - and the reason the update workflow must not advance the row
	// before the box answers.
	test("repairs a box left broken by a failed update", () => {
		expect(autoRepairDecision(facts({ status: "update_failed" }), NOW)).toEqual(
			{
				repair: true
			}
		);
	});
});

// The gate matrix above is pure and was always tested. What was not tested is
// whether the sweep ever hands it a box in one of those states, and for a long
// time it did not: it only ever listed `status == "running"`, so the
// `update_failed` case above was unreachable in production while its test passed.
// A decision that cannot be reached is worse than a missing one, because the test
// suite reports it as covered.
describe("the sweep feeds every status the decision can act on", () => {
	test("probes exactly the statuses a repair may begin from", () => {
		expect([...SWEPT_STATUSES].sort()).toEqual(
			[...BOX_OPERATIONS.repair.from].sort()
		);
	});

	test.each(BOX_OPERATIONS.repair.from)(
		"sweeps %s, which the decision can approve",
		(status) => {
			expect(SWEPT_STATUSES).toContain(status);
			expect(autoRepairDecision(facts({ status }), NOW)).toEqual({
				repair: true
			});
		}
	);
});

// The quiet window means "a person is working on this box". It used to mean "any
// operation ran", which the fleet's own housekeeping satisfied: a nightly
// automatic snapshot suppressed repair for two hours every night, and a forced
// floor update suppressed it for two hours after the event most likely to have
// broken the box.
describe("trigger classification", () => {
	const humanTriggers: OperationTrigger[] = ["owner", "staff"];
	const systemTriggers: OperationTrigger[] = [
		"system:auto_repair",
		"system:runtime_floor",
		"system:auto_snapshot",
		"system:abuse_suspension",
		"system:subscription_revoked",
		"system:account_deletion"
	];

	test.each(humanTriggers)("%s counts as a person acting", (trigger) => {
		expect(isSystemTrigger(trigger)).toBe(false);
	});

	test.each(systemTriggers)("%s does not hold repair off", (trigger) => {
		expect(isSystemTrigger(trigger)).toBe(true);
	});

	test("counts its own repairs against the attempt limit", () => {
		expect(isSystemTrigger(AUTO_REPAIR_TRIGGER)).toBe(true);
	});
});

// The probe record and the facts read off it. `autoRepairDecision` above is pure
// and covered; what feeds it was not, and a fact gathered wrongly makes the
// right decision about the wrong box - either repairing one somebody is working
// on, or leaving a dead one alone for ever.
describe("recording a health probe", () => {
	async function probedBox(t: Harness) {
		const owner = await seedUser(t);
		return await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas",
			hetzner_server_id: 77
		});
	}

	const record = (t: Harness, boxId: Id<"boxes">, reachable: boolean) =>
		t.mutation(internal.boxes.autoRepair.recordProbe, { boxId, reachable });

	const health = (t: Harness) =>
		t.run((ctx) => ctx.db.query("box_health").first());

	test("opens a count on the first failure", async () => {
		const t = testConvex();
		const boxId = await probedBox(t);

		expect(await record(t, boxId, false)).toBe(1);
		expect(await health(t)).toMatchObject({ consecutive_failures: 1 });
	});

	test("counts consecutive failures upwards", async () => {
		const t = testConvex();
		const boxId = await probedBox(t);

		await record(t, boxId, false);
		await record(t, boxId, false);

		expect(await record(t, boxId, false)).toBe(3);
	});

	// A success resets rather than decrements. The gate is "down continuously for
	// N checks"; a box flapping between reachable and unreachable is a different
	// problem, and repair would not fix it.
	test("resets the count on a success rather than decrementing it", async () => {
		const t = testConvex();
		const boxId = await probedBox(t);
		await record(t, boxId, false);
		await record(t, boxId, false);

		expect(await record(t, boxId, true)).toBe(0);
		expect(await record(t, boxId, false)).toBe(1);
	});

	// `last_ok_at` is only moved by a success: a failing box keeps the moment it
	// was last known good, which is what says how long it has been down.
	test("keeps the moment a box was last known good", async () => {
		const t = testConvex();
		const boxId = await probedBox(t);
		await record(t, boxId, true);

		vi.setSystemTime(NOW + 60_000);
		await record(t, boxId, false);

		expect(await health(t)).toMatchObject({
			last_ok_at: NOW,
			consecutive_failures: 1
		});
	});

	test("records nothing about being well for a box that never answered", async () => {
		const t = testConvex();
		const boxId = await probedBox(t);

		await record(t, boxId, false);

		expect(await health(t)).not.toHaveProperty("last_ok_at");
	});
});

// The facts the gate is decided from, read in one query so the decision is made
// against a single consistent view.
describe("gathering the facts a repair is decided from", () => {
	const readFacts = (t: Harness, boxId: Id<"boxes">) =>
		t.query(internal.boxes.autoRepair.autoRepairFacts, { boxId });

	async function boxWithHistory(
		t: Harness,
		operations: {
			at: number;
			trigger: Doc<"box_operations">["trigger"];
			type?: Doc<"box_operations">["type"];
		}[]
	) {
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas"
		});
		await t.run(async (ctx) => {
			for (const [index, operation] of operations.entries()) {
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: operation.type ?? "repair",
					status: "succeeded",
					idempotency_key: `op-${index}`,
					trigger: operation.trigger,
					created_at: operation.at,
					updated_at: operation.at
				});
			}
		});
		return boxId;
	}

	test("says nothing about a box that no longer exists", async () => {
		const t = testConvex();
		const boxId = await boxWithHistory(t, []);
		await t.run(async (ctx) => await ctx.db.delete(boxId));

		expect(await readFacts(t, boxId)).toBeNull();
	});

	test("reports no failures for a box that has never been probed", async () => {
		const t = testConvex();
		const boxId = await boxWithHistory(t, []);

		expect(await readFacts(t, boxId)).toMatchObject({
			consecutiveFailures: 0,
			lastOwnerOperationAt: null,
			recentAutoRepairs: [],
			status: "running"
		});
	});

	// Someone who just pressed a button is working on this box. Healing it under
	// them would undo what they are doing.
	test("notices a person acting inside the quiet window", async () => {
		const t = testConvex();
		const boxId = await boxWithHistory(t, [
			{ at: NOW - 1000, trigger: "owner", type: "stop" }
		]);

		expect(await readFacts(t, boxId)).toMatchObject({
			lastOwnerOperationAt: NOW - 1000
		});
	});

	// The fleet's own work does not count as a person. A nightly snapshot used to
	// read as "the owner just acted" and suppressed repair fleet-wide every night.
	test.each([
		["an automatic snapshot", "system:auto_snapshot"],
		["a forced floor update", "system:runtime_floor"],
		["an automatic repair", "system:auto_repair"]
	] as const)("does not mistake %s for a person", async (_name, trigger) => {
		const t = testConvex();
		const boxId = await boxWithHistory(t, [{ at: NOW - 1000, trigger }]);

		expect(await readFacts(t, boxId)).toMatchObject({
			lastOwnerOperationAt: null
		});
	});

	// Staff pressing Repair is a person too, and the same quiet window applies.
	test("counts staff as a person", async () => {
		const t = testConvex();
		const boxId = await boxWithHistory(t, [
			{ at: NOW - 1000, trigger: "staff" }
		]);

		expect(await readFacts(t, boxId)).toMatchObject({
			lastOwnerOperationAt: NOW - 1000
		});
	});

	// Only the window matters: an operation older than it would not hold repair
	// off anyway, so it is not read and must not be reported.
	test("ignores a person's action from before the quiet window", async () => {
		const t = testConvex();
		const boxId = await boxWithHistory(t, [
			{ at: NOW - OWNER_QUIET_WINDOW_MS - 1, trigger: "owner" }
		]);

		expect(await readFacts(t, boxId)).toMatchObject({
			lastOwnerOperationAt: null
		});
	});

	// The attempt limit counts only this module's own repairs. Counting a
	// person's repair against it would let one manual retry exhaust the budget.
	test("counts only automatic repairs against the attempt limit", async () => {
		const t = testConvex();
		const boxId = await boxWithHistory(t, [
			{ at: NOW - 1000, trigger: AUTO_REPAIR_TRIGGER },
			{ at: NOW - 2000, trigger: "owner" },
			{ at: NOW - 3000, trigger: "staff" }
		]);

		expect(await readFacts(t, boxId)).toMatchObject({
			recentAutoRepairs: [NOW - 1000]
		});
	});

	// A repair from before the window is spent history. Reading it would keep a
	// box locked out of automatic repair for ever.
	test("forgets an automatic repair older than the window", async () => {
		const t = testConvex();
		const boxId = await boxWithHistory(t, [
			{ at: NOW - AUTO_REPAIR_WINDOW_MS - 1, trigger: AUTO_REPAIR_TRIGGER }
		]);

		expect(await readFacts(t, boxId)).toMatchObject({ recentAutoRepairs: [] });
	});

	// Only repairs. A snapshot the fleet took is not an attempt at fixing
	// anything, and counting it would exhaust the budget without repairing once.
	test("counts only repairs, not every automatic operation", async () => {
		const t = testConvex();
		const boxId = await boxWithHistory(t, [
			{ at: NOW - 1000, trigger: "system:auto_snapshot", type: "snapshot" }
		]);

		expect(await readFacts(t, boxId)).toMatchObject({ recentAutoRepairs: [] });
	});
});

// The refusal nobody would otherwise hear about: no operation is started, so the
// ordinary operation-failure alert never fires and the box simply stays broken.
describe("telling staff automatic repair has given up", () => {
	async function downBox(t: Harness) {
		const owner = await seedUser(t);
		return await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "stubborn"
		});
	}

	test("names the box and how long it has been failing", async () => {
		const t = testConvex();
		const boxId = await downBox(t);

		await t.mutation(internal.boxes.autoRepair.alertRepairsExhausted, {
			boxId,
			consecutiveFailures: 9
		});

		const [alert] = await staffAlerts(t);
		expect(alert).toMatchObject({ severity: "critical" });
		expect(alert?.subject).toContain("stubborn");
		expect(alert?.text).toContain("9 consecutive health probes");
	});

	// Keyed per box per window, so a box that stays down does not mail every ten
	// minutes for a day.
	test("mails once per box per window however often it is called", async () => {
		const t = testConvex();
		const boxId = await downBox(t);

		await t.mutation(internal.boxes.autoRepair.alertRepairsExhausted, {
			boxId,
			consecutiveFailures: 9
		});
		await t.mutation(internal.boxes.autoRepair.alertRepairsExhausted, {
			boxId,
			consecutiveFailures: 10
		});

		expect(await staffAlerts(t)).toHaveLength(1);
	});

	test("says nothing about a box that has since been deleted", async () => {
		const t = testConvex();
		const boxId = await downBox(t);
		await t.run(async (ctx) => await ctx.db.delete(boxId));

		await t.mutation(internal.boxes.autoRepair.alertRepairsExhausted, {
			boxId,
			consecutiveFailures: 9
		});

		expect(await staffAlerts(t)).toEqual([]);
	});
});

// Which boxes are probed at all. This used to be `status == "running"` alone,
// which made four of the five repairable statuses unreachable - most importantly
// `update_failed`, the case the whole rollback-by-repair design exists for.
describe("choosing which boxes to probe", () => {
	test.each([...SWEPT_STATUSES])("sweeps a %s box", async (status) => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas",
			status
		});

		expect(await t.query(internal.boxes.autoRepair.sweptBoxes, {})).toEqual([
			boxId
		]);
	});

	test.each(["stopped", "suspended", "deleted", "creating"] as const)(
		"leaves a %s box out",
		async (status) => {
			const t = testConvex();
			const owner = await seedUser(t);
			await seedBox(t, {
				user_id: owner.clerkUserId,
				slug: "atlas",
				status
			});

			expect(await t.query(internal.boxes.autoRepair.sweptBoxes, {})).toEqual(
				[]
			);
		}
	);
});

// The sweep itself: probe every repairable box, record the result, and repair
// the ones that have been down long enough and pass every gate.
//
// It is the only thing that recreates an owner's host without them asking, it
// runs unattended every ten minutes, and until now nothing had run it end to
// end - so the wiring between "unreachable" and "repair started" was only ever
// checked one piece at a time.
describe("sweeping the fleet's health", () => {
	function stubProbe(reachable: boolean | ((slug: string) => boolean)) {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: URL | string) => {
				const url = String(input);
				const slug = url.replace("https://", "").split(".")[0] ?? "";
				const ok = typeof reachable === "boolean" ? reachable : reachable(slug);
				if (!ok) throw new Error("connect ETIMEDOUT");
				return { ok: true } as Response;
			})
		);
	}

	async function sweptBox(
		t: Harness,
		slug: string,
		seed: Partial<Doc<"boxes">> = {}
	) {
		const owner = await seedUser(t, { clerkUserId: `user_${slug}` });
		return await seedBox(t, {
			user_id: owner.clerkUserId,
			slug,
			hetzner_server_id: 77,
			...seed
		});
	}

	const sweep = (t: Harness) =>
		t.action(internal.boxes.autoRepair.sweepBoxHealth, {});

	const repairs = async (t: Harness, boxId: Id<"boxes">) =>
		(await boxOperations(t, boxId)).filter((row) => row.type === "repair");

	test("records a failure for a box that will not answer", async () => {
		const t = testConvex();
		const boxId = await sweptBox(t, "atlas");
		stubProbe(false);

		await sweep(t);

		expect(
			await t.run((ctx) => ctx.db.query("box_health").first())
		).toMatchObject({ box_id: boxId, consecutive_failures: 1 });
	});

	// One probe is not a fault. The gate is sustained failure, and repairing on
	// the first blip would fight a box that is simply restarting.
	test("repairs nothing on the first failure", async () => {
		const t = testConvex();
		const boxId = await sweptBox(t, "atlas");
		stubProbe(false);

		await sweep(t);

		expect(await repairs(t, boxId)).toEqual([]);
	});

	test("repairs a box once the failures are sustained", async () => {
		const t = testConvex();
		const boxId = await sweptBox(t, "atlas");
		stubProbe(false);

		for (let pass = 0; pass < SUSTAINED_FAILURES; pass += 1) await sweep(t);

		expect(await repairs(t, boxId)).toMatchObject([
			{
				trigger: AUTO_REPAIR_TRIGGER,
				metadata: {
					reason: `Unreachable for ${SUSTAINED_FAILURES} consecutive health checks.`
				}
			}
		]);
	});

	// A box that answers is not touched, and its count goes back to zero so a
	// later blip starts counting again from one.
	test("leaves a box that answers alone, and forgets its earlier failures", async () => {
		const t = testConvex();
		const boxId = await sweptBox(t, "atlas");
		stubProbe(false);
		await sweep(t);
		stubProbe(true);

		await sweep(t);

		expect(
			await t.run((ctx) => ctx.db.query("box_health").first())
		).toMatchObject({ consecutive_failures: 0 });
		expect(await repairs(t, boxId)).toEqual([]);
	});

	// This runs unattended over the whole fleet. One box that throws must not
	// stop the rest from being probed, or a single bad row blinds the healer.
	test("keeps sweeping when one box cannot be probed at all", async () => {
		const t = testConvex();
		await sweptBox(t, "broken");
		const fine = await sweptBox(t, "fine");
		stubProbe((slug) => slug === "fine");

		await sweep(t);

		const health = await t.run((ctx) => ctx.db.query("box_health").collect());
		expect(health).toHaveLength(2);
		expect(
			health.find((row) => row.box_id === fine)?.consecutive_failures
		).toBe(0);
	});

	// The quiet window. Somebody who just pressed a button is working on this
	// box, and healing it under them would undo what they are doing.
	test("stays out of the way of someone working on the box", async () => {
		const t = testConvex();
		const boxId = await sweptBox(t, "atlas");
		await t.run(
			async (ctx) =>
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: "stop",
					status: "succeeded",
					idempotency_key: "theirs",
					trigger: "owner",
					created_at: NOW - 1000,
					updated_at: NOW - 1000
				})
		);
		stubProbe(false);

		for (let pass = 0; pass < SUSTAINED_FAILURES; pass += 1) await sweep(t);

		expect(await repairs(t, boxId)).toEqual([]);
	});

	// Past the limit nothing further is attempted, and because no operation is
	// started the ordinary failure alert never fires - so this is the only thing
	// that tells anyone the box is still down.
	test("tells staff once it has given up", async () => {
		const t = testConvex();
		const boxId = await sweptBox(t, "atlas");
		await t.run(async (ctx) => {
			for (let index = 0; index < MAX_AUTO_REPAIRS_PER_WINDOW; index += 1) {
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: "repair",
					status: "succeeded",
					idempotency_key: `auto-${index}`,
					trigger: AUTO_REPAIR_TRIGGER,
					created_at: NOW - 1000 * (index + 1),
					updated_at: NOW - 1000 * (index + 1)
				});
			}
		});
		stubProbe(false);

		for (let pass = 0; pass < SUSTAINED_FAILURES; pass += 1) await sweep(t);

		expect(await repairs(t, boxId)).toHaveLength(MAX_AUTO_REPAIRS_PER_WINDOW);
		expect(await staffAlerts(t)).toMatchObject([{ severity: "critical" }]);
	});

	// Deliberately not keyed by time: while one automatic repair is still in
	// flight the next sweep's attempt deduplicates against it.
	test("does not queue a second repair behind one already running", async () => {
		const t = testConvex();
		const boxId = await sweptBox(t, "atlas");
		stubProbe(false);

		for (let pass = 0; pass < SUSTAINED_FAILURES + 3; pass += 1) await sweep(t);

		expect(await repairs(t, boxId)).toHaveLength(1);
	});
});
