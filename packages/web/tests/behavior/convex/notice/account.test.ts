import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { internal } from "@/convex/_generated/api";
import { accountNoticeEmail } from "@/convex/notice/account";
import { customerEmailAlertKey } from "@/convex/email";
import { BOXES_PATH } from "@/convex/model/box/path";
import { SUPPORT_EMAIL } from "@/convex/model/links";

import {
	seedUser,
	staffAlerts,
	stubDeploymentEnv,
	testConvex,
	type Harness
} from "../../../support/convex.ts";

// What an account holder is told when staff suspend or restore their account,
// and - the half this exists for - exactly when.
//
// An account notice keeps no row of its own, so unlike the box notices there is
// no `box.owner_emailed` event to read the wiring off. The client is wrapped
// instead, which is the only way to see a message that is handed to a queue and
// forgotten. What that buys is worth the wrapper: the interesting assertions
// here are all about counting, and both failures are silent - an account nobody
// told, and an account told twice for one staff click.

type SentEmail = {
	replyTo?: string[];
	subject: string;
	text: string;
	to: string | string[];
};

const { sent, UNREACHABLE } = vi.hoisted(() => ({
	sent: [] as SentEmail[],
	// One address the deployment cannot hand over, so the never-throw contract is
	// reachable. Arranged rather than found: the component accepts an impossible
	// address at queue time and lets Resend reject it later.
	UNREACHABLE: "unreachable@example.com"
}));

vi.mock("@convex-dev/resend", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@convex-dev/resend")>();
	return {
		...actual,
		Resend: class {
			readonly inner: InstanceType<typeof actual.Resend>;

			constructor(...args: ConstructorParameters<typeof actual.Resend>) {
				this.inner = new actual.Resend(...args);
			}

			sendEmail(ctx: never, options: SentEmail) {
				if (options.to === UNREACHABLE) {
					throw new Error("Resend rejected the recipient address.");
				}
				sent.push(options);
				return this.inner.sendEmail(ctx, options as never);
			}
		}
	} as unknown as typeof actual;
});

const NOW = Date.UTC(2026, 8, 3, 11, 0, 0);
const STAFF_REASON = "Suspended pending a security investigation.";

beforeEach(() => {
	sent.length = 0;
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	stubDeploymentEnv();
	vi.stubEnv("RESEND_API_KEY", "re_test");
	vi.stubEnv(
		"RESEND_ACCOUNTS_FROM",
		"Composery Accounts <accounts@composery.test>"
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

async function suspend(
	t: Harness,
	clerkUserId: string,
	suspended: boolean,
	reason?: string
) {
	await t.mutation(internal.staff.users.setUserSuspension, {
		callerClerkUserId: "clerk_staff",
		clerkUserId,
		reason,
		suspended
	});
}

describe("what an account notice says", () => {
	test("a suspension explains what stopped and promises the files remain", () => {
		const { subject, text } = accountNoticeEmail({
			type: "suspended",
			reason: STAFF_REASON
		});

		expect(subject).toBe("Your Composery account has been suspended");
		expect(text).toContain("cannot create, change or start boxes");
		expect(text).toContain("Nothing has been deleted");
		expect(text).toContain("have the suspension reviewed");
	});

	// The same reason the account block shows this person on the website. Two
	// Composery explanations of one event must not give two answers.
	test("a suspension forwards the reason staff recorded", () => {
		const { text } = accountNoticeEmail({
			type: "suspended",
			reason: STAFF_REASON
		});

		expect(text).toContain(STAFF_REASON);
	});

	test("a suspension with no reason still stands on its own", () => {
		const { text } = accountNoticeEmail({
			type: "suspended",
			reason: undefined
		});

		expect(text).not.toContain("undefined");
		expect(text).toContain("has been suspended");
	});

	test("an unsuspension says the account and its boxes are back", () => {
		const { subject, text } = accountNoticeEmail({ type: "unsuspended" });

		expect(subject).toBe("Your Composery account is active again");
		expect(text).toContain("has been lifted");
		expect(text).toContain("brought back");
	});

	test("a deployment with no website origin loses the link, not the sentence", () => {
		vi.stubEnv("WEBSITE_ORIGIN", "");
		const { text } = accountNoticeEmail({ type: "unsuspended" });

		expect(text).not.toContain("undefined");
		expect(text).not.toContain("Your account:");
		expect(text).toContain("has been lifted");
	});
});

describe("when an account notice is sent", () => {
	// The gap this whole module closes. Suspending an account suspends its boxes
	// and each of those mails its owner, so an account with a running box was
	// already told - by accident. An account with none was told nothing at all,
	// and that is most of the people worth suspending: somebody between
	// purchases, somebody whose boxes are stopped, somebody yet to buy.
	test("an account with no boxes at all is still told", async () => {
		const t = testConvex();
		const user = await seedUser(t, {
			clerkUserId: "clerk_customer",
			email: "customer@example.com"
		});

		await suspend(t, user.clerkUserId, true, STAFF_REASON);

		expect(sent).toEqual([
			expect.objectContaining({
				to: "customer@example.com",
				subject: "Your Composery account has been suspended"
			})
		]);
		expect(sent[0]?.text).toContain(STAFF_REASON);
	});

	test("restoring the account tells them that too", async () => {
		const t = testConvex();
		const user = await seedUser(t, {
			clerkUserId: "clerk_customer",
			email: "customer@example.com",
			suspended: true
		});

		await suspend(t, user.clerkUserId, false);

		expect(sent).toEqual([
			expect.objectContaining({
				subject: "Your Composery account is active again"
			})
		]);
	});

	// This mutation is idempotent on purpose and the console will happily call it
	// on an account already in that state. Everything else about a repeat call is
	// a no-op; an email is the one effect a person would notice, and a second one
	// reads as a second suspension.
	test.each([true, false])(
		"setting suspended=%s twice mails once",
		async (suspended) => {
			const t = testConvex();
			const user = await seedUser(t, {
				clerkUserId: "clerk_customer",
				email: "customer@example.com",
				suspended: !suspended
			});

			await suspend(t, user.clerkUserId, suspended, STAFF_REASON);
			await suspend(t, user.clerkUserId, suspended, STAFF_REASON);

			expect(sent).toHaveLength(1);
		}
	);

	test("a finished deletion is never mailed, whatever happens to its row", async () => {
		const t = testConvex();
		await t.run(
			async (ctx) =>
				await ctx.db.insert("users", {
					clerk_user_id: "deleted:1",
					email: "deleted-user-1@deleted.invalid",
					role: "user",
					suspended: false,
					deletion_finished_at: 5,
					created_at: 1,
					updated_at: 1
				})
		);

		await suspend(t, "deleted:1", true, STAFF_REASON);

		expect(sent).toEqual([]);
	});

	// The contract this whole module is written around: the notice is the last
	// thing in a transaction that has already suspended the account, so a send
	// that cannot be queued must cost the notice and never the suspension.
	test("a send that cannot be queued alerts staff and still suspends", async () => {
		const t = testConvex();
		const user = await seedUser(t, {
			clerkUserId: "clerk_customer",
			email: UNREACHABLE
		});

		await suspend(t, user.clerkUserId, true, STAFF_REASON);

		expect(sent).toEqual([]);
		expect(await staffAlerts(t)).toMatchObject([
			{
				severity: "warning",
				subject: "An account holder could not be emailed",
				text: expect.stringContaining(UNREACHABLE)
			}
		]);
		const [row] = await t.run(
			async (ctx) => await ctx.db.query("users").collect()
		);
		expect(row?.suspended).toBe(true);
	});

	// One alert per six-hour window, however many customers could not be reached:
	// a queue failure is a property of the deployment, not of any one of them.
	test("two failures in the same window open one alert", async () => {
		const t = testConvex();
		const first = await seedUser(t, {
			clerkUserId: "clerk_one",
			email: UNREACHABLE
		});
		const second = await seedUser(t, {
			clerkUserId: "clerk_two",
			email: UNREACHABLE
		});

		await suspend(t, first.clerkUserId, true, STAFF_REASON);
		await suspend(t, second.clerkUserId, true, STAFF_REASON);

		expect(await staffAlerts(t)).toHaveLength(1);
	});

	test("a deployment with no account sender mails nobody and fails nothing", async () => {
		const t = testConvex();
		vi.stubEnv("RESEND_ACCOUNTS_FROM", "");
		const user = await seedUser(t, { clerkUserId: "clerk_customer" });

		await suspend(t, user.clerkUserId, true, STAFF_REASON);

		expect(sent).toEqual([]);
		// The suspension itself still happened - the notice is the last thing in
		// the transaction and may never be what undoes it.
		const [row] = await t.run(
			async (ctx) => await ctx.db.query("users").collect()
		);
		expect(row?.suspended).toBe(true);
	});
});

// The message a customer actually receives, whole.
//
// Everything above asks whether a particular sentence is present, which is the
// right question for each one on its own and cannot answer the one that matters
// here: what does the person read? A notice is assembled from a list of
// paragraphs, some of which drop out, so the failures worth catching are between
// the sentences rather than in them - a doubled blank line where the reason
// should have been, a link line that survived without its link, an order that
// puts "nothing has been deleted" after the sign-off.
//
// So these assert the whole body. It is the only assertion here that a reordering
// or a lost separator cannot pass.
describe("the message a customer receives, whole", () => {
	// Built from the same two pieces the message is, so the test does not pin a
	// hostname the deployment owns. Read when the test runs, not when this block
	// is evaluated - the origin is stubbed in beforeEach.
	const accountLink = () => `${process.env.WEBSITE_ORIGIN}${BOXES_PATH}`;

	test("a suspension, with the reason staff gave", () => {
		expect(
			accountNoticeEmail({ type: "suspended", reason: STAFF_REASON }).text
		).toBe(
			[
				"Your Composery account has been suspended.",
				"While it is suspended you cannot create, change or start boxes, and any box that was running has been suspended with the account.",
				STAFF_REASON,
				"Nothing has been deleted. Your files are exactly as you left them and come back with the account.",
				`Your account: ${accountLink()}`,
				`Reply to this email to have the suspension reviewed - it reaches ${SUPPORT_EMAIL}.`
			].join("\n\n")
		);
	});

	// The reason simply is not there, rather than being there as a blank. The
	// paragraphs are joined by a blank line, so a dropped one that left its
	// separator behind reads as a gap the customer will wonder about.
	test("a suspension with no reason closes the gap where it would have been", () => {
		expect(
			accountNoticeEmail({ type: "suspended", reason: undefined }).text
		).toBe(
			[
				"Your Composery account has been suspended.",
				"While it is suspended you cannot create, change or start boxes, and any box that was running has been suspended with the account.",
				"Nothing has been deleted. Your files are exactly as you left them and come back with the account.",
				`Your account: ${accountLink()}`,
				`Reply to this email to have the suspension reviewed - it reaches ${SUPPORT_EMAIL}.`
			].join("\n\n")
		);
	});

	test("an unsuspension", () => {
		expect(accountNoticeEmail({ type: "unsuspended" }).text).toBe(
			[
				"The suspension on your Composery account has been lifted.",
				"You can use the account normally again, and any box that was suspended with it has been brought back.",
				`Your account: ${accountLink()}`,
				`Reply to this email if you need a hand - it reaches ${SUPPORT_EMAIL}.`
			].join("\n\n")
		);
	});

	// A deployment with no website origin has no page to send anyone to, so the
	// line goes rather than pointing at nothing.
	test("an unsuspension from a deployment with no website", () => {
		vi.stubEnv("WEBSITE_ORIGIN", "");

		expect(accountNoticeEmail({ type: "unsuspended" }).text).toBe(
			[
				"The suspension on your Composery account has been lifted.",
				"You can use the account normally again, and any box that was suspended with it has been brought back.",
				`Reply to this email if you need a hand - it reaches ${SUPPORT_EMAIL}.`
			].join("\n\n")
		);
	});

	// The two notices sign off differently on purpose: one invites a challenge,
	// the other offers help. Saying "have the suspension reviewed" to somebody
	// whose suspension was just lifted would be an invitation to argue a case
	// they have already won.
	test("the two notices sign off differently", () => {
		const suspended = accountNoticeEmail({
			type: "suspended",
			reason: undefined
		}).text;
		const restored = accountNoticeEmail({ type: "unsuspended" }).text;

		expect(suspended).toContain("have the suspension reviewed");
		expect(restored).not.toContain("have the suspension reviewed");
		expect(restored).toContain("if you need a hand");
	});
});

// Which stream an undeliverable-email alert belongs to.
//
// Both customer email streams fold their failures into one alert per window, so
// the stream name is the only thing keeping them apart. Were they to share a
// key, whichever failed first would swallow the other for the rest of the
// window - and the two have different causes and different senders, so being
// told about one is not being told about the other.
describe("which stream an undeliverable-email alert belongs to", () => {
	test("an account failure is keyed to the accounts stream", async () => {
		const t = testConvex();
		const user = await seedUser(t, {
			clerkUserId: "clerk_customer",
			email: UNREACHABLE
		});

		await suspend(t, user.clerkUserId, true, STAFF_REASON);

		expect(await staffAlerts(t)).toMatchObject([
			{ key: customerEmailAlertKey("accounts") }
		]);
	});

	// The two keys differ by more than their window, which is what a shared
	// window value cannot tell you on its own.
	test("the two streams cannot collide in one window", () => {
		expect(customerEmailAlertKey("accounts")).not.toBe(
			customerEmailAlertKey("notices")
		);
	});

	// Named for the stream rather than for the customer: one deployment-wide
	// misconfiguration must not raise an alert per person it failed to reach.
	test("names the stream and nothing about the customer", async () => {
		const t = testConvex();
		const user = await seedUser(t, {
			clerkUserId: "clerk_customer",
			email: UNREACHABLE
		});

		await suspend(t, user.clerkUserId, true, STAFF_REASON);

		const [alert] = await staffAlerts(t);
		expect(alert.key).toContain("accounts-email-failed:");
		expect(alert.key).not.toContain(UNREACHABLE);
		expect(alert.key).not.toContain("clerk_customer");
	});
});

// Where a reply goes.
//
// Every one of these messages ends by inviting a reply - to have a suspension
// reviewed, or to ask for help - and they are sent from a no-reply-shaped
// account address that nobody watches. The reply-to header is what makes the
// invitation true. Without it the sentence is still there, the customer still
// answers it, and the answer goes nowhere: a silent failure on the one path a
// suspended customer has to reach a person.
describe("where a reply to an account notice goes", () => {
	// Both notices, because the reply-to is written out once per message rather
	// than shared - and the restored one is the one a customer is least likely to
	// be told about twice.
	test.each([
		["a suspension", true],
		["a restoration", false]
	])("%s replies to support", async (_name, suspended) => {
		const t = testConvex();
		const user = await seedUser(t, { clerkUserId: "clerk_customer" });
		// A notice is sent for a change of state, so the account has to start
		// opposite to where the test puts it.
		await suspend(t, user.clerkUserId, !suspended, STAFF_REASON);
		sent.length = 0;

		await suspend(t, user.clerkUserId, suspended, STAFF_REASON);

		expect(sent).toMatchObject([{ replyTo: [SUPPORT_EMAIL] }]);
	});

	// The address the customer is told to write to is the address replies
	// actually go to. Two different ones would send half of them nowhere.
	test("sends replies to the address the message names", async () => {
		const t = testConvex();
		const user = await seedUser(t, { clerkUserId: "clerk_customer" });

		await suspend(t, user.clerkUserId, true, STAFF_REASON);

		const [message] = sent;
		expect(message.text).toContain(message.replyTo?.[0]);
	});
});
