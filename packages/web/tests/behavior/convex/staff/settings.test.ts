import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "@/convex/_generated/api";
import { MAX_ACTIVE_CHECKOUT_INTENTS_PER_USER } from "@/convex/model/settings";

import {
	seedSettings,
	staffAlerts,
	seedUser,
	stubDeploymentEnv,
	testConvex,
	type Harness
} from "../../../support/convex.ts";

// The deployment's own dials: whether it sells boxes at all, whether it
// suspends abusers by itself, what it believes its provider quota to be, and
// what the fleet's version floor is.
//
// Two things make these worth their own suite. Every one is reachable only with
// `settings_management`, which is a narrower power than the console at large -
// a support engineer who can reset a box must not be able to close checkout for
// everybody. And each carries a bound whose whole job is to stop a typed number
// from becoming a fleet-wide action: a zero server limit blocks every sale, and
// a floor deadline in the past updates every box below it on the next run.

const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	stubDeploymentEnv();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

async function cast(t: Harness) {
	const admin = await seedUser(t, {
		clerkUserId: "admin",
		email: "admin@example.com",
		role: "admin"
	});
	const customer = await seedUser(t, {
		clerkUserId: "customer",
		email: "customer@example.com"
	});
	return { admin, customer };
}

const settingsRow = (t: Harness) =>
	t.run((ctx) => ctx.db.query("settings").first());

describe("reading the deployment's settings", () => {
	test("gives staff the settings and the capacity they imply", async () => {
		const t = testConvex();
		await seedSettings(t, { hetzner_server_limit: 10 });
		const { admin } = await cast(t);

		const result = await admin.as.query(api.staff.settings.get, {});

		expect(result).toMatchObject({ hetznerServerLimit: 10 });
		expect(result.capacity).toBeDefined();
	});

	// A deployment that has never been configured still has to render the page,
	// so the query answers from defaults rather than failing on a missing row.
	test("answers from defaults before anything has been configured", async () => {
		const t = testConvex();
		const { admin } = await cast(t);

		await expect(
			admin.as.query(api.staff.settings.get, {})
		).resolves.toBeDefined();
	});

	test("refuses a customer", async () => {
		const t = testConvex();
		const { customer } = await cast(t);

		await expect(customer.as.query(api.staff.settings.get, {})).rejects.toThrow(
			"Staff access required."
		);
	});
});

// Both toggles are one boolean each, and both are attributed - a deployment
// that stopped selling boxes overnight is a thing somebody has to be able to
// account for.
describe("the two switches", () => {
	test.each([
		["setCheckoutEnabled", "checkout_enabled"],
		["setAutoSuspendEnabled", "auto_suspend_enabled"]
	] as const)("%s records the value and who set it", async (name, field) => {
		const t = testConvex();
		await seedSettings(t);
		const { admin } = await cast(t);

		await admin.as.mutation(api.staff.settings[name], { enabled: false });

		expect(await settingsRow(t)).toMatchObject({ [field]: false });
	});

	test.each(["setCheckoutEnabled", "setAutoSuspendEnabled"] as const)(
		"%s refuses a caller without settings powers",
		async (name) => {
			const t = testConvex();
			await seedSettings(t, { checkout_enabled: true });
			const { customer } = await cast(t);

			await expect(
				customer.as.mutation(api.staff.settings[name], { enabled: false })
			).rejects.toThrow("Staff access required.");
			expect(await settingsRow(t)).toMatchObject({ checkout_enabled: true });
		}
	);
});

// The numbers this deployment believes its Hetzner project allows. Capacity
// admission refuses new boxes against them, so a wrong one either oversells the
// project or blocks every sale.
describe("the provider limits capacity admission reads", () => {
	const setLimits = (
		admin: Awaited<ReturnType<typeof cast>>["admin"],
		serverLimit: number | null,
		snapshotLimit: number | null
	) =>
		admin.as.mutation(api.staff.settings.setHetznerLimits, {
			serverLimit,
			snapshotLimit
		});

	test("records a pair of limits", async () => {
		const t = testConvex();
		await seedSettings(t);
		const { admin } = await cast(t);

		await setLimits(admin, 50, 500);

		expect(await settingsRow(t)).toMatchObject({
			hetzner_server_limit: 50,
			hetzner_snapshot_limit: 500
		});
	});

	// Clearing both is how a deployment turns capacity admission off. Clearing
	// one would leave admission half-configured, judging servers against a limit
	// and snapshots against nothing.
	test("clears both together to disable admission", async () => {
		const t = testConvex();
		await seedSettings(t);
		const { admin } = await cast(t);

		await setLimits(admin, null, null);

		const row = await settingsRow(t);
		expect(row).not.toHaveProperty("hetzner_server_limit");
		expect(row).not.toHaveProperty("hetzner_snapshot_limit");
	});

	test.each([
		["only the server limit", null, 500],
		["only the snapshot limit", 50, null]
	] as const)("refuses clearing %s", async (_name, server, snapshot) => {
		const t = testConvex();
		await seedSettings(t);
		const { admin } = await cast(t);

		await expect(setLimits(admin, server, snapshot)).rejects.toThrow(
			"Set both Hetzner limits, or clear both to disable capacity admission."
		);
	});

	// Zero is the dangerous one: it reads as a configured limit and blocks every
	// new box, which looks exactly like an outage.
	test.each([
		["zero", 0],
		["a negative number", -1],
		["a fraction", 1.5],
		["more than the ceiling", 100_001]
	])("refuses a server limit of %s", async (_name, value) => {
		const t = testConvex();
		await seedSettings(t);
		const { admin } = await cast(t);

		await expect(setLimits(admin, value, 500)).rejects.toThrow(
			"Server limit must be a whole number between 1 and 100000."
		);
	});

	test("names the snapshot limit when that is the bad one", async () => {
		const t = testConvex();
		await seedSettings(t);
		const { admin } = await cast(t);

		await expect(setLimits(admin, 50, 0)).rejects.toThrow(
			"Snapshot limit must be a whole number between 1 and 100000."
		);
	});
});

// How many checkouts one person may hold open at once. Each holds a slug and a
// fleet slot, so the bound is what stops one account reserving the estate.
describe("the per-user checkout limit", () => {
	const setLimit = (
		admin: Awaited<ReturnType<typeof cast>>["admin"],
		max: number
	) =>
		admin.as.mutation(api.staff.settings.setMaxActiveCheckoutIntentsPerUser, {
			max
		});

	test("records a limit inside the allowed range", async () => {
		const t = testConvex();
		await seedSettings(t);
		const { admin } = await cast(t);

		await setLimit(admin, 2);

		expect(await settingsRow(t)).toMatchObject({
			max_active_checkout_intents_per_user: 2
		});
	});

	test.each([
		["zero", 0],
		["a negative number", -1],
		["a fraction", 1.5]
	])("refuses %s", async (_name, max) => {
		const t = testConvex();
		await seedSettings(t);
		const { admin } = await cast(t);

		await expect(setLimit(admin, max)).rejects.toThrow(
			`Limit must be a whole number between 1 and ${MAX_ACTIVE_CHECKOUT_INTENTS_PER_USER}.`
		);
	});

	// The ceiling is allowed; one past it is not.
	test("accepts the ceiling and refuses one beyond it", async () => {
		const t = testConvex();
		await seedSettings(t);
		const { admin } = await cast(t);

		await expect(
			setLimit(admin, MAX_ACTIVE_CHECKOUT_INTENTS_PER_USER)
		).resolves.not.toThrow();
		await expect(
			setLimit(admin, MAX_ACTIVE_CHECKOUT_INTENTS_PER_USER + 1)
		).rejects.toThrow();
	});
});

// The fleet's version floor. It is set from the resolved release rather than a
// typed value, because a floor is a digest a box is compared against - a
// hand-entered tag would match nothing, or match by name while the box runs a
// different build.
describe("raising the fleet's version floor", () => {
	const DIGEST = `sha256:${"a".repeat(64)}`;

	function stubRegistry() {
		vi.stubEnv("RUNTIME_IMAGE", "ghcr.io/composery/composery:edge");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: URL | string) => ({
				ok: true,
				status: 200,
				headers: new Headers({ "Docker-Content-Digest": DIGEST }),
				json: async () =>
					String(input).includes("/blobs/")
						? {
								config: {
									Labels: { "org.opencontainers.image.version": "1.4.0" }
								}
							}
						: { config: { digest: `sha256:${"c".repeat(64)}` } }
			}))
		);
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("pins the floor to what the channel resolves to now", async () => {
		const t = testConvex();
		await seedSettings(t);
		const { admin } = await cast(t);
		stubRegistry();

		await admin.as.action(api.staff.settings.setMinimumRuntimeToCurrent, {
			deadline: NOW + 7 * 24 * 60 * 60 * 1000
		});

		expect(await settingsRow(t)).toMatchObject({
			minimum_runtime_image: `ghcr.io/composery/composery@${DIGEST}`,
			minimum_runtime_version: "1.4.0"
		});
	});

	// No deadline announces the floor without enforcing it - the interface tells
	// owners they are behind and nothing updates itself.
	test("announces a floor with no deadline without enforcing it", async () => {
		const t = testConvex();
		await seedSettings(t);
		const { admin } = await cast(t);
		stubRegistry();

		await admin.as.action(api.staff.settings.setMinimumRuntimeToCurrent, {});

		const row = await settingsRow(t);
		expect(row?.minimum_runtime_image).toBeDefined();
		expect(row).not.toHaveProperty("minimum_runtime_deadline");
	});

	// A deadline already past is the dangerous input: it would update every box
	// below the floor on the very next sweep, with no window for anyone.
	test.each([
		["already passed", -1],
		["exactly now", 0]
	])("refuses a deadline %s", async (_name, offset) => {
		const t = testConvex();
		await seedSettings(t);
		const { admin } = await cast(t);
		stubRegistry();

		await expect(
			admin.as.action(api.staff.settings.setMinimumRuntimeToCurrent, {
				deadline: NOW + offset
			})
		).rejects.toThrow(/must be in the future/);
		expect(await settingsRow(t)).not.toHaveProperty("minimum_runtime_image");
	});

	test("refuses a caller without settings powers", async () => {
		const t = testConvex();
		await seedSettings(t);
		const { customer } = await cast(t);

		await expect(
			customer.as.action(api.staff.settings.setMinimumRuntimeToCurrent, {})
		).rejects.toThrow("Staff access required.");
	});
});

// The edges of each bound, and the two settings whose validation lives in a
// helper. A bound that is one out either refuses a legitimate value or admits
// one the rest of the system cannot honour.
describe("the edges of what may be configured", () => {
	test.each([
		["the smallest allowed", 1],
		["the largest allowed", 100_000]
	])("accepts %s Hetzner limit", async (_name, value) => {
		const t = testConvex();
		await seedSettings(t);
		const { admin } = await cast(t);

		await admin.as.mutation(api.staff.settings.setHetznerLimits, {
			serverLimit: value,
			snapshotLimit: value
		});

		expect(await settingsRow(t)).toMatchObject({
			hetzner_server_limit: value,
			hetzner_snapshot_limit: value
		});
	});

	test("accepts a per-user checkout limit of one", async () => {
		const t = testConvex();
		await seedSettings(t);
		const { admin } = await cast(t);

		await admin.as.mutation(
			api.staff.settings.setMaxActiveCheckoutIntentsPerUser,
			{ max: 1 }
		);

		expect(await settingsRow(t)).toMatchObject({
			max_active_checkout_intents_per_user: 1
		});
	});

	// The write path validates too, and throws a plain Error. What the handler
	// adds is the *type*: `reject` turns it into a ConvexError, which is the only
	// kind the console can read a message out of - a plain Error reaches the
	// client as an opaque server error. So this asserts `data`, not just the
	// message, because the message alone survives either way.
	test("refuses a duplicate threshold as an error the console can read", async () => {
		const t = testConvex();
		await seedSettings(t);
		const { admin } = await cast(t);

		await expect(
			admin.as.mutation(api.staff.settings.setThresholds, {
				thresholds: [
					{ signal: "egress_bandwidth", value: 1, sustainedSamples: 1 },
					{ signal: "egress_bandwidth", value: 2, sustainedSamples: 1 }
				]
			})
		).rejects.toMatchObject({
			data: expect.stringContaining("Duplicate threshold")
		});
	});

	test("refuses a threshold with a negative value", async () => {
		const t = testConvex();
		await seedSettings(t);
		const { admin } = await cast(t);

		await expect(
			admin.as.mutation(api.staff.settings.setThresholds, {
				thresholds: [
					{ signal: "egress_bandwidth", value: -1, sustainedSamples: 1 }
				]
			})
		).rejects.toMatchObject({ data: expect.any(String) });
	});

	test("records a set of thresholds it accepts", async () => {
		const t = testConvex();
		await seedSettings(t);
		const { admin } = await cast(t);

		await admin.as.mutation(api.staff.settings.setThresholds, {
			thresholds: [
				{ signal: "egress_bandwidth", value: 100, sustainedSamples: 3 },
				{ signal: "egress_pps", value: 200, sustainedSamples: 3 }
			]
		});

		expect((await settingsRow(t))?.thresholds).toMatchObject([
			{ signal: "egress_bandwidth", value: 100 },
			{ signal: "egress_pps", value: 200 }
		]);
	});

	// Snapshot policy is timing only, so every field is a positive whole number
	// of minutes or days; a zero retention would delete a snapshot as it is made.
	test.each([
		["a zero interval", { manualMinIntervalMinutes: 0 }],
		["a zero automatic retention", { automaticRetentionDays: 0 }],
		["a fractional automatic retention", { automaticRetentionDays: 1.5 }]
	])("refuses a snapshot policy with %s", async (_name, over) => {
		const t = testConvex();
		await seedSettings(t);
		const { admin } = await cast(t);

		await expect(
			admin.as.mutation(api.staff.settings.setSnapshotPolicy, {
				policy: {
					manualMinIntervalMinutes: 10,
					automaticRetentionDays: 7,
					...over
				}
			})
		).rejects.toMatchObject({ data: expect.any(String) });
	});

	test("records a snapshot policy it accepts", async () => {
		const t = testConvex();
		await seedSettings(t);
		const { admin } = await cast(t);

		await admin.as.mutation(api.staff.settings.setSnapshotPolicy, {
			policy: {
				manualMinIntervalMinutes: 15,
				automaticRetentionDays: 10
			}
		});

		expect(await settingsRow(t)).toMatchObject({
			snapshot_policy: { manual_min_interval_minutes: 15 }
		});
	});
});

// The alert raised when the capacity ceiling is taken away.
//
// Admission reads both Hetzner limits and fails closed when either is missing,
// so removing one silently stops every sale. Clearing a field is a legitimate
// edit and the console shows no error for it - this alert is the only thing that
// tells anybody. It fires on one transition out of four, and the three silent
// ones are silent for different reasons, so all four are named here.
describe("losing the capacity ceiling", () => {
	const setLimits = (
		admin: Awaited<ReturnType<typeof cast>>["admin"],
		serverLimit: number | null,
		snapshotLimit: number | null
	) =>
		admin.as.mutation(api.staff.settings.setHetznerLimits, {
			serverLimit,
			snapshotLimit
		});

	const capacityAlerts = async (t: Harness) =>
		(await staffAlerts(t)).filter((row) =>
			row.key.startsWith("capacity-admission-disabled:")
		);

	test("warns when a configured ceiling is cleared", async () => {
		const t = testConvex();
		await seedSettings(t);
		const { admin } = await cast(t);
		await setLimits(admin, 50, 500);

		await setLimits(admin, null, null);

		expect(await capacityAlerts(t)).toMatchObject([
			{ severity: "critical", subject: "Capacity admission disabled" }
		]);
	});

	// The pair is atomic at the boundary, so a half-configured ceiling never
	// reaches the settings row - admission would fail closed on it anyway, but
	// silently, and the alert below only fires for a deliberate clear.
	test.each([
		["the server limit alone", null, 500],
		["the snapshot limit alone", 50, null]
	])("refuses to clear %s", async (_name, serverLimit, snapshotLimit) => {
		const t = testConvex();
		await seedSettings(t);
		const { admin } = await cast(t);
		await setLimits(admin, 50, 500);

		await expect(setLimits(admin, serverLimit, snapshotLimit)).rejects.toThrow(
			/both Hetzner limits/
		);
		expect(await capacityAlerts(t)).toEqual([]);
	});

	// Naming who did it and what it costs is the whole value of the alert: it is
	// read by somebody who was not in the room when the field was cleared.
	test("names who removed it and what it stops", async () => {
		const t = testConvex();
		await seedSettings(t);
		const { admin } = await cast(t);
		await setLimits(admin, 50, 500);

		await setLimits(admin, null, null);

		const [alert] = await capacityAlerts(t);
		expect(alert.text).toContain(admin.clerkUserId);
		expect(alert.text).toContain("fails closed");
	});

	test("says nothing when a ceiling is set for the first time", async () => {
		const t = testConvex();
		await seedSettings(t);
		const { admin } = await cast(t);

		await setLimits(admin, 50, 500);

		expect(await capacityAlerts(t)).toEqual([]);
	});

	test("says nothing when a configured ceiling is only changed", async () => {
		const t = testConvex();
		await seedSettings(t);
		const { admin } = await cast(t);
		await setLimits(admin, 50, 500);

		await setLimits(admin, 80, 800);

		expect(await capacityAlerts(t)).toEqual([]);
	});

	// Nothing was protecting anything, so nothing was lost. An alert here would
	// fire on every edit of a deployment that has never configured capacity, and
	// staff would learn to ignore the one that matters.
	test("says nothing when there was no ceiling to lose", async () => {
		const t = testConvex();
		await seedSettings(t, {
			hetzner_server_limit: undefined,
			hetzner_snapshot_limit: undefined
		});
		const { admin } = await cast(t);

		await setLimits(admin, null, null);

		expect(await capacityAlerts(t)).toEqual([]);
	});

	// Deliberately not deduplicated, unlike the alerts a sweep raises. Removing
	// the ceiling is a person's deliberate act rather than a condition that
	// re-reports itself every hour, so each removal is its own alert and folding
	// the second into the first would hide it.
	test("raises a second alert for a second removal", async () => {
		const t = testConvex();
		await seedSettings(t);
		const { admin } = await cast(t);
		await setLimits(admin, 50, 500);
		await setLimits(admin, null, null);

		// The key carries the moment of the removal, so the clock has to move for
		// the second one to be a second event. It always has in production - these
		// are two trips through the console - and freezing time is what makes the
		// dependency visible here.
		vi.setSystemTime(NOW + 60_000);
		await setLimits(admin, 50, 500);
		await setLimits(admin, null, null);

		expect(await capacityAlerts(t)).toHaveLength(2);
	});
});

// The two alerts that record a deliberate fleet-wide decision.
//
// Neither reports a fault, which is why both are easy to leave untested: they
// exist so that a decision one person made in the console is legible to everyone
// else afterwards. Closing checkout stops all revenue; raising the runtime floor
// starts updating boxes automatically. Both are correct actions with
// consequences somebody else has to be able to reconstruct.
describe("recording a decision somebody made in the console", () => {
	const decisionAlerts = async (t: Harness, prefix: string) =>
		(await staffAlerts(t)).filter((row) => row.key.startsWith(prefix));

	describe("closing and reopening checkout", () => {
		const setCheckout = (
			admin: Awaited<ReturnType<typeof cast>>["admin"],
			enabled: boolean
		) => admin.as.mutation(api.staff.settings.setCheckoutEnabled, { enabled });

		// Closing checkout is critical and reopening is a resolution, so the two
		// sort differently in a console that reads by severity - the same message
		// at the same weight would bury the one that costs money.
		test.each([
			["closing it", false, "critical", "disabled"],
			["reopening it", true, "resolved", "enabled"]
		])("records %s", async (_name, enabled, severity, state) => {
			const t = testConvex();
			await seedSettings(t, { checkout_enabled: !enabled });
			const { admin } = await cast(t);

			await setCheckout(admin, enabled);

			expect(await decisionAlerts(t, `checkout-${state}:`)).toMatchObject([
				{ severity, subject: `Checkout ${state}` }
			]);
		});

		test("names who did it", async () => {
			const t = testConvex();
			await seedSettings(t, { checkout_enabled: true });
			const { admin } = await cast(t);

			await setCheckout(admin, false);

			const [alert] = await decisionAlerts(t, "checkout-disabled:");
			expect(alert.text).toContain(admin.clerkUserId);
		});

		// Setting it to what it already is is not a decision, and an alert for it
		// would fire on every save of an unrelated settings form.
		test.each([true, false])(
			"says nothing for a no-op set to %p",
			async (enabled) => {
				const t = testConvex();
				await seedSettings(t, { checkout_enabled: enabled });
				const { admin } = await cast(t);

				await setCheckout(admin, enabled);

				expect(await staffAlerts(t)).toEqual([]);
			}
		);
	});

	describe("raising the runtime floor", () => {
		test("records the floor, its deadline and who set it", async () => {
			const t = testConvex();
			await seedSettings(t);

			await t.mutation(internal.settings.setMinimumRuntime, {
				image: "ghcr.io/composery/composery:1.2.3",
				version: "1.2.3",
				deadline: NOW + 86_400_000,
				updatedBy: "admin"
			});

			const [alert] = await decisionAlerts(t, "minimum-runtime-set:");
			expect(alert).toMatchObject({
				severity: "warning",
				subject: "Minimum runtime version raised"
			});
			expect(alert.text).toContain("1.2.3");
			expect(alert.text).toContain("admin");
		});

		// A floor with no deadline warns boxes without ever updating them, which
		// is a different decision - so the alert has to say so rather than leave
		// the date blank.
		test("says so in words when the floor has no deadline", async () => {
			const t = testConvex();
			await seedSettings(t);

			await t.mutation(internal.settings.setMinimumRuntime, {
				image: "ghcr.io/composery/composery:1.2.3",
				version: "1.2.3",
				updatedBy: "admin"
			});

			const [alert] = await decisionAlerts(t, "minimum-runtime-set:");
			expect(alert.text).toContain("no deadline");
		});

		// Falls back to the image when no version was given, because an alert
		// that named neither would leave the reader without the thing that
		// changed.
		test("names the image when there is no version to name", async () => {
			const t = testConvex();
			await seedSettings(t);

			await t.mutation(internal.settings.setMinimumRuntime, {
				image: "ghcr.io/composery/composery@sha256:abc",
				version: null,
				updatedBy: "admin"
			});

			const [alert] = await decisionAlerts(t, "minimum-runtime-set:");
			expect(alert.text).toContain("ghcr.io/composery/composery@sha256:abc");
		});

		// Keyed on the floor rather than the moment: setting the same floor twice
		// is one decision, and the second save is somebody re-submitting a form.
		test("folds a repeat of the same floor into one alert", async () => {
			const t = testConvex();
			await seedSettings(t);
			const args = {
				image: "ghcr.io/composery/composery:1.2.3",
				version: "1.2.3",
				deadline: NOW + 86_400_000,
				updatedBy: "admin"
			};

			await t.mutation(internal.settings.setMinimumRuntime, args);
			await t.mutation(internal.settings.setMinimumRuntime, args);

			expect(await decisionAlerts(t, "minimum-runtime-set:")).toHaveLength(1);
		});
	});
});
