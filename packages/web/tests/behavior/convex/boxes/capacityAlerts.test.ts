import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	capacityAlertTransition,
	reconcileCapacityAlert
} from "@/convex/boxes/capacity";

import {
	seedBox,
	seedSettings,
	seedUser,
	staffAlerts,
	stubDeploymentEnv,
	testConvex,
	type Harness
} from "../../../support/convex.ts";

describe("capacityAlertTransition", () => {
	test("opens one incident when a configured allocation is exhausted", () => {
		expect(
			capacityAlertTransition(null, {
				blockReason: "server_limit",
				limitBlockReason: "server_limit"
			})
		).toEqual({ type: "blocked", reason: "server_limit" });
	});

	test("does not repeat an unchanged capacity incident", () => {
		expect(
			capacityAlertTransition("snapshot_limit", {
				blockReason: "manual_pause",
				limitBlockReason: "snapshot_limit"
			})
		).toEqual({ type: "none" });
	});

	test("reports recovery even while checkout remains manually paused", () => {
		expect(
			capacityAlertTransition("server_limit", {
				blockReason: "manual_pause",
				limitBlockReason: null
			})
		).toEqual({ type: "recovered", reason: "server_limit" });
	});

	test("clears the old episode without a false recovery when limits are removed", () => {
		expect(
			capacityAlertTransition("server_limit", {
				blockReason: "limits_not_configured",
				limitBlockReason: null
			})
		).toEqual({ type: "clear" });
	});
});

// Which allocation ran out, in the words the alert subject uses. Two reasons,
// two labels; collapsing them would page staff about the wrong resource.
describe("naming the exhausted allocation", () => {
	test("distinguishes a server block from a snapshot block", () => {
		const blocked = (reason: "server_limit" | "snapshot_limit") =>
			capacityAlertTransition(null, {
				blockReason: reason,
				limitBlockReason: reason
			});

		expect(blocked("server_limit")).toEqual({
			type: "blocked",
			reason: "server_limit"
		});
		expect(blocked("snapshot_limit")).toEqual({
			type: "blocked",
			reason: "snapshot_limit"
		});
	});
});

// Nothing was ever open, so there is nothing to recover from. Without this the
// first healthy reconcile of a fresh deployment would announce a recovery from
// an incident that never happened.
describe("a deployment that was never blocked", () => {
	test("stays silent while capacity is available", () => {
		expect(
			capacityAlertTransition(null, {
				blockReason: null,
				limitBlockReason: null
			})
		).toEqual({ type: "none" });
	});

	test("stays silent while checkout is merely paused by hand", () => {
		expect(
			capacityAlertTransition(null, {
				blockReason: "manual_pause",
				limitBlockReason: null
			})
		).toEqual({ type: "none" });
	});

	test("stays silent when limits are removed with no incident open", () => {
		expect(
			capacityAlertTransition(null, {
				blockReason: "limits_not_configured",
				limitBlockReason: null
			})
		).toEqual({ type: "none" });
	});
});

// One block replacing another is still news: the resource that ran out changed,
// and the subject line staff read names it.
describe("one block replacing another", () => {
	test("reports the new reason rather than treating it as unchanged", () => {
		expect(
			capacityAlertTransition("server_limit", {
				blockReason: "snapshot_limit",
				limitBlockReason: "snapshot_limit"
			})
		).toEqual({ type: "blocked", reason: "snapshot_limit" });
	});
});

// The half that touches the database: which episode is stored, and which alert
// staff actually receive. The transition table above is pure and was tested;
// this is what acts on it, and none of it had been run - including the recovery
// notice, which is the only signal that a capacity incident is over.
describe("reconciling the stored capacity episode", () => {
	const NOW = Date.UTC(2026, 7, 2, 3, 4, 5);

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		stubDeploymentEnv();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	async function fillServers(t: Harness, count: number) {
		const owner = await seedUser(t);
		for (let index = 0; index < count; index += 1) {
			await seedBox(t, { user_id: owner.clerkUserId, slug: `box-${index}` });
		}
	}

	const settings = (t: Harness) =>
		t.run(async (ctx) => await ctx.db.query("settings").first());

	const reconcile = (t: Harness) =>
		t.run(async (ctx) => await reconcileCapacityAlert(ctx));

	test("opens an episode and pages staff when servers run out", async () => {
		const t = testConvex();
		await seedSettings(t, { hetzner_server_limit: 2 });
		await fillServers(t, 2);

		expect(await reconcile(t)).toEqual({
			type: "blocked",
			reason: "server_limit"
		});
		expect(await settings(t)).toMatchObject({
			capacity_alert_reason: "server_limit",
			capacity_alert_started_at: NOW
		});
		expect(await staffAlerts(t)).toMatchObject([
			{ severity: "critical", subject: "New box server capacity is exhausted" }
		]);
	});

	test("names the snapshot allocation when that is what ran out", async () => {
		const t = testConvex();
		await seedSettings(t, {
			hetzner_server_limit: 100,
			hetzner_snapshot_limit: 1
		});
		await fillServers(t, 1);

		await reconcile(t);

		expect(await staffAlerts(t)).toMatchObject([
			{ subject: "New box snapshot capacity is exhausted" }
		]);
	});

	test("says nothing further while the same episode is still open", async () => {
		const t = testConvex();
		await seedSettings(t, { hetzner_server_limit: 2 });
		await fillServers(t, 2);
		await reconcile(t);

		expect(await reconcile(t)).toEqual({ type: "none" });
		expect(await staffAlerts(t)).toHaveLength(1);
	});

	// The end of an incident, and the only thing that says so. It resolves at the
	// key the block opened - which is the episode's start, not the moment it
	// cleared - so an alert channel that pairs a resolution with its alert closes
	// the thread instead of leaving a critical open beside an orphan resolution.
	test("resolves the episode when capacity comes back", async () => {
		const t = testConvex();
		await seedSettings(t, { hetzner_server_limit: 2 });
		await fillServers(t, 2);
		await reconcile(t);

		// Deliberately later: the resolved key must carry the moment the block
		// opened, not the moment it lifted.
		vi.setSystemTime(NOW + 60_000);
		await t.run(async (ctx) => {
			const stored = await ctx.db.query("settings").first();
			await ctx.db.patch(stored!._id, { hetzner_server_limit: 10 });
		});

		expect(await reconcile(t)).toEqual({
			type: "recovered",
			reason: "server_limit"
		});
		const cleared = await settings(t);
		expect(cleared).not.toHaveProperty("capacity_alert_reason");
		expect(cleared).not.toHaveProperty("capacity_alert_started_at");
		const [blocked, resolved] = await staffAlerts(t);
		expect(blocked).toMatchObject({ severity: "critical" });
		expect(blocked.text).toContain("New checkout is blocked by capacity");
		expect(resolved).toMatchObject({
			severity: "resolved",
			subject: "New box server capacity recovered",
			key: `capacity-recovered:server_limit:${NOW}`
		});
		expect(resolved.text).toContain("server capacity block has cleared");
		// Recovery of one allocation is not the same as checkout being open, so the
		// resolution says which of the two it is rather than implying the other.
		expect(resolved.text).toContain("Checkout is available.");
	});

	test("says checkout is still shut when something else is holding it", async () => {
		const t = testConvex();
		await seedSettings(t, { hetzner_server_limit: 2 });
		await fillServers(t, 2);
		await reconcile(t);

		await t.run(async (ctx) => {
			const stored = await ctx.db.query("settings").first();
			await ctx.db.patch(stored!._id, {
				hetzner_server_limit: 10,
				checkout_enabled: false
			});
		});
		await reconcile(t);

		const [, resolved] = await staffAlerts(t);
		expect(resolved.text).toContain(
			"Checkout is still unavailable for another reason."
		);
	});

	// Removing the limits is not recovery - nothing is known about capacity any
	// more - so the episode is closed without claiming it cleared.
	test("closes the episode without a false recovery when limits are removed", async () => {
		const t = testConvex();
		await seedSettings(t, { hetzner_server_limit: 2 });
		await fillServers(t, 2);
		await reconcile(t);

		await t.run(async (ctx) => {
			const stored = await ctx.db.query("settings").first();
			await ctx.db.patch(stored!._id, { hetzner_server_limit: undefined });
		});

		expect(await reconcile(t)).toEqual({ type: "clear" });
		expect(await settings(t)).not.toHaveProperty("capacity_alert_reason");
		expect(await staffAlerts(t)).toHaveLength(1);
	});
});
