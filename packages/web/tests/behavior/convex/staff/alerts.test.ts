import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "@/convex/_generated/api";

import { STALE_DELIVERY_MS } from "@/convex/staff/alerts";

import {
	seedUser,
	staffAlerts,
	stubDeploymentEnv,
	testConvex,
	type Harness
} from "../../../support/convex.ts";

// The queue side of a staff alert: who it goes to, and what the row says
// afterwards. Every other suite runs with no Resend key at all, so the branch
// that actually hands an alert to the component - the one every incident in
// production takes - was only ever exercised in its disabled form.

const NOW = Date.UTC(2026, 6, 28, 9, 0, 0);

// Every sender a production deployment sets, not just this module's own. The
// health panel reports one line per class of mail, so a harness configuring only
// the alert sender would describe a deployment that cannot mail a customer at
// all - and "healthy" below would be asserting the opposite of what it says.
function stubSender() {
	vi.stubEnv("RESEND_API_KEY", "re_test");
	vi.stubEnv("RESEND_ALERTS_FROM", "Composery Alerts <alerts@composery.test>");
	vi.stubEnv(
		"RESEND_NOTICES_FROM",
		"Composery Notices <notices@composery.test>"
	);
	vi.stubEnv(
		"RESEND_ACCOUNTS_FROM",
		"Composery Accounts <accounts@composery.test>"
	);
}

const ALERT = {
	key: "test-alert",
	severity: "warning" as const,
	subject: "Something needs a person",
	text: "The details."
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	stubDeploymentEnv();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("queueing a staff alert", () => {
	test("hands it to Resend once for every admin", async () => {
		stubSender();
		const t = testConvex();
		await seedUser(t, { clerkUserId: "admin_one", role: "admin" });
		await seedUser(t, { clerkUserId: "admin_two", role: "admin" });
		await seedUser(t, { clerkUserId: "customer", role: "user" });

		await t.mutation(internal.staff.alerts.raise, ALERT);

		expect(await staffAlerts(t)).toMatchObject([
			{
				key: "test-alert",
				queue_status: "queued",
				recipient_count: 2,
				email_id: expect.any(String)
			}
		]);
	});

	// An account that may not act may not be mailed either. Both conditions run
	// through the same gate every other entry point uses, so an admin locked out
	// of the console cannot keep receiving its incidents at an address the
	// deployment has already decided not to trust.
	test("skips an admin who is suspended or being deleted", async () => {
		stubSender();
		const t = testConvex();
		await seedUser(t, { clerkUserId: "admin_live", role: "admin" });
		await seedUser(t, {
			clerkUserId: "admin_suspended",
			role: "admin",
			suspended: true
		});
		await seedUser(t, {
			clerkUserId: "admin_deleting",
			role: "admin",
			deletionPending: true
		});

		await t.mutation(internal.staff.alerts.raise, ALERT);

		expect(await staffAlerts(t)).toMatchObject([{ recipient_count: 1 }]);
	});

	test("records that a configured deployment has nobody to tell", async () => {
		stubSender();
		const t = testConvex();
		await seedUser(t, { role: "user" });

		await t.mutation(internal.staff.alerts.raise, ALERT);

		expect(await staffAlerts(t)).toMatchObject([
			{ queue_status: "no_recipients", recipient_count: 0 }
		]);
	});

	test("keeps the alert when there is no sender, rather than losing it", async () => {
		const t = testConvex();
		await seedUser(t, { role: "admin" });

		await t.mutation(internal.staff.alerts.raise, ALERT);

		expect(await staffAlerts(t)).toMatchObject([
			{ queue_status: "disabled", subject: "Something needs a person" }
		]);
	});

	// The retry sweep is what makes the row above a delay rather than a loss.
	test("the retry sweep queues an alert once its sender appears", async () => {
		const t = testConvex();
		await seedUser(t, { role: "admin" });
		await t.mutation(internal.staff.alerts.raise, ALERT);

		stubSender();
		await t.mutation(internal.staff.alerts.retryPending, {});

		expect(await staffAlerts(t)).toMatchObject([
			{ queue_status: "queued", recipient_count: 1 }
		]);
	});

	test("a second alert on the same key does not send twice", async () => {
		stubSender();
		const t = testConvex();
		await seedUser(t, { role: "admin" });

		await t.mutation(internal.staff.alerts.raise, ALERT);
		await t.mutation(internal.staff.alerts.raise, {
			...ALERT,
			subject: "Same incident, said again"
		});

		expect(await staffAlerts(t)).toMatchObject([
			{ subject: "Something needs a person" }
		]);
	});
});

// What the console says about the channel itself. It is the one report a staff
// member can still read when no alert can reach them by email, so an entry in it
// has to mean something is actually wrong.
describe("alert delivery health", () => {
	async function staffHarness() {
		const t = testConvex();
		const admin = await seedUser(t, { role: "admin" });
		return { admin, t };
	}

	test("reports a configured, quiet deployment as healthy", async () => {
		stubSender();
		vi.stubEnv("RESEND_WEBHOOK_SECRET", "whsec_test");
		const { admin } = await staffHarness();

		expect(await admin.as.query(api.staff.alerts.health, {})).toMatchObject({
			senders: { accounts: true, alerts: true, notices: true },
			deliveryTrackingConfigured: true,
			recipientCount: 1,
			recentIssues: []
		});
	});

	// Without the webhook secret no delivery event ever arrives, so an alert that
	// was handed over perfectly well sits at "sent" for ever. Ageing that into a
	// delivery issue, reported one alert at a time, buries the deployment's actual
	// problem - the missing secret - which the panel already states on its own
	// line.
	test("does not age a handed-over alert into an issue when nothing tracks delivery", async () => {
		stubSender();
		const { admin, t } = await staffHarness();
		await t.mutation(internal.staff.alerts.raise, ALERT);

		vi.setSystemTime(NOW + 60 * 60 * 1000);

		expect(await admin.as.query(api.staff.alerts.health, {})).toMatchObject({
			deliveryTrackingConfigured: false,
			recentIssues: []
		});
	});

	// The same alert on a deployment that can be told: silence past the window is
	// now genuinely unaccounted for.
	test("reports an alert Resend never accounted for once delivery is tracked", async () => {
		stubSender();
		vi.stubEnv("RESEND_WEBHOOK_SECRET", "whsec_test");
		const { admin, t } = await staffHarness();
		await t.mutation(internal.staff.alerts.raise, ALERT);

		vi.setSystemTime(NOW + 60 * 60 * 1000);

		expect(await admin.as.query(api.staff.alerts.health, {})).toMatchObject({
			recentIssues: [{ queueStatus: "queued", subject: ALERT.subject }]
		});
	});

	test("reports an alert this deployment could not hand over at all", async () => {
		const { admin, t } = await staffHarness();
		await t.mutation(internal.staff.alerts.raise, ALERT);

		expect(await admin.as.query(api.staff.alerts.health, {})).toMatchObject({
			senders: { accounts: false, alerts: false, notices: false },
			recentIssues: [{ queueStatus: "disabled" }]
		});
	});

	test("refuses a customer the report", async () => {
		const t = testConvex();
		const customer = await seedUser(t, { role: "user" });

		await expect(
			customer.as.query(api.staff.alerts.health, {})
		).rejects.toThrow(/Staff access required/);
	});
});

// The delivery panel: whether the thing that tells staff about problems is
// itself working. It is the one report that, when wrong, is wrong silently -
// every other failure in this deployment is meant to arrive as one of these
// emails, so an alert that never left counts as no failure at all.
describe("reporting whether staff alerts are actually being delivered", () => {
	async function staff(t: Harness) {
		return await seedUser(t, {
			clerkUserId: "admin",
			email: "admin@example.com",
			role: "admin"
		});
	}

	async function alert(t: Harness, over: Record<string, unknown> = {}) {
		return await t.run(
			async (ctx) =>
				await ctx.db.insert("staff_alerts", {
					key: `k-${Math.random()}`,
					severity: "warning",
					subject: "Something happened",
					text: "body",
					queue_status: "queued",
					recipient_count: 1,
					purge_at: NOW + 60_000,
					created_at: NOW - 1000,
					updated_at: NOW - 1000,
					...over
				})
		);
	}

	const health = (admin: Awaited<ReturnType<typeof seedUser>>) =>
		admin.as.query(api.staff.alerts.health, {});

	test("says nothing is wrong when the last alerts were queued cleanly", async () => {
		const t = testConvex();
		const admin = await staff(t);
		await alert(t, { last_email_event: "email.delivered" });

		expect((await health(admin)).recentIssues).toEqual([]);
	});

	// An alert the provider refused is an alert nobody read.
	test.each([
		"email.bounced",
		"email.failed",
		"email.complained",
		"email.delivery_delayed"
	])("reports an alert whose delivery %s", async (event) => {
		const t = testConvex();
		const admin = await staff(t);
		await alert(t, { last_email_event: event });

		expect((await health(admin)).recentIssues).toMatchObject([
			{ lastEmailEvent: event }
		]);
	});

	// Never queued at all is the worst case: the alert exists as a row and was
	// never handed to the provider.
	test.each(["queue_failed", "disabled", "no_recipients", "pending"] as const)(
		"reports an alert that was %s rather than queued",
		async (queue_status) => {
			const t = testConvex();
			const admin = await staff(t);
			await alert(t, { queue_status, delivery_error: "no sender configured" });

			expect((await health(admin)).recentIssues).toMatchObject([
				{ queueStatus: queue_status, error: "no sender configured" }
			]);
		}
	);

	// An alert with no event yet is not a problem until it has had time to
	// arrive - reporting it immediately would make the panel permanently red.
	test("does not call a freshly queued alert a problem", async () => {
		const t = testConvex();
		vi.stubEnv("RESEND_WEBHOOK_SECRET", "whsec_test");
		const admin = await staff(t);
		await alert(t, { created_at: NOW });

		expect((await health(admin)).recentIssues).toEqual([]);
	});

	// Once it has had that time and still nothing came back, the delivery
	// tracking is telling us nothing - which is itself the problem.
	test("reports an alert that has been silent for too long", async () => {
		const t = testConvex();
		vi.stubEnv("RESEND_WEBHOOK_SECRET", "whsec_test");
		const admin = await staff(t);
		await alert(t, { created_at: NOW - STALE_DELIVERY_MS });

		expect((await health(admin)).recentIssues).toHaveLength(1);
	});

	// Without a webhook secret nothing will ever report delivery, so silence
	// carries no information and must not be read as a fault - the panel reports
	// the missing secret on its own line instead.
	test("does not read silence as a fault when nothing tracks delivery", async () => {
		const t = testConvex();
		vi.stubEnv("RESEND_WEBHOOK_SECRET", "");
		const admin = await staff(t);
		await alert(t, { created_at: NOW - STALE_DELIVERY_MS });

		const result = await health(admin);
		expect(result.deliveryTrackingConfigured).toBe(false);
		expect(result.recentIssues).toEqual([]);
	});

	// The panel is a summary, not a log: it shows the newest problems and says
	// how many recipients would get the next one.
	//
	// The count comes from the `users` table - every account whose role carries
	// `staff_alerts` - and from nothing else. There is no recipient list in the
	// environment, so seeding one admin is what makes this one, and the exact
	// number is asserted rather than "more than none": with the recipients
	// derived from seeded rows, a floor of zero is a check the harness satisfies
	// on its own.
	test("counts the recipients the next alert would reach", async () => {
		const t = testConvex();
		const admin = await staff(t);

		expect((await health(admin)).recipientCount).toBe(1);
	});

	test("refuses the panel to somebody who is not staff", async () => {
		const t = testConvex();
		const stranger = await seedUser(t, {
			clerkUserId: "stranger",
			email: "stranger@example.com"
		});

		await expect(
			stranger.as.query(api.staff.alerts.health, {})
		).rejects.toThrow("Staff access required.");
	});
});

// Old alerts are swept so the table does not grow without bound, and the sweep
// re-drives itself while a batch stays full.
describe("purging alerts past their retention", () => {
	const purge = (t: Harness) =>
		t.mutation(internal.staff.alerts.purgeExpired, {});

	async function aged(t: Harness, count: number, purge_at: number) {
		await t.run(async (ctx) => {
			for (let index = 0; index < count; index += 1) {
				await ctx.db.insert("staff_alerts", {
					key: `old-${index}`,
					severity: "warning",
					subject: "Old",
					text: "body",
					queue_status: "queued",
					recipient_count: 1,
					purge_at,
					created_at: 1,
					updated_at: 1
				});
			}
		});
	}

	const rows = (t: Harness) =>
		t.run((ctx) => ctx.db.query("staff_alerts").collect());

	test("removes an alert whose retention has run out", async () => {
		const t = testConvex();
		await aged(t, 1, NOW - 1);

		await purge(t);

		expect(await rows(t)).toEqual([]);
	});

	test("keeps one whose retention has not", async () => {
		const t = testConvex();
		await aged(t, 1, NOW + 1);

		await purge(t);

		expect(await rows(t)).toHaveLength(1);
	});
});

// The delivery panel: whether the thing that tells staff about problems is
// itself working. It is the one report that, when wrong, is wrong silently -
// every other failure in this deployment is meant to arrive as one of these
// emails, so an alert that never left counts as no failure at all.
