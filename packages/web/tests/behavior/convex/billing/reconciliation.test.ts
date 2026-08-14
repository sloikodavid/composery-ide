import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { components, internal } from "@/convex/_generated/api";
import { reconciliationFailureAlert } from "@/convex/billing/reconciliation";

import {
	boxOperations,
	readBox,
	seedBox,
	seedUser,
	staffAlerts,
	stubDeploymentEnv,
	testConvex,
	type Harness
} from "../../../support/convex.ts";

// Reconciliation is the backstop for Polar's webhooks: whatever the webhooks
// missed, this sweep notices by asking Polar directly. It is the only thing
// standing between a cancelled subscription and a box that keeps running - and,
// pointed the wrong way, the only thing that could tear down a box someone is
// still paying for. Both directions are tested.
const NOW = Date.UTC(2026, 9, 10, 11, 12, 13);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	stubDeploymentEnv();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

// Written through the Polar component's own mutation rather than into its
// tables, so the row is shaped the way the component would have shaped it.
async function seedSubscription(
	t: Harness,
	id: string,
	overrides: {
		endedAt?: string | null;
		productId?: string;
		status?: string;
	} = {}
) {
	await t.mutation(components.polar.lib.updateSubscription, {
		subscription: {
			id,
			customerId: "cus_1",
			createdAt: new Date(NOW - 1000).toISOString(),
			modifiedAt: null,
			amount: 1000,
			currency: "usd",
			recurringInterval: "month",
			status: overrides.status ?? "active",
			currentPeriodStart: new Date(NOW - 1000).toISOString(),
			currentPeriodEnd: new Date(NOW + 1000).toISOString(),
			cancelAtPeriodEnd: false,
			startedAt: new Date(NOW - 1000).toISOString(),
			endedAt: overrides.endedAt ?? null,
			productId: overrides.productId ?? "air-monthly",
			checkoutId: null,
			metadata: {}
		}
	});
}

async function sweep(t: Harness) {
	await t.action(internal.billing.reconciliation.reconcileBoxSubscriptions, {});
}

describe("reconciling boxes against Polar", () => {
	test("leaves a box whose subscription is still active alone", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			polar_subscription_id: "sub_live",
			status: "running"
		});
		await seedSubscription(t, "sub_live", { status: "active" });

		await sweep(t);

		expect(await readBox(t, boxId)).toMatchObject({ status: "running" });
		expect(await boxOperations(t, boxId)).toEqual([]);
	});

	test.each(["canceled", "revoked", "unpaid"])(
		"tears down a box whose subscription is %s",
		async (status) => {
			const t = testConvex();
			const owner = await seedUser(t);
			const boxId = await seedBox(t, {
				user_id: owner.clerkUserId,
				polar_subscription_id: `sub_${status}`,
				status: "running"
			});
			await seedSubscription(t, `sub_${status}`, { status });

			await sweep(t);

			expect(await readBox(t, boxId)).toMatchObject({ status: "deleting" });
		}
	);

	// A subscription can end without its status saying so, so the end date is
	// checked as well as the word.
	test("tears down a box whose subscription has already ended", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			polar_subscription_id: "sub_ended",
			status: "running"
		});
		await seedSubscription(t, "sub_ended", {
			status: "active",
			endedAt: new Date(NOW - 1).toISOString()
		});

		await sweep(t);

		expect(await readBox(t, boxId)).toMatchObject({ status: "deleting" });
	});

	test("leaves a box whose subscription ends in the future alone", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			polar_subscription_id: "sub_ending",
			status: "running"
		});
		await seedSubscription(t, "sub_ending", {
			status: "active",
			endedAt: new Date(NOW + 60_000).toISOString()
		});

		await sweep(t);

		expect(await readBox(t, boxId)).toMatchObject({ status: "running" });
	});

	// The failure that matters most. A comp is backed by no subscription at all,
	// so "no active subscription" is its normal state - a sweep that read that as
	// grounds for deletion would delete every comped box on its first run.
	test("never tears down a comped box, which has no subscription by design", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			comped_at: NOW - 1000,
			comped_by: "admin",
			status: "running"
		});

		await sweep(t);

		expect(await readBox(t, boxId)).toMatchObject({ status: "running" });
		expect(await boxOperations(t, boxId)).toEqual([]);
	});

	// Polar not knowing about a subscription is not the same as Polar saying it
	// was cancelled, and the difference is somebody's files.
	test("leaves a box alone when Polar has no record of its subscription", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			polar_subscription_id: "sub_unknown",
			status: "running"
		});

		await sweep(t);

		expect(await readBox(t, boxId)).toMatchObject({ status: "running" });
	});

	test("does not start a second teardown for a box already being deleted", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			polar_subscription_id: "sub_gone",
			status: "deleting"
		});
		await seedSubscription(t, "sub_gone", { status: "revoked" });

		await sweep(t);

		expect(await boxOperations(t, boxId)).toEqual([]);
	});

	// One box that cannot be torn down must not stop the sweep reaching the rest
	// of the fleet - the next box in the page is somebody else's bill.
	test("keeps sweeping past a box it could not act on", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const busy = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "busy",
			polar_subscription_id: "sub_busy",
			status: "running"
		});
		await t.run(
			async (ctx) =>
				await ctx.db.insert("box_operations", {
					box_id: busy,
					type: "repair",
					status: "running",
					idempotency_key: `repair:${busy}`,
					trigger: "owner",
					created_at: NOW - 1000,
					updated_at: NOW - 1000
				})
		);
		const free = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "free",
			polar_subscription_id: "sub_free",
			status: "running"
		});
		await seedSubscription(t, "sub_busy", { status: "revoked" });
		await seedSubscription(t, "sub_free", { status: "revoked" });

		await sweep(t);

		expect(await readBox(t, busy)).toMatchObject({ status: "running" });
		expect(await readBox(t, free)).toMatchObject({ status: "deleting" });
	});

	test("raises no staff alert on a clean run", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		await seedBox(t, {
			user_id: owner.clerkUserId,
			polar_subscription_id: "sub_live",
			status: "running"
		});
		await seedSubscription(t, "sub_live");

		await sweep(t);

		expect(await staffAlerts(t)).toEqual([]);
	});
});

// A box's plan is fixed at purchase, so a subscription that has drifted onto a
// different plan's product is not a change to apply - it is a state that should
// not exist, and the only safe response is to say so.
describe("a subscription that no longer matches its box's plan", () => {
	async function boxOnPlan(t: Harness, plan: "air" | "pro", productId: string) {
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			plan,
			polar_subscription_id: "sub_live",
			status: "running"
		});
		await seedSubscription(t, "sub_live", { productId });
		return boxId;
	}

	test("reports a subscription moved to another plan's product", async () => {
		const t = testConvex();
		const boxId = await boxOnPlan(t, "air", "pro-monthly");

		await sweep(t);

		// Reported, never acted on: resizing a live box is not something this
		// system does, and rebilling the customer silently would be worse.
		expect(await boxOperations(t, boxId)).toEqual([]);
		expect(await readBox(t, boxId)).toMatchObject({ plan: "air" });
		expect(await staffAlerts(t)).toMatchObject([
			{
				severity: "warning",
				subject: "Box subscription no longer matches its plan"
			}
		]);
	});

	// Monthly and annual are two products for one plan, so moving between them
	// changes the money and nothing about the box. It is not a mismatch.
	test.each(["air-monthly", "air-annual"])(
		"stays quiet about a billing-cycle change to %s",
		async (productId) => {
			const t = testConvex();
			const boxId = await boxOnPlan(t, "air", productId);

			await sweep(t);

			expect(await staffAlerts(t)).toEqual([]);
			expect(await boxOperations(t, boxId)).toEqual([]);
		}
	);

	// A product this deployment does not sell is worse than plan drift, not
	// milder: it means nothing here can say what any customer is paying for, and
	// the next sale against that product gets refunded. Staying quiet about it
	// would look healthy for exactly as long as nobody checked.
	test("reports a product it does not recognise", async () => {
		const t = testConvex();
		const boxId = await boxOnPlan(t, "air", "prod_from_another_catalogue");

		await sweep(t);

		expect(await boxOperations(t, boxId)).toEqual([]);
		expect(await readBox(t, boxId)).toMatchObject({ plan: "air" });
		expect(await staffAlerts(t)).toMatchObject([
			{
				severity: "warning",
				subject: "Box subscription is on a product Composery does not sell"
			}
		]);
	});

	// The same failure seen through an unconfigured deployment: every product id
	// is missing, so every subscription reads as unrecognised. It is reported per
	// box and product, which is what lets one alert per box reach a person rather
	// than one silent skip per box reach nobody.
	test("reports a box whose product ids are not configured at all", async () => {
		const t = testConvex();
		vi.stubEnv("POLAR_BOX_AIR_MONTHLY_PRODUCT_ID", "");
		vi.stubEnv("POLAR_BOX_AIR_ANNUAL_PRODUCT_ID", "");
		vi.stubEnv("POLAR_BOX_PRO_MONTHLY_PRODUCT_ID", "");
		vi.stubEnv("POLAR_BOX_PRO_ANNUAL_PRODUCT_ID", "");
		await boxOnPlan(t, "air", "air-monthly");

		await sweep(t);

		expect(await staffAlerts(t)).toMatchObject([
			{ subject: "Box subscription is on a product Composery does not sell" }
		]);
	});

	// A comp has no subscription at all, so nothing can drift.
	test("never reports a comped box", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		await seedBox(t, {
			user_id: owner.clerkUserId,
			plan: "air",
			comped_at: NOW - 1000,
			comped_by: "staff",
			status: "running"
		});

		await sweep(t);

		expect(await staffAlerts(t)).toEqual([]);
	});
});

// What staff are told when the sweep stops early.
//
// The sweep runs hourly and re-raises whatever stopped it, so the alert is the
// only durable record of a failure that Convex's action log will age out. Two
// things have to hold: the cause travels with it, and an outage that lasts all
// day does not become either one missed alert or twenty-four ignored ones.
describe("reporting that reconciliation stopped early", () => {
	const SIX_HOURS = 6 * 60 * 60 * 1000;

	test("carries the cause into the alert staff read", () => {
		const alert = reconciliationFailureAlert(
			new Error("Polar returned 503"),
			NOW
		);

		expect(alert.text).toContain("Polar returned 503");
		expect(alert.severity).toBe("critical");
	});

	// A sweep can be stopped by something that was never an Error - a rejected
	// string, a thrown object - and an alert that said "[object Object]" would
	// send staff to the logs with nothing to search for.
	test.each([
		["a plain string", "connection reset", "connection reset"],
		["a thrown object", { code: 500 }, "[object Object]"]
	])("still says something for %s", (_name, thrown, expected) => {
		expect(reconciliationFailureAlert(thrown, NOW).text).toContain(expected);
	});

	// It names what stopped, not just that something did: the reader is deciding
	// whether boxes have gone unchecked.
	test("says what stopped and where to look", () => {
		const alert = reconciliationFailureAlert(new Error("boom"), NOW);

		expect(alert.subject).toBe("Polar subscription reconciliation failed");
		expect(alert.text).toContain("before it could check every box");
	});

	// Measured from the start of the window the clock is in, because that is what
	// the key divides by - not from whenever the first failure happened.
	const WINDOW_START = Math.floor(NOW / SIX_HOURS) * SIX_HOURS;

	test("repeats within one six-hour window under one key", () => {
		const first = reconciliationFailureAlert(new Error("a"), WINDOW_START);
		const later = reconciliationFailureAlert(
			new Error("b"),
			WINDOW_START + SIX_HOURS - 1
		);

		expect(later.key).toBe(first.key);
	});

	// A failure still going in the next window is news again - it has outlasted
	// six hourly attempts, and staff who dismissed the first one need telling.
	test("becomes a new alert in the next window", () => {
		const first = reconciliationFailureAlert(new Error("a"), WINDOW_START);
		const next = reconciliationFailureAlert(
			new Error("a"),
			WINDOW_START + SIX_HOURS
		);

		expect(next.key).not.toBe(first.key);
	});

	// The window is anchored to the clock rather than to the first failure, so
	// two deployments failing at the same moment agree on the window, and a
	// restart cannot start a fresh one.
	test("anchors the window to the clock, not to the first failure", () => {
		const window = Math.floor(NOW / SIX_HOURS);

		expect(reconciliationFailureAlert(new Error("a"), NOW).key).toBe(
			`subscription-reconciliation-failed:${window}`
		);
	});
});
