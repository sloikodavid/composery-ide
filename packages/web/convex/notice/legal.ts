import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { LEGAL_NOTICES } from "../model/legal";
import { SUPPORT_EMAIL } from "../model/links";
import { billingRecordPurgeAt } from "../boxes/retention";
import { accountsSender, resendClient } from "../email";
import { raiseAlert } from "../staff/alerts";

// What every account holder is told, and the proof that they were told it.
//
// This is the only channel that reaches the whole customer base, and it exists
// for the two things the law requires be delivered to a person rather than
// published at them:
//
//   - a modification of the service that affects them, which Article 19 of
//     Directive (EU) 2019/770 - in Ireland the Consumer Rights Act 2022 - says
//     must reach them "on a durable medium", and
//   - a personal data breach likely to be a high risk to them, which Article 34
//     GDPR says must be communicated directly and without undue delay.
//
// Both obligations are owed per person, and both put the burden of proof on us,
// which is why a recipient row exists for each one rather than a single "sent"
// flag on the notice. `convex/model/legal.ts` holds what is sent and explains why
// deploying is what sends it.
//
// This is not a feed and must never become one. Everything a customer might like
// to know - their box started, an update is waiting, their invoice - already has
// an owner: the box's own page, `convex/notice/owner.ts`, or Polar. Mail that a
// person did not need to receive is what makes them stop reading the mail they
// did, and this channel's entire value is that they read it.

// Bounded so one mutation stays well inside a transaction, and so a send that
// goes wrong stops after a page rather than the fleet.
const NOTICE_PAGE_SIZE = 50;
const FAILURE_EXAMPLES = 5;

type NoticeInput = { noticeId: string; subject: string; text: string };

// A notice reaches the accounts that existed when its send began, and no others.
//
// `started_at` is recorded once, on the row, rather than read as "now" on each
// page. Both halves of that matter. An account created after we started telling
// people about a change already meets the changed documents when it signs up, so
// there is nothing to tell it. And a cutoff re-read per page would drift forward
// through a multi-page send, quietly pulling in accounts created mid-walk - a
// cohort that would be notified or not depending on how long the walk took.
async function noticeRow(ctx: MutationCtx, input: NoticeInput) {
	const existing = await ctx.db
		.query("legal_notices")
		.withIndex("notice_id", (query) => query.eq("notice_id", input.noticeId))
		.first();
	if (existing) return existing;

	const startedAt = Date.now();
	const id = await ctx.db.insert("legal_notices", {
		notice_id: input.noticeId,
		subject: input.subject,
		text: input.text,
		started_at: startedAt,
		recipient_count: 0,
		purge_at: billingRecordPurgeAt(startedAt)
	});
	return await ctx.db.get(id);
}

// Whether this account can be told anything at all.
//
// A finished account deletion has already replaced the address with a
// `@deleted.invalid` placeholder, so mailing it is a guaranteed bounce aimed at
// somebody who asked to be forgotten. Everyone else is included, deliberately
// without exception: a suspended customer still holds the contract the notice is
// about, an account midway through deletion still has a real address and may
// still be a data subject of the breach being reported, and staff hold accounts
// on the same terms as anyone else. Each of those is an argument someone could
// make for an exclusion, and every exclusion here is a person who was not told.
function reachable(user: Doc<"users">) {
	return !user.deletion_finished_at;
}

async function alreadyRecorded(
	ctx: MutationCtx,
	noticeId: string,
	userId: string
) {
	return Boolean(
		await ctx.db
			.query("legal_notice_recipients")
			.withIndex("notice_id_user_id", (query) =>
				query.eq("notice_id", noticeId).eq("user_id", userId)
			)
			.first()
	);
}

async function mailRecipient(
	ctx: MutationCtx,
	notice: Doc<"legal_notices">,
	user: Doc<"users">,
	from: string
) {
	const timestamp = Date.now();
	const record = {
		notice_id: notice.notice_id,
		user_id: user.clerk_user_id,
		email: user.email,
		created_at: timestamp,
		purge_at: billingRecordPurgeAt(timestamp)
	};

	try {
		const emailId = await resendClient().sendEmail(ctx, {
			from,
			// One message per person. A notice on a durable medium is defined as
			// information "addressed personally to that person", so a single message
			// carrying fifty recipients would not be one - quite apart from disclosing
			// fifty customers to each other. The component batches these into Resend's
			// batch endpoint underneath, so the cost of doing it correctly is nil.
			to: [user.email],
			subject: notice.subject,
			text: notice.text,
			// No `List-Unsubscribe`. This is a transactional message in every regime
			// that draws the line - CAN-SPAM lists notification of "a change in the
			// terms or features of" an account as a transactional or relationship
			// message, and ePrivacy consent rules govern direct marketing, which this
			// is not. Offering an opt-out would be worse than pointless: it would
			// invite a customer to waive a notice we are obliged to give them, and
			// leave us with a record of having done so.
			replyTo: [SUPPORT_EMAIL]
		});
		await ctx.db.insert("legal_notice_recipients", {
			...record,
			email_id: emailId,
			queue_status: "queued"
		});
		return true;
	} catch (error) {
		await ctx.db.insert("legal_notice_recipients", {
			...record,
			queue_status: "queue_failed",
			delivery_error: error instanceof Error ? error.message : String(error)
		});
		return false;
	}
}

// Report the recipients this notice could not even hand to Resend.
//
// Raised once per notice, when its walk finishes, rather than per recipient:
// what a person has to act on is "these customers were not told", and the answer
// is the same manual step whether it is one of them or forty.
async function reportFailures(ctx: MutationCtx, notice: Doc<"legal_notices">) {
	const failed = await ctx.db
		.query("legal_notice_recipients")
		.withIndex("notice_id_queue_status", (query) =>
			query.eq("notice_id", notice.notice_id).eq("queue_status", "queue_failed")
		)
		.take(FAILURE_EXAMPLES + 1);
	if (failed.length === 0) return;

	const examples = failed.slice(0, FAILURE_EXAMPLES);
	await raiseAlert(ctx, {
		key: `legal-notice-failed:${notice.notice_id}`,
		severity: "critical",
		subject: `Legal notice ${notice.notice_id} could not be sent to every account`,
		text: `"${notice.subject}" was not queued for ${examples
			.map((row) => row.email)
			.join(", ")}${
			failed.length > examples.length ? ", and more" : ""
		}.\n\nThese customers have not been told. Nothing retries this automatically, because a second attempt from the same broken configuration would only add rows saying the same thing. Fix the sender, then re-run the notice sweep from the Convex dashboard: it skips everyone already recorded and picks up exactly the accounts that are missing.`
	});
}

// Send one notice to everyone who has not had it yet, a page at a time.
//
// Takes the notice as arguments rather than reading `LEGAL_NOTICES` itself, so
// the walk, the cutoff, and the record-keeping are exercised by tests with real
// arguments instead of only ever being reachable through whatever the repository
// happens to declare today - which, at launch, is nothing at all.
export const sendLegalNotice = internalMutation({
	args: {
		noticeId: v.string(),
		subject: v.string(),
		text: v.string()
	},
	handler: async (ctx, args) => {
		const from = accountsSender();
		if (!from) {
			// The loudest thing this module does, because it is the failure that looks
			// most like success: no error, no queue, no row, and a legal obligation
			// silently discharged into nothing.
			await raiseAlert(ctx, {
				key: `legal-notice-unsendable:${args.noticeId}`,
				severity: "critical",
				subject: `Legal notice ${args.noticeId} cannot be sent`,
				text: `The notice "${args.subject}" is waiting to go to every account holder, and this deployment has no RESEND_ACCOUNTS_FROM sender configured, so none of it has been sent to anyone.\n\nThis is a notice the service is obliged to deliver individually. Set RESEND_API_KEY and RESEND_ACCOUNTS_FROM on this deployment; the sweep picks the notice up on its next run and nothing has been recorded as sent in the meantime.`
			});
			return "unsendable" as const;
		}

		const notice = await noticeRow(ctx, args);
		if (!notice) return "unsendable" as const;
		if (notice.finished_at) return "finished" as const;

		const page = await ctx.db
			.query("users")
			.withIndex("created_at", (query) =>
				query.lt("created_at", notice.started_at)
			)
			.paginate({ cursor: notice.cursor ?? null, numItems: NOTICE_PAGE_SIZE });

		let sent = 0;
		for (const user of page.page) {
			if (!reachable(user)) continue;
			if (await alreadyRecorded(ctx, notice.notice_id, user.clerk_user_id)) {
				continue;
			}
			if (await mailRecipient(ctx, notice, user, from)) sent += 1;
		}

		await ctx.db.patch(notice._id, {
			cursor: page.isDone ? undefined : page.continueCursor,
			finished_at: page.isDone ? Date.now() : undefined,
			recipient_count: notice.recipient_count + sent
		});

		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.notice.legal.sendLegalNotice, {
				noticeId: args.noticeId,
				subject: args.subject,
				text: args.text
			});
			return "continued" as const;
		}

		const finished = await ctx.db.get(notice._id);
		if (finished) await reportFailures(ctx, finished);
		return "finished" as const;
	}
});

// Start any declared notice that has not finished. Idempotent by construction -
// a finished notice returns immediately and an unfinished one skips every
// account already recorded - so running it on a schedule costs a handful of
// point reads on the overwhelmingly common day when there is nothing to send.
export const sweepLegalNotices = internalMutation({
	args: {},
	handler: async (ctx) => {
		for (const notice of LEGAL_NOTICES) {
			// Scheduled rather than run inline: one transaction per notice, so a page
			// of one notice's recipients cannot be rolled back by a different
			// notice's failure, and the sweep's own transaction stays a few writes
			// however many notices the repository has accumulated.
			await ctx.scheduler.runAfter(0, internal.notice.legal.sendLegalNotice, {
				noticeId: notice.id,
				subject: notice.subject,
				text: notice.text
			});
		}
		return LEGAL_NOTICES.length;
	}
});

export const purgeExpiredLegalNotices = internalMutation({
	args: {},
	handler: async (ctx) => {
		const timestamp = Date.now();
		const recipients = await ctx.db
			.query("legal_notice_recipients")
			// purge_at is required on this table, so the lower bound is not the
			// missing-field guard it is elsewhere; it is here because the index is
			// shared with nothing and a bare lte() reads identically either way.
			.withIndex("purge_at", (query) =>
				query.gte("purge_at", 0).lte("purge_at", timestamp)
			)
			.take(NOTICE_PAGE_SIZE);
		for (const recipient of recipients) await ctx.db.delete(recipient._id);

		const notices = await ctx.db
			.query("legal_notices")
			.withIndex("notice_id")
			.take(NOTICE_PAGE_SIZE);
		for (const notice of notices) {
			if (notice.purge_at > timestamp) continue;
			const remaining = await ctx.db
				.query("legal_notice_recipients")
				.withIndex("notice_id_user_id", (query) =>
					query.eq("notice_id", notice.notice_id)
				)
				.first();
			if (!remaining) await ctx.db.delete(notice._id);
		}

		if (recipients.length === NOTICE_PAGE_SIZE) {
			await ctx.scheduler.runAfter(
				0,
				internal.notice.legal.purgeExpiredLegalNotices,
				{}
			);
		}
		return recipients.length;
	}
});
