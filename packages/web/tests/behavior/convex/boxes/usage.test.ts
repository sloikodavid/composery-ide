import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { internal } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
	batches,
	boxUsage,
	usageAlertKey,
	usageCrossing
} from "@/convex/boxes/usage";
import { USAGE_FULL_STEP, USAGE_STEPS } from "@/convex/model/box/usage";
import { BOX_PLANS } from "@/convex/model/box/plan";

import {
	boxEvents,
	seedBox,
	seedUser,
	staffAlerts,
	stubDeploymentEnv,
	testConvex,
	type Harness
} from "../../../support/convex.ts";

// What a box has spent of what it is allowed, and who is told.
//
// The property worth protecting is not that a warning is sent - it is that it is
// sent once. A meter is read every ten minutes for traffic and every hour for a
// disk, and a box that sits at 90% sits there for days: a rule that mailed on
// every reading would put a stack of identical emails in an owner's inbox and
// teach them that mail from Composery is noise. So most of this file is about
// silence.

const NOW = Date.UTC(2026, 7, 2, 8, 0, 0);
const TERABYTE = 1_000 ** 4;
const ALLOWANCE = BOX_PLANS.air.trafficTb * TERABYTE;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	stubDeploymentEnv();
	vi.stubEnv("RESEND_API_KEY", "re_test");
	vi.stubEnv("RESEND_NOTICES_FROM", "Composery <notices@composery.test>");
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

async function ownedBox(t: Harness) {
	const owner = await seedUser(t);
	return await seedBox(t, { user_id: owner.clerkUserId, status: "running" });
}

function traffic(t: Harness, boxId: Id<"boxes">, percent: number) {
	return t.mutation(internal.boxes.usage.recordTrafficUsage, {
		boxId,
		outgoingBytes: Math.round((ALLOWANCE * percent) / 100)
	});
}

function disk(
	t: Harness,
	boxId: Id<"boxes">,
	usedBytes: number,
	totalBytes = 40_000_000_000
) {
	return t.mutation(internal.boxes.usage.recordDiskUsage, {
		boxId,
		usedBytes,
		totalBytes
	});
}

function usageRows(t: Harness, boxId: Id<"boxes">) {
	return t.run(
		async (ctx) =>
			await ctx.db
				.query("box_usage")
				.withIndex("box_id_signal", (query) => query.eq("box_id", boxId))
				.collect()
	);
}

async function usageEmails(t: Harness, boxId: Id<"boxes">) {
	const events = await boxEvents(t, boxId);
	return events
		.filter(
			(event) =>
				event.type === "box.owner_emailed" && event.metadata?.notice === "usage"
		)
		.map((event) => event.metadata?.signal);
}

describe("deciding whether a crossing is news", () => {
	// Pure, so the whole matrix is checkable without a database, a provider or a
	// clock - and every caller decides from this and nothing else.
	test("says nothing below the first step", () => {
		expect(usageCrossing(undefined, USAGE_STEPS[0] - 1)).toEqual({
			step: null,
			announce: false
		});
	});

	test("announces a step nobody has been told about", () => {
		expect(usageCrossing(undefined, USAGE_STEPS[0])).toEqual({
			step: USAGE_STEPS[0],
			announce: true
		});
	});

	test("stays quiet at a step already announced", () => {
		expect(usageCrossing(USAGE_STEPS[0], USAGE_STEPS[0])).toEqual({
			step: USAGE_STEPS[0],
			announce: false
		});
	});

	test("announces a higher step even after the first one", () => {
		expect(usageCrossing(USAGE_STEPS[0], 100)).toEqual({
			step: USAGE_FULL_STEP,
			announce: true
		});
	});

	// Falling back records the lower step rather than keeping the high-water mark,
	// which is what lets the same step be announced again next time it is crossed.
	test("records the drop, so the same step is news the next time", () => {
		expect(usageCrossing(USAGE_FULL_STEP, USAGE_STEPS[0])).toEqual({
			step: USAGE_STEPS[0],
			announce: false
		});
		expect(usageCrossing(USAGE_STEPS[0], 100)).toEqual({
			step: USAGE_FULL_STEP,
			announce: true
		});
	});
});

// The sweep asks a fixed number of hosts at once, and how the list is split is
// the only part of that with a right answer - which is why it is a function here
// rather than index arithmetic inside the loop, where nothing could check it and
// no suppression could honestly excuse it.
describe("splitting a page into batches", () => {
	test("covers every item exactly once, in order", () => {
		expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
	});

	test("makes one batch of a page that already fits", () => {
		expect(batches([1, 2], 5)).toEqual([[1, 2]]);
		expect(batches([1, 2], 2)).toEqual([[1, 2]]);
	});

	// An empty page is the normal state of a fleet with nothing running, and it
	// must produce no round trips rather than one empty one.
	test("makes no batch at all of an empty page", () => {
		expect(batches([], 5)).toEqual([]);
	});
});

describe("recording a reading", () => {
	test("stores the two figures and derives nothing else", async () => {
		const t = testConvex();
		const boxId = await ownedBox(t);

		await disk(t, boxId, 10_000_000_000);

		expect(await usageRows(t, boxId)).toMatchObject([
			{
				signal: "disk",
				used_bytes: 10_000_000_000,
				allowance_bytes: 40_000_000_000,
				sampled_at: NOW
			}
		]);
	});

	test("keeps one row per signal, however often each is sampled", async () => {
		const t = testConvex();
		const boxId = await ownedBox(t);

		await disk(t, boxId, 1_000_000_000);
		await disk(t, boxId, 2_000_000_000);
		await traffic(t, boxId, 10);
		await traffic(t, boxId, 20);

		const rows = await usageRows(t, boxId);
		expect(rows).toHaveLength(2);
		expect(rows.map((row) => row.signal).sort()).toEqual(["disk", "traffic"]);
		expect(rows.find((row) => row.signal === "disk")?.used_bytes).toBe(
			2_000_000_000
		);
	});

	// The allowance is the plan's, and it is read on this side rather than passed
	// in: a caller that could name its own allowance is a caller that could measure
	// a box against a limit it was never sold.
	test("measures traffic against what the box's plan includes", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			plan: "pro",
			status: "running"
		});

		await traffic(t, boxId, 50);

		expect((await usageRows(t, boxId))[0]?.allowance_bytes).toBe(
			BOX_PLANS.pro.trafficTb * TERABYTE
		);
	});

	// Both entry points, because both are reached from a sweep that read the box
	// list a moment earlier: a box deleted in between must make the sample a no-op
	// rather than an error that stops the rest of the fleet being measured.
	test("records nothing for a box that no longer exists", async () => {
		const t = testConvex();
		const boxId = await ownedBox(t);
		await t.run(async (ctx) => await ctx.db.delete(boxId));

		await expect(disk(t, boxId, 1)).resolves.toBeNull();
		await expect(traffic(t, boxId, 50)).resolves.toBeNull();
		expect(await usageRows(t, boxId)).toEqual([]);
	});
});

// What the box page and the console are handed. Until this had a test of its own
// every other case here read the table directly, so the one function that decides
// what an owner actually sees could have returned anything at all.
describe("reading a box's usage", () => {
	function readUsage(t: Harness, boxId: Id<"boxes">) {
		return t.run(async (ctx) => await boxUsage(ctx.db, boxId));
	}

	test("gives back both figures and the percentage between them", async () => {
		const t = testConvex();
		const boxId = await ownedBox(t);

		await disk(t, boxId, 30_000_000_000);

		expect(await readUsage(t, boxId)).toEqual([
			{
				signal: "disk",
				usedBytes: 30_000_000_000,
				allowanceBytes: 40_000_000_000,
				percent: 75,
				sampledAt: NOW,
				counterResetAt: null
			}
		]);
	});

	// The declaration order in `USAGE_SIGNALS`, not the order the rows were
	// written, because it is the order the page lays its meters out in - and a box
	// whose disk happened to be sampled first would otherwise swap them.
	test("orders the signals the way the page draws them", async () => {
		const t = testConvex();
		const boxId = await ownedBox(t);

		await traffic(t, boxId, 10);
		await disk(t, boxId, 1_000_000_000);

		expect((await readUsage(t, boxId)).map((row) => row.signal)).toEqual([
			"disk",
			"traffic"
		]);
	});

	// Absent, never zero. "We have not measured this yet" and "this box is using
	// nothing" are different facts, and a meter drawn at 0% for the first one
	// answers the second question while looking like an answer to the first.
	test("leaves out a signal nothing has measured", async () => {
		const t = testConvex();
		const boxId = await ownedBox(t);

		expect(await readUsage(t, boxId)).toEqual([]);

		await disk(t, boxId, 1_000_000_000);
		expect((await readUsage(t, boxId)).map((row) => row.signal)).toEqual([
			"disk"
		]);
	});

	test("carries the reset through for the signal that has one", async () => {
		const t = testConvex();
		const boxId = await ownedBox(t);

		await traffic(t, boxId, 90);
		await traffic(t, boxId, 1);

		expect(
			(await readUsage(t, boxId)).find((row) => row.signal === "traffic")
				?.counterResetAt
		).toBe(NOW);
	});
});

describe("telling the owner", () => {
	test("emails once when a step is first crossed", async () => {
		const t = testConvex();
		const boxId = await ownedBox(t);

		await traffic(t, boxId, USAGE_STEPS[0]);

		expect(await usageEmails(t, boxId)).toEqual(["traffic"]);
	});

	// The whole point. A box parked at 90% is read every ten minutes for as long
	// as it stays there.
	test("says nothing again while the level merely stays high", async () => {
		const t = testConvex();
		const boxId = await ownedBox(t);

		await traffic(t, boxId, USAGE_STEPS[0]);
		for (let poll = 0; poll < 5; poll += 1) {
			await traffic(t, boxId, USAGE_STEPS[0] + 1);
		}

		expect(await usageEmails(t, boxId)).toEqual(["traffic"]);
	});

	test("emails again once the next step is reached", async () => {
		const t = testConvex();
		const boxId = await ownedBox(t);

		await traffic(t, boxId, USAGE_STEPS[0]);
		await traffic(t, boxId, 100);

		expect(await usageEmails(t, boxId)).toEqual(["traffic", "traffic"]);
	});

	// The provider resets the traffic counter at the start of a billing month.
	// Nothing here knows the billing calendar; a counter that went down is the
	// signal, and that is what has to re-arm the warning for the new period.
	test("warns again in a new period, once the counter has reset", async () => {
		const t = testConvex();
		const boxId = await ownedBox(t);

		await traffic(t, boxId, 100);
		expect(await usageEmails(t, boxId)).toEqual(["traffic"]);

		await traffic(t, boxId, 2);
		const [reset] = await usageRows(t, boxId);
		// The mark is cleared, not lowered to zero: a step of zero would compare as
		// a step already announced and keep the whole period silent.
		expect(reset?.noticed_step).toBeUndefined();
		expect(reset?.counter_reset_at).toBe(NOW);

		await traffic(t, boxId, 100);
		expect(await usageEmails(t, boxId)).toEqual(["traffic", "traffic"]);
	});

	// A disk has no periods, so nothing about it can start one. A `docker prune`
	// looks exactly like a counter rolling over, and recording it as one would put
	// the day somebody tidied up on the box page as the day their billing month
	// began.
	test("marks no reset for a disk that merely freed some space", async () => {
		const t = testConvex();
		const boxId = await ownedBox(t);

		await disk(t, boxId, 30_000_000_000);
		await disk(t, boxId, 29_000_000_000);

		expect((await usageRows(t, boxId))[0]?.counter_reset_at).toBeUndefined();
		expect(await usageEmails(t, boxId)).toEqual([]);
	});

	// The other direction, and the one that decides what "reset" means: a counter
	// going up is the normal case, and a counter that did not move is a poll that
	// landed twice. Neither starts a period.
	test("marks no reset while the traffic counter holds or rises", async () => {
		const t = testConvex();
		const boxId = await ownedBox(t);

		await traffic(t, boxId, 10);
		await traffic(t, boxId, 10);
		await traffic(t, boxId, 20);

		expect((await usageRows(t, boxId))[0]?.counter_reset_at).toBeUndefined();
	});

	test("tells the two signals apart, so one warning does not cover both", async () => {
		const t = testConvex();
		const boxId = await ownedBox(t);

		await traffic(t, boxId, 100);
		await disk(t, boxId, 39_000_000_000);

		expect((await usageEmails(t, boxId)).sort()).toEqual(["disk", "traffic"]);
	});
});

describe("telling staff", () => {
	// Only the top step. The first is the owner's to act on, and there is nothing
	// a person here could do about it that the email has not already asked for.
	test("stays out of it at the first step", async () => {
		const t = testConvex();
		const boxId = await ownedBox(t);

		await traffic(t, boxId, USAGE_STEPS[0]);

		expect(await staffAlerts(t)).toEqual([]);
	});

	// The subject and the figures, not only that something was raised. An alert is
	// read in a mailbox next to every other alert the fleet sends, so one that does
	// not say which box, which limit, and how far past it is one an operator has to
	// open the console to understand at all.
	test("raises one alert when the allowance is effectively gone", async () => {
		const t = testConvex();
		const boxId = await ownedBox(t);

		await traffic(t, boxId, 100);

		expect(await staffAlerts(t)).toMatchObject([
			{
				key: usageAlertKey(boxId, "traffic", NOW),
				severity: "warning",
				subject: `Box box has used ${USAGE_FULL_STEP}% of its outbound traffic`
			}
		]);
		expect((await staffAlerts(t))[0]?.text).toContain("20.0 TB of 20.0 TB");
	});

	// `raiseAlert` deduplicates by key for the life of the row, so a key with no
	// period in it would report a full disk once and stay silent through every
	// later month it stayed full.
	test("keys the alert by month, so a later period is heard", () => {
		const boxId = "box_1" as Id<"boxes">;
		expect(usageAlertKey(boxId, "disk", Date.UTC(2026, 7, 2))).not.toBe(
			usageAlertKey(boxId, "disk", Date.UTC(2026, 8, 2))
		);
		expect(usageAlertKey(boxId, "disk", Date.UTC(2026, 7, 2))).toBe(
			usageAlertKey(boxId, "disk", Date.UTC(2026, 7, 28))
		);
	});

	// Recording a box's traffic is a recording. Whether the plan oversells its
	// machine is a question about the catalogue, asked once a day by the
	// reconciliation sweep - so a poll must not raise it, however many times the
	// box is measured.
	test("keeps the catalogue audit out of the recording path", async () => {
		const t = testConvex();
		const boxId = await ownedBox(t);

		await traffic(t, boxId, 10);

		expect(await staffAlerts(t)).toEqual([]);
	});
});

// The one fault in this whole feature that no box's own meter can ever show: a
// plan selling more traffic than its machine includes leaves every box inside its
// published allowance and the deployment billed for the excess.
describe("the audit of what the machines include", () => {
	function audit(t: Harness, serverType: string, includedBytes: number) {
		return t.mutation(internal.boxes.usage.alertTrafficAllowanceGap, {
			serverType,
			includedBytes
		});
	}

	const AIR_TYPE = BOX_PLANS.air.serverType;

	test("reports a machine that includes less than its plan sells", async () => {
		const t = testConvex();

		await audit(t, AIR_TYPE, ALLOWANCE - 1);

		// The body as well as the subject, because the body is the whole point of
		// this one: it is the only alert whose fix is a decision about what Composery
		// sells rather than an operation on a box, so it has to name both figures and
		// both ways out. An operator reading "Box Air sells more traffic than its
		// machine includes" and nothing else has been told there is a problem and not
		// what to do about it.
		const [alert] = await staffAlerts(t);
		expect(alert).toMatchObject({
			severity: "critical",
			subject: expect.stringContaining("Box Air")
		});
		expect(alert?.text).toContain("publishes 20.0 TB");
		expect(alert?.text).toContain("trafficTb");
		// Lowering what a plan sells is a change to a sold term, so the alert has to
		// say so rather than read as a one-line edit.
		expect(alert?.text).toContain("legal notice");
	});

	test("says nothing while the machine includes what the plan sells", async () => {
		const t = testConvex();

		await audit(t, AIR_TYPE, ALLOWANCE);
		await audit(t, AIR_TYPE, ALLOWANCE * 2);

		expect(await staffAlerts(t)).toEqual([]);
	});

	// The provider names the type, so this is handed whatever string it sent. A
	// machine nothing sells is not a fault and must not be an error either - the
	// reconciliation sweep that calls this is also what reclaims leaked resources,
	// and it must not stop doing that over a server type we do not recognise.
	test("passes over a machine no plan sells", async () => {
		const t = testConvex();

		await expect(audit(t, "cx99", 1)).resolves.toBeNull();
		expect(await staffAlerts(t)).toEqual([]);
	});

	// Keyed by the type and the figure reported, so a second machine - or the same
	// one drifting to a different figure - is a second alert rather than one
	// swallowed by the first. `raiseAlert` deduplicates by key for the life of the
	// row, so a key carrying neither would report the first mismatch the fleet ever
	// saw and nothing after it.
	test("raises it once per machine and reported figure", async () => {
		const t = testConvex();

		await audit(t, AIR_TYPE, ALLOWANCE - 1);
		await audit(t, AIR_TYPE, ALLOWANCE - 1);
		expect(await staffAlerts(t)).toHaveLength(1);

		await audit(t, AIR_TYPE, ALLOWANCE / 2);
		expect(await staffAlerts(t)).toHaveLength(2);

		await audit(t, BOX_PLANS.pro.serverType, 1);
		expect(await staffAlerts(t)).toHaveLength(3);
	});
});
