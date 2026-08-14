import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";

import {
	scheduledArgs,
	scheduledJobs,
	seedUser,
	staffAlerts,
	stubDeploymentEnv,
	testConvex,
	type Harness
} from "../../../support/convex.ts";

// A legal notice is the one email this service is obliged to deliver to a named
// person, and the one whose failure looks exactly like success: nothing throws,
// no customer complains, and the absence is only discovered by whoever asks, two
// years later, whether a particular customer was told. So what is asserted here
// is the record left behind - who has a row, who deliberately does not, and what
// the row says - rather than that the mutation ran.

// One address this deployment cannot hand over, so the walk's failure path is
// reachable at all.
//
// It has to be arranged rather than found: the component accepts a syntactically
// impossible address at queue time and lets Resend reject it later, so no input
// makes a real `sendEmail` throw for one recipient and not another. The mock
// delegates everything else to the real client, and what the tests below assert
// is ours - what the walk does with a recipient it could not hand over - never
// why the handover failed.
const UNREACHABLE = "unreachable@example.com";

// What the repository declares, replaced so the sweep has something to fan out.
// One notice announcing a document revision and one announcing a breach, because
// those are the two shapes `convex/model/legal.ts` admits and only the first
// carries a `version`.
const { DECLARED } = vi.hoisted(() => ({
	DECLARED: [
		{
			id: "terms-2026-09-15",
			version: "2026-09-15",
			subject: "A change to the Composery Terms of Service",
			text: "The Terms change on 15 September 2026. You may end your subscription free of charge within 30 days."
		},
		{
			id: "breach-2026-10-02",
			subject: "A security incident affecting your Composery account",
			text: "On 2 October 2026 we discovered unauthorised access to a system holding your email address."
		}
	]
}));

vi.mock("@/convex/model/legal", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/convex/model/legal")>()),
	LEGAL_NOTICES: DECLARED
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

			// Any address carrying UNREACHABLE fails, not only that address itself,
			// so a test needing several distinct unusable addresses can build them
			// by prefixing it.
			sendEmail(ctx: never, options: { to: string[] }) {
				if (options.to.some((address) => address.includes(UNREACHABLE))) {
					throw new Error("Resend rejected the recipient address.");
				}
				return this.inner.sendEmail(ctx, options as never);
			}
		}
	} as unknown as typeof actual;
});

const NOW = Date.UTC(2026, 8, 1, 9, 0, 0);
const NOTICE = {
	noticeId: "terms-2026-09-15",
	subject: "A change to the Composery Terms of Service on 15 September 2026",
	text: "We are changing the Terms of Service. You may end your subscription free of charge within 30 days."
};

beforeEach(() => {
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

function recipients(t: Harness) {
	return t.run(
		async (ctx) =>
			await ctx.db.query("legal_notice_recipients").withIndex("by_id").collect()
	);
}

function notices(t: Harness) {
	return t.run(async (ctx) => await ctx.db.query("legal_notices").collect());
}

async function seedUserAt(
	t: Harness,
	seed: Partial<Doc<"users">> & { clerk_user_id: string; email: string }
) {
	return await t.run(
		async (ctx) =>
			await ctx.db.insert("users", {
				role: "user",
				suspended: false,
				created_at: 1,
				updated_at: 1,
				...seed
			})
	);
}

const send = (t: Harness) =>
	t.mutation(internal.notice.legal.sendLegalNotice, NOTICE);

describe("sending a legal notice", () => {
	test("records one recipient per account holder", async () => {
		const t = testConvex();
		await seedUser(t, { clerkUserId: "clerk_a", email: "a@example.com" });
		await seedUser(t, { clerkUserId: "clerk_b", email: "b@example.com" });

		await send(t);

		const rows = await recipients(t);
		expect(rows.map((row) => row.email).sort()).toEqual([
			"a@example.com",
			"b@example.com"
		]);
		expect(rows.every((row) => row.queue_status === "queued")).toBe(true);
		// Distinct Resend ids are what prove these went out as two messages rather
		// than one message carrying two recipients. A notice on a durable medium is
		// information "addressed personally to that person", so the difference is
		// the difference between discharging the obligation and not.
		const ids = new Set(rows.map((row) => row.email_id));
		expect(ids.size).toBe(2);
		expect(ids.has(undefined)).toBe(false);
	});

	test("stores the notice as sent, with the cutoff that decided who got it", async () => {
		const t = testConvex();
		await seedUser(t, { clerkUserId: "clerk_a", email: "a@example.com" });

		await send(t);

		const [notice] = await notices(t);
		expect(notice).toMatchObject({
			notice_id: NOTICE.noticeId,
			subject: NOTICE.subject,
			text: NOTICE.text,
			started_at: NOW,
			recipient_count: 1
		});
		expect(notice?.finished_at).toBe(NOW);
		expect(notice?.cursor).toBeUndefined();
	});

	test("includes suspended accounts and accounts being deleted", async () => {
		const t = testConvex();
		await seedUserAt(t, {
			clerk_user_id: "clerk_suspended",
			email: "suspended@example.com",
			suspended: true
		});
		await seedUserAt(t, {
			clerk_user_id: "clerk_leaving",
			email: "leaving@example.com",
			deletion_pending: true
		});

		await send(t);

		expect((await recipients(t)).map((row) => row.email).sort()).toEqual([
			"leaving@example.com",
			"suspended@example.com"
		]);
	});

	test("skips an account whose deletion has finished", async () => {
		const t = testConvex();
		await seedUserAt(t, {
			clerk_user_id: "deleted:1",
			email: "deleted-user-1@deleted.invalid",
			deletion_finished_at: 5
		});
		await seedUserAt(t, {
			clerk_user_id: "clerk_live",
			email: "live@example.com"
		});

		await send(t);

		expect((await recipients(t)).map((row) => row.email)).toEqual([
			"live@example.com"
		]);
	});

	test("skips accounts created after the send began", async () => {
		const t = testConvex();
		await seedUserAt(t, {
			clerk_user_id: "clerk_old",
			email: "old@example.com"
		});
		await seedUserAt(t, {
			clerk_user_id: "clerk_new",
			email: "new@example.com",
			created_at: NOW + 1000
		});

		await send(t);

		expect((await recipients(t)).map((row) => row.email)).toEqual([
			"old@example.com"
		]);
	});

	test("re-running the same notice mails nobody twice", async () => {
		const t = testConvex();
		await seedUser(t, { clerkUserId: "clerk_a", email: "a@example.com" });

		await send(t);
		const first = await recipients(t);
		await send(t);

		const second = await recipients(t);
		expect(second).toHaveLength(1);
		expect(second[0]?._id).toBe(first[0]?._id);
		expect(second[0]?.email_id).toBe(first[0]?.email_id);
	});

	// A finished notice returns before the walk, so the test above proves the
	// cheap guard and not the one that matters. This is the one that matters: a
	// page replayed against an unfinished notice - a mutation retried, a
	// continuation delivered twice - must mail nobody a second time. The cursor is
	// rewound by hand because that is what a replay looks like from inside the
	// mutation, and there is no other way to arrive there on purpose.
	test("a replayed page mails nobody twice", async () => {
		const t = testConvex();
		await seedUser(t, { clerkUserId: "clerk_a", email: "a@example.com" });
		await send(t);
		const first = await recipients(t);

		await t.run(async (ctx) => {
			const [notice] = await ctx.db.query("legal_notices").collect();
			await ctx.db.patch(notice!._id, {
				cursor: undefined,
				finished_at: undefined
			});
		});
		await send(t);

		const second = await recipients(t);
		expect(second).toHaveLength(1);
		expect(second[0]?._id).toBe(first[0]?._id);
		expect(second[0]?.email_id).toBe(first[0]?.email_id);
		// The counter counts people told, so a replay must not inflate it either.
		expect((await notices(t))[0]?.recipient_count).toBe(1);
	});

	// The cutoff is written once, on the row, so a second page cannot inherit a
	// later "now". Without that, an account created while the walk was running
	// would be notified or not depending on how long the walk took.
	test("carries the original cutoff across pages", async () => {
		const t = testConvex();
		for (let index = 0; index < 51; index += 1) {
			await seedUserAt(t, {
				clerk_user_id: `clerk_${index}`,
				email: `user${index}@example.com`,
				created_at: index + 1
			});
		}

		await send(t);
		expect(await recipients(t)).toHaveLength(50);
		const continued = await scheduledJobs(t, "notice/legal:sendLegalNotice");
		expect(continued).toHaveLength(1);

		// An account that appears between the two pages is outside the cutoff and
		// stays outside it, even though the second page runs later.
		vi.setSystemTime(NOW + 60_000);
		await seedUserAt(t, {
			clerk_user_id: "clerk_latecomer",
			email: "latecomer@example.com",
			created_at: NOW + 30_000
		});
		await send(t);

		const rows = await recipients(t);
		expect(rows).toHaveLength(51);
		expect(rows.some((row) => row.email === "latecomer@example.com")).toBe(
			false
		);
		const [notice] = await notices(t);
		expect(notice?.started_at).toBe(NOW);
		expect(notice?.finished_at).toBe(NOW + 60_000);
	});
});

describe("when one recipient cannot be queued", () => {
	// The send does not stop, and the failure is not lost. A notice is owed to
	// each person separately, so one unusable address must not cost the other
	// ninety-nine theirs - and the one it does cost has to be named, because
	// nothing retries it and reaching them is a manual step.
	test("records the failure, mails everyone else, and names them to staff", async () => {
		const t = testConvex();
		await seedUserAt(t, { clerk_user_id: "clerk_bad", email: UNREACHABLE });
		await seedUserAt(t, {
			clerk_user_id: "clerk_good",
			email: "good@example.com"
		});

		await send(t);

		const rows = await recipients(t);
		expect(rows.map((row) => [row.email, row.queue_status]).sort()).toEqual([
			["good@example.com", "queued"],
			[UNREACHABLE, "queue_failed"]
		]);
		expect(
			rows.find((row) => row.queue_status === "queue_failed")?.delivery_error
		).toBeTruthy();

		// The notice still finishes: a failure that held the walk open would stop
		// the people after it in the page from ever being told.
		const [notice] = await notices(t);
		expect(notice?.finished_at).toBe(NOW);
		expect(notice?.recipient_count).toBe(1);

		expect(await staffAlerts(t)).toMatchObject([
			{
				key: `legal-notice-failed:${NOTICE.noticeId}`,
				severity: "critical",
				text: expect.stringContaining(UNREACHABLE)
			}
		]);
	});
});

describe("purging notice records", () => {
	test("removes recipients past their window, and the notice once none is left", async () => {
		const t = testConvex();
		await seedUser(t, { clerkUserId: "clerk_a", email: "a@example.com" });
		await send(t);

		// Six calendar years on, plus a day.
		vi.setSystemTime(Date.UTC(2032, 8, 2, 9, 0, 0));
		await t.mutation(internal.notice.legal.purgeExpiredLegalNotices, {});

		expect(await recipients(t)).toEqual([]);
		expect(await notices(t)).toEqual([]);
	});

	test("keeps a notice while any recipient row survives", async () => {
		const t = testConvex();
		await seedUser(t, { clerkUserId: "clerk_a", email: "a@example.com" });
		await send(t);

		await t.mutation(internal.notice.legal.purgeExpiredLegalNotices, {});

		expect(await recipients(t)).toHaveLength(1);
		expect(await notices(t)).toHaveLength(1);
	});
});

describe("when the notice cannot be sent", () => {
	test("records nobody and raises a critical alert", async () => {
		const t = testConvex();
		vi.stubEnv("RESEND_ACCOUNTS_FROM", "");
		await seedUser(t, { clerkUserId: "clerk_a", email: "a@example.com" });

		expect(await send(t)).toBe("unsendable");

		expect(await recipients(t)).toEqual([]);
		expect(await notices(t)).toEqual([]);
		const [alert] = await staffAlerts(t);
		expect(alert).toMatchObject({
			key: `legal-notice-unsendable:${NOTICE.noticeId}`,
			severity: "critical"
		});
		expect(alert?.text).toContain("RESEND_ACCOUNTS_FROM");
	});

	// Nothing is recorded as sent while the sender is missing, so the notice is
	// still owed and the next sweep is what pays it.
	test("sends to everyone once the sender is configured", async () => {
		const t = testConvex();
		vi.stubEnv("RESEND_ACCOUNTS_FROM", "");
		await seedUser(t, { clerkUserId: "clerk_a", email: "a@example.com" });
		await send(t);

		vi.stubEnv(
			"RESEND_ACCOUNTS_FROM",
			"Composery Accounts <accounts@composery.test>"
		);
		await send(t);

		expect((await recipients(t)).map((row) => row.email)).toEqual([
			"a@example.com"
		]);
	});
});

// Whether a notice was delivered is the other half of the evidence, and the half
// only Resend knows. It arrives as an event carrying nothing but an email id, so
// what these assert is that the id is resolved to the right stream: this
// deployment now sends three kinds of mail, and the fallback that used to mean
// "then it is a box owner notice" is reached by elimination.
describe("what became of a notice", () => {
	async function deliverEvent(t: Harness, type: string, emailId: string) {
		await t.mutation(internal.staff.alerts.recordEmailEvent, {
			id: emailId,
			event: {
				type,
				created_at: "2026-09-01T09:00:00.000Z",
				data: {
					created_at: "2026-09-01T09:00:00.000Z",
					email_id: emailId,
					from: "Composery Accounts <accounts@composery.test>",
					to: "a@example.com",
					subject: NOTICE.subject,
					...(type === "email.bounced"
						? {
								bounce: {
									type: "Permanent",
									subType: "General",
									message: "The mailbox does not exist."
								}
							}
						: {})
				}
			}
		} as never);
	}

	async function sendToOne(t: Harness) {
		await seedUser(t, { clerkUserId: "clerk_a", email: "a@example.com" });
		await send(t);
		const [row] = await recipients(t);
		return row!;
	}

	test("a delivered notice is recorded against the person it was owed to", async () => {
		const t = testConvex();
		const row = await sendToOne(t);

		await deliverEvent(t, "email.delivered", row.email_id!);

		const [updated] = await recipients(t);
		expect(updated?.last_email_event).toBe("email.delivered");
		expect(updated?.delivery_error).toBeUndefined();
		expect(await staffAlerts(t)).toEqual([]);
	});

	// The regression this file exists to prevent. Before the third sender, an
	// event matching no staff alert could only be a box owner notice, and the
	// fallback said so in the alert text. A bounced legal notice arriving there
	// would have told staff that "a box owner was not told what happened to their
	// box" - a true-sounding sentence about the wrong customer and the wrong
	// obligation, in place of the one that needed acting on.
	test("a bounced notice is reported as a legal notice, not an owner notice", async () => {
		const t = testConvex();
		const row = await sendToOne(t);

		await deliverEvent(t, "email.bounced", row.email_id!);

		const [updated] = await recipients(t);
		expect(updated?.last_email_event).toBe("email.bounced");
		expect(updated?.delivery_error).toBe("The mailbox does not exist.");
		expect(await staffAlerts(t)).toMatchObject([
			{
				severity: "critical",
				subject: "A Composery legal notice was not delivered",
				text: expect.stringContaining(NOTICE.noticeId)
			}
		]);
	});

	test("a complaint is reported as the sending-reputation problem it is", async () => {
		const t = testConvex();
		const row = await sendToOne(t);

		await deliverEvent(t, "email.complained", row.email_id!);

		expect(await staffAlerts(t)).toMatchObject([
			{
				severity: "critical",
				subject: "A customer marked a Composery legal notice as spam"
			}
		]);
	});
});

describe("the sweep", () => {
	// The repository declares no notices until the first legal change ships, so
	// the declaration is replaced here rather than read.
	//
	// Comparing the sweep's output against the real `LEGAL_NOTICES` would be two
	// empty lists today and, worse, the same list on both sides for ever after -
	// a test that restates the sweep's input as its expectation cannot fail for
	// the reason it exists. Two notices go in, two literal expectations come out,
	// and what is actually asserted is the mapping the sweep performs: `id`
	// becomes `noticeId`, subject and text ride along untouched, one scheduled
	// send each, in declaration order.
	test("schedules every declared notice, verbatim", async () => {
		const t = testConvex();
		await t.mutation(internal.notice.legal.sweepLegalNotices, {});

		expect(
			await scheduledArgs<typeof NOTICE>(t, "notice/legal:sendLegalNotice")
		).toEqual([
			{
				noticeId: "terms-2026-09-15",
				subject: "A change to the Composery Terms of Service",
				text: "The Terms change on 15 September 2026. You may end your subscription free of charge within 30 days."
			},
			{
				noticeId: "breach-2026-10-02",
				subject: "A security incident affecting your Composery account",
				text: "On 2 October 2026 we discovered unauthorised access to a system holding your email address."
			}
		]);
	});
});

// How many unreachable addresses the alert names, and how it says there are
// more.
//
// Nothing retries a failed legal notice, so this alert is the whole work list:
// each address on it is a person somebody now has to reach by hand. It names a
// few and then says there are more, rather than either listing an unbounded set
// into an email or quietly truncating - a truncated list would read as complete,
// and the accounts past the cut would never be contacted.
describe("naming the accounts a legal notice did not reach", () => {
	// One more than the alert will name, so the "and more" it appends is the only
	// thing telling the reader the list is partial.
	const OVER_THE_LIMIT = 6;

	async function unreachableAccounts(t: Harness, count: number) {
		for (let index = 0; index < count; index += 1) {
			await seedUserAt(t, {
				clerk_user_id: `clerk_bad_${index}`,
				// The stub fails any address containing UNREACHABLE, so each of these
				// is distinct and unreachable at once.
				email: `bad${index}.${UNREACHABLE}`
			});
		}
	}

	// Asserted as the exact sentence rather than as "contains the address", so
	// that what follows the last name is pinned too: a list that ends in
	// something other than a full stop is a list the reader cannot tell is
	// complete.
	test("names them all, and ends there, while they fit", async () => {
		const t = testConvex();
		await unreachableAccounts(t, 2);

		await send(t);

		const [alert] = await staffAlerts(t);
		expect(alert.text).toContain(
			`was not queued for bad0.${UNREACHABLE}, bad1.${UNREACHABLE}.`
		);
	});

	test("says there are more once there are too many to name", async () => {
		const t = testConvex();
		await unreachableAccounts(t, OVER_THE_LIMIT);

		await send(t);

		const [alert] = await staffAlerts(t);
		expect(alert.text).toContain("and more");
	});

	// The point of the cut: an alert cannot grow with the fleet, or a
	// misconfigured sender on a large deployment produces one nobody can read.
	test("names a bounded number of them however many there are", async () => {
		const t = testConvex();
		await unreachableAccounts(t, OVER_THE_LIMIT + 20);

		await send(t);

		const [alert] = await staffAlerts(t);
		const named = [...alert.text.matchAll(/bad(\d+)\./g)].length;
		expect(named).toBeGreaterThan(0);
		expect(named).toBeLessThan(OVER_THE_LIMIT);
	});

	// It tells the reader what to do next. Nothing retries this, so an alert that
	// only reported the failure would leave the remedy to be rediscovered.
	test("says what to do about them", async () => {
		const t = testConvex();
		await seedUserAt(t, { clerk_user_id: "clerk_bad", email: UNREACHABLE });

		await send(t);

		const [alert] = await staffAlerts(t);
		expect(alert.text).toContain("Nothing retries this automatically");
		expect(alert.text).toContain("skips everyone already recorded");
	});

	// Nobody failed, so there is nothing to work through - and an alert saying
	// so would train staff to close this one unread.
	test("says nothing at all when everyone was reached", async () => {
		const t = testConvex();
		await seedUserAt(t, {
			clerk_user_id: "clerk_good",
			email: "good@example.com"
		});

		await send(t);

		expect(await staffAlerts(t)).toEqual([]);
	});
});

// What a second run of a finished notice answers.
//
// A re-run is how somebody checks on a notice, and how a half-sent one is
// finished by hand after the sender is fixed. It has to be able to say "already
// done" - an answer that instead re-sent would mail every account holder a
// second copy of a legal notice.
describe("re-running a notice that already finished", () => {
	test("answers that it is finished, and mails nobody again", async () => {
		const t = testConvex();
		await seedUserAt(t, {
			clerk_user_id: "clerk_good",
			email: "good@example.com"
		});
		await send(t);
		const before = await recipients(t);

		expect(await send(t)).toBe("finished");
		expect(await recipients(t)).toEqual(before);
	});
});

// How far the purge goes in one run, and what it will not touch.
//
// It walks a table that grows with every notice sent to every account, so it
// takes a page at a time and asks itself back when the page was full. Two things
// have to hold or it stops being a purge: a full page must lead to another run,
// or rows past the first page live forever; and a notice inside its window must
// survive, or a retention period becomes advisory.
describe("how far the purge goes in one run", () => {
	const purge = (t: Harness) =>
		t.mutation(internal.notice.legal.purgeExpiredLegalNotices, {});

	async function expiredRecipients(t: Harness, count: number) {
		await t.run(async (ctx) => {
			await ctx.db.insert("legal_notices", {
				notice_id: NOTICE.noticeId,
				subject: NOTICE.subject,
				text: NOTICE.text,
				started_at: NOW - 10_000,
				recipient_count: count,
				purge_at: NOW - 1
			});
			for (let index = 0; index < count; index += 1) {
				await ctx.db.insert("legal_notice_recipients", {
					notice_id: NOTICE.noticeId,
					user_id: `clerk_${index}`,
					email: `person${index}@example.com`,
					queue_status: "queued",
					created_at: NOW - 10_000,
					purge_at: NOW - 1
				});
			}
		});
	}

	// A full page means there is more to do, so the run asks itself back rather
	// than leaving the remainder for a sweep that may not come.
	test("asks itself back when it filled a page", async () => {
		const t = testConvex();
		await expiredRecipients(t, 50);

		await purge(t);

		expect(await scheduledJobs(t)).not.toEqual([]);
	});

	test("stops when the page was not full", async () => {
		const t = testConvex();
		await expiredRecipients(t, 2);

		await purge(t);

		expect(await recipients(t)).toEqual([]);
		expect(await scheduledJobs(t)).toEqual([]);
	});

	// The window is the retention promise. A notice one millisecond inside it is
	// still inside it.
	test("keeps a notice whose window has not closed", async () => {
		const t = testConvex();
		await t.run(
			async (ctx) =>
				await ctx.db.insert("legal_notices", {
					notice_id: "future",
					subject: NOTICE.subject,
					text: NOTICE.text,
					started_at: NOW - 10_000,
					recipient_count: 0,
					purge_at: NOW + 1
				})
		);

		await purge(t);

		expect(await notices(t)).toHaveLength(1);
	});

	// And one whose window closed exactly now is out: the boundary belongs to the
	// purge, so a row cannot sit on it forever.
	test("removes a notice whose window closed exactly now", async () => {
		const t = testConvex();
		await t.run(
			async (ctx) =>
				await ctx.db.insert("legal_notices", {
					notice_id: "due",
					subject: NOTICE.subject,
					text: NOTICE.text,
					started_at: NOW - 10_000,
					recipient_count: 0,
					purge_at: NOW
				})
		);

		await purge(t);

		expect(await notices(t)).toEqual([]);
	});
});
