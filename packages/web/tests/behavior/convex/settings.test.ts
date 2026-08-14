import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "@/convex/_generated/api";

import {
	seedSettings,
	seedUser,
	staffAlerts,
	stubDeploymentEnv,
	testConvex,
	type Harness
} from "../../support/convex.ts";

// The deployment's one settings row, and who is on record for its current state.
//
// `updated_by` is the only trace that a threshold, snapshot policy or reservation
// limit was ever changed - unlike the checkout and capacity toggles, those raise
// no alert - so a write that quietly clears it leaves the console reporting a
// deployment nobody configured.

const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);
const AN_HOUR_EARLIER = NOW - 60 * 60 * 1000;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	stubDeploymentEnv();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("the settings audit stamp", () => {
	test("names the staff member who made the change", async () => {
		const t = testConvex();
		await seedSettings(t);
		const admin = await seedUser(t, {
			clerkUserId: "clerk_admin",
			role: "admin"
		});

		await admin.as.mutation(
			api.staff.settings.setMaxActiveCheckoutIntentsPerUser,
			{ max: 7 }
		);

		expect(
			await t.run((ctx) => ctx.db.query("settings").first())
		).toMatchObject({
			max_active_checkout_intents_per_user: 7,
			updated_at: NOW,
			updated_by: "clerk_admin"
		});
	});

	test("refuses a customer", async () => {
		const t = testConvex();
		const customer = await seedUser(t);

		await expect(
			customer.as.mutation(
				api.staff.settings.setMaxActiveCheckoutIntentsPerUser,
				{ max: 7 }
			)
		).rejects.toThrow(/Staff access required/);
	});

	// The hourly release refresh is a machine write against the same row. Passing
	// its absent actor through to `db.patch` deleted `updated_by` outright - Convex
	// removes a field it is given as `undefined` - and reset `updated_at`, so the
	// record of the last staff edit was never more than an hour old and never
	// named anybody.
	test("survives the hourly runtime release refresh", async () => {
		const t = testConvex();
		await seedSettings(t, {
			updated_at: AN_HOUR_EARLIER,
			updated_by: "clerk_admin"
		});

		await t.mutation(internal.settings.recordRuntimeRelease, {
			image: "ghcr.io/example/composery@sha256:abc",
			version: "1.2.3"
		});

		expect(
			await t.run((ctx) => ctx.db.query("settings").first())
		).toMatchObject({
			runtime_release: { version: "1.2.3" },
			updated_at: AN_HOUR_EARLIER,
			updated_by: "clerk_admin"
		});
	});
});

async function adminOn(
	t: Harness,
	settings: Parameters<typeof seedSettings>[1] = {}
) {
	await seedSettings(t, settings);
	return await seedUser(t, { clerkUserId: "clerk_admin", role: "admin" });
}

// Turning a protection off is an incident; turning it on again is the recovery.
// Re-asserting the state it is already in is neither, and mailing that would
// train staff to ignore the ones that matter - every one of these settings is
// written by a form that can be saved twice.
describe("the alerts a settings change raises", () => {
	test("announces closing checkout, and reopening it", async () => {
		const t = testConvex();
		const admin = await adminOn(t);

		await admin.as.mutation(api.staff.settings.setCheckoutEnabled, {
			enabled: false
		});
		expect(await staffAlerts(t)).toMatchObject([
			{ severity: "critical", subject: "Checkout disabled" }
		]);

		await admin.as.mutation(api.staff.settings.setCheckoutEnabled, {
			enabled: true
		});
		expect(await staffAlerts(t)).toMatchObject([
			{ subject: "Checkout disabled" },
			{ severity: "resolved", subject: "Checkout enabled" }
		]);
	});

	test("stays quiet when a setting is saved at the value it already had", async () => {
		const t = testConvex();
		const admin = await adminOn(t, { checkout_enabled: true });

		await admin.as.mutation(api.staff.settings.setCheckoutEnabled, {
			enabled: true
		});
		await admin.as.mutation(api.staff.settings.setAutoSuspendEnabled, {
			enabled: false
		});

		expect(await staffAlerts(t)).toEqual([]);
	});

	// Automatic suspension is the one protection whose *enabling* is also worth
	// saying out loud - it can power a customer's box off on its own - so it opens
	// a warning rather than passing silently.
	test("announces automatic suspension in both directions", async () => {
		const t = testConvex();
		const admin = await adminOn(t);

		await admin.as.mutation(api.staff.settings.setAutoSuspendEnabled, {
			enabled: true
		});
		expect(await staffAlerts(t)).toMatchObject([
			{ severity: "warning", subject: "Automatic suspension enabled" }
		]);

		await admin.as.mutation(api.staff.settings.setAutoSuspendEnabled, {
			enabled: false
		});
		expect(await staffAlerts(t)).toMatchObject([
			{ subject: "Automatic suspension enabled" },
			{ severity: "critical", subject: "Automatic suspension disabled" }
		]);
	});

	// Clearing both Hetzner allocations makes capacity admission fail closed, so
	// nothing new can be sold until someone sets them again. Raising them is
	// ordinary maintenance and says nothing.
	test("announces only the removal of the capacity allocation", async () => {
		const t = testConvex();
		const admin = await adminOn(t);

		await admin.as.mutation(api.staff.settings.setHetznerLimits, {
			serverLimit: 200,
			snapshotLimit: 2000
		});
		expect(await staffAlerts(t)).toEqual([]);

		await admin.as.mutation(api.staff.settings.setHetznerLimits, {
			serverLimit: null,
			snapshotLimit: null
		});
		expect(await staffAlerts(t)).toMatchObject([
			{ severity: "critical", subject: "Capacity admission disabled" }
		]);
	});
});

// The console is the only caller, so this is where a typed-in value is refused.
describe("what a settings form may not save", () => {
	test("refuses one Hetzner allocation without the other", async () => {
		const t = testConvex();
		const admin = await adminOn(t);

		await expect(
			admin.as.mutation(api.staff.settings.setHetznerLimits, {
				serverLimit: 200,
				snapshotLimit: null
			})
		).rejects.toThrow(/both Hetzner limits/i);
	});

	test("refuses an allocation that is not a whole positive number", async () => {
		const t = testConvex();
		const admin = await adminOn(t);

		await expect(
			admin.as.mutation(api.staff.settings.setHetznerLimits, {
				serverLimit: 1.5,
				snapshotLimit: 2000
			})
		).rejects.toThrow(/whole number/i);
	});

	test("refuses a reservation limit outside its bounds", async () => {
		const t = testConvex();
		const admin = await adminOn(t);

		await expect(
			admin.as.mutation(api.staff.settings.setMaxActiveCheckoutIntentsPerUser, {
				max: 0
			})
		).rejects.toThrow(/whole number/i);
	});

	// The validators throw plain Errors because other paths reach them too; the
	// staff mutation is what turns one into a message a form can print.
	test("forwards the offending field's own words for a bad threshold", async () => {
		const t = testConvex();
		const admin = await adminOn(t);

		await expect(
			admin.as.mutation(api.staff.settings.setThresholds, {
				thresholds: [
					{ signal: "egress_bandwidth", value: -1, sustainedSamples: 3 }
				]
			})
		).rejects.toThrow(/egress_bandwidth/);
	});

	test("forwards the same for a bad snapshot policy", async () => {
		const t = testConvex();
		const admin = await adminOn(t);

		await expect(
			admin.as.mutation(api.staff.settings.setSnapshotPolicy, {
				policy: {
					manualMinIntervalMinutes: 5,
					automaticRetentionDays: 0
				}
			})
		).rejects.toThrow(/automaticRetentionDays/);
	});

	test("stores a valid threshold and policy", async () => {
		const t = testConvex();
		const admin = await adminOn(t);

		await admin.as.mutation(api.staff.settings.setThresholds, {
			thresholds: [
				{ signal: "egress_bandwidth", value: 1_000, sustainedSamples: 2 },
				{ signal: "egress_pps", value: 2_000, sustainedSamples: 4 }
			]
		});
		await admin.as.mutation(api.staff.settings.setSnapshotPolicy, {
			policy: {
				manualMinIntervalMinutes: 10,
				automaticRetentionDays: 3
			}
		});

		expect(
			await t.run((ctx) => ctx.db.query("settings").first())
		).toMatchObject({
			thresholds: [
				{ signal: "egress_bandwidth", value: 1_000, sustained_samples: 2 },
				{ signal: "egress_pps", value: 2_000, sustained_samples: 4 }
			],
			snapshot_policy: {
				manual_min_interval_minutes: 10,
				automatic_retention_days: 3
			}
		});
	});
});

// The settings row is created on first write, not seeded, so a fresh deployment
// takes this branch for its very first staff action.
describe("writing settings on a deployment that has none", () => {
	test("creates the row, with checkout open unless told otherwise", async () => {
		const t = testConvex();

		await t.mutation(internal.settings.recordRuntimeRelease, {
			image: "sha256:first",
			version: "1.0.0"
		});

		expect(
			await t.run((ctx) => ctx.db.query("settings").first())
		).toMatchObject({
			checkout_enabled: true,
			runtime_release: { image: "sha256:first", version: "1.0.0" }
		});
	});

	// A schedule writes with no actor, and stamping one would credit a person
	// with a change nobody made.
	test("records no actor for a write the schedule made", async () => {
		const t = testConvex();

		await t.mutation(internal.settings.recordRuntimeRelease, {
			image: "sha256:first",
			version: null
		});

		expect(
			await t.run((ctx) => ctx.db.query("settings").first())
		).not.toHaveProperty("updated_by");
	});
});
