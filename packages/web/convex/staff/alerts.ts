import { vOnEmailEventArgs, type EmailEvent } from "@convex-dev/resend";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import {
	internalMutation,
	query,
	type MutationCtx,
	type QueryCtx
} from "../_generated/server";
import {
	alertsSender,
	emailDeliveryTracked,
	emailSendersConfigured,
	resendClient
} from "../email";
import { staffConsoleUrl } from "../env";
import {
	requireCapability,
	rolesWithCapability,
	userHasCapability
} from "../users";
import { vStaffAlertSeverity } from "../schema";
import { DAY_MS, MINUTE_MS } from "../time";

// What staff are told about the deployment, and whether they were reachable.
//
// A row is inserted first and mailed second, deliberately: the row is the record
// that an incident happened, and it survives a deployment that cannot send mail
// at all. `queue_status` is therefore about this side of the handover only -
// what became of a message Resend accepted arrives later as an email event.

const RECIPIENT_LIMIT = 50;
// Exported only because the Fixed windows table states it: `// window:` binds
// the number in the doc to this constant, and the test that pins the pair reads
// the exported value.
// window: Staff-alert record retention
export const STAFF_ALERT_RETENTION_MS = 180 * DAY_MS;
const RETRY_BATCH = 20;
const PURGE_BATCH = 200;
const RECENT_ALERT_LIMIT = 50;
const RECENT_ISSUE_LIMIT = 10;
// How long an alert may go without a delivery event before the panel calls the
// silence a problem. Exported for the test that pins that behaviour, so a
// retune moves the test with it rather than failing it.
export const STALE_DELIVERY_MS = 30 * MINUTE_MS;

type AlertInput = {
	key: string;
	severity: Doc<"staff_alerts">["severity"];
	subject: string;
	text: string;
};

// Who an alert goes to.
//
// Bounded by the read, not after it. The old shape collected every account
// holding the role and then stopped adding at the limit, so the ceiling capped
// the recipient list while the cost still scaled with how many staff accounts
// existed - and the console asks this on every render of its health panel.
//
// ponytail: the first RECIPIENT_LIMIT accounts per role, so a deployment with
// more staff than that could in principle read a page of accounts that are all
// suspended and mail nobody. It reports `recipientCount: 0` when that happens,
// which is the same signal a deployment with no admins at all gets.
async function alertRecipients(ctx: Pick<QueryCtx, "db">) {
	const emails = new Set<string>();
	for (const role of rolesWithCapability("staff_alerts")) {
		const users = await ctx.db
			.query("users")
			.withIndex("role", (query) => query.eq("role", role))
			.take(RECIPIENT_LIMIT);
		for (const user of users) {
			if (userHasCapability(user, "staff_alerts")) emails.add(user.email);
			if (emails.size >= RECIPIENT_LIMIT) return [...emails];
		}
	}
	return [...emails];
}

async function enqueueAlert(ctx: MutationCtx, alert: Doc<"staff_alerts">) {
	const from = alertsSender();
	if (!from) {
		await ctx.db.patch(alert._id, {
			queue_status: "disabled",
			updated_at: Date.now()
		});
		return;
	}

	const to = await alertRecipients(ctx);
	if (to.length === 0) {
		await ctx.db.patch(alert._id, {
			queue_status: "no_recipients",
			recipient_count: 0,
			updated_at: Date.now()
		});
		return;
	}

	try {
		const emailId = await resendClient().sendEmail(ctx, {
			from,
			to,
			subject: alert.subject,
			text: alert.text
		});
		await ctx.db.patch(alert._id, {
			queue_status: "queued",
			recipient_count: to.length,
			email_id: emailId,
			delivery_error: undefined,
			updated_at: Date.now()
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await ctx.db.patch(alert._id, {
			queue_status: "queue_failed",
			recipient_count: to.length,
			delivery_error: message,
			updated_at: Date.now()
		});
		console.error("Failed to queue staff alert email", error);
	}
}

export async function raiseAlert(ctx: MutationCtx, input: AlertInput) {
	const existing = await ctx.db
		.query("staff_alerts")
		.withIndex("key", (query) => query.eq("key", input.key))
		.first();
	if (existing) return existing._id;

	const timestamp = Date.now();
	const alertId = await ctx.db.insert("staff_alerts", {
		...input,
		queue_status: "pending",
		recipient_count: 0,
		created_at: timestamp,
		updated_at: timestamp,
		purge_at: timestamp + STAFF_ALERT_RETENTION_MS
	});
	const alert = await ctx.db.get(alertId);
	if (alert) await enqueueAlert(ctx, alert);
	return alertId;
}

export const raise = internalMutation({
	args: {
		key: v.string(),
		severity: vStaffAlertSeverity,
		subject: v.string(),
		text: v.string()
	},
	handler: async (ctx, args) => {
		return await raiseAlert(ctx, args);
	}
});

function deliveryError(event: EmailEvent) {
	if (event.type === "email.bounced") return event.data.bounce.message;
	if (event.type === "email.failed") return event.data.failed.reason;
	if (event.type === "email.complained")
		return "Recipient marked the email as spam.";
	return undefined;
}

function deliveryFailed(eventType: string | undefined) {
	return (
		eventType === "email.bounced" ||
		eventType === "email.failed" ||
		eventType === "email.complained"
	);
}

function recipients(to: string | string[]) {
	return Array.isArray(to) ? to.join(", ") : to;
}

// A delivery failure for mail that belongs to no row in this deployment - which
// means a box owner notice (convex/notice/owner.ts), the one stream that keeps no
// record of its own.
//
// Reached by elimination, and that is safe only for as long as elimination is
// exhaustive. It very nearly was not: this used to say "since this deployment
// sends exactly two kinds", and a third kind would have inherited the sentence
// "a box owner was not told what happened to their box" for a bounced legal
// notice - a false statement about the wrong customer, arriving in place of a
// true one. Every stream added since keeps a row and is matched by lookup above,
// so the fallback narrows rather than widens.
//
// Owner notices carry no row of their own, on the argument that an individual
// bounce has no action behind it: the address came from Clerk, there is no
// second channel, and the box has already been deleted or suspended either way.
// A complaint is the exception, and it is the reason this exists. Owner mail and
// staff alerts deliberately share one sender domain and therefore one sending
// reputation, so an owner marking a notice as spam degrades the channel the
// alerts themselves ride on. Left unreported, that arrives later as staff alerts
// mysteriously failing to deliver - the symptom, without the cause, at the exact
// moment the alert channel is the thing that is broken.
//
// Everything needed is on the event: Resend echoes the recipient and the
// subject, and an owner notice's subject names its box.
function undeliveredNoticeAlert(
	id: string,
	event: EmailEvent
): AlertInput | undefined {
	if (!deliveryFailed(event.type)) return undefined;

	const complaint = event.type === "email.complained";
	return {
		// Per message rather than per time window. The volume is bounded by real
		// lifecycle events - a box is deleted or suspended once - so a burst of
		// these is not noise to be collapsed, it is the news.
		key: `owner-notice-undelivered:${id}`,
		severity: complaint ? "critical" : "warning",
		subject: complaint
			? "A box owner marked a Composery notice as spam"
			: "A box owner notice was not delivered",
		text: `"${event.data.subject}" was not delivered to ${recipients(event.data.to)}.\n\n${
			deliveryError(event) ?? event.type
		}\n\n${
			complaint
				? "A complaint is a sending-reputation problem, not one owner's problem. Owner notices and these alerts share a verified sender domain, so repeated complaints degrade staff alert delivery too. Review what was sent and whether the two streams still belong on one domain."
				: "The owner was not told what happened to their box. Notices are not retried - the box has since moved on - so reaching them, if it matters, is a manual step."
		}\n\n${staffConsoleUrl()}`
	};
}

// What became of a legal notice, recorded against the person it was owed to.
//
// This is the half of the evidence that Resend owns. Queueing proves we tried;
// only the delivery event distinguishes a customer who was informed from one who
// was not, and for a notice given under Article 19 of Directive (EU) 2019/770 or
// Article 34 GDPR that distinction is the whole record. So the event is written
// to the row whatever it says, and only a failure additionally alerts.
async function recordNoticeEvent(
	ctx: MutationCtx,
	recipient: Doc<"legal_notice_recipients">,
	event: EmailEvent
) {
	await ctx.db.patch(recipient._id, {
		last_email_event: event.type,
		delivery_error: deliveryError(event)
	});
	if (!deliveryFailed(event.type)) return;

	const complaint = event.type === "email.complained";
	await raiseAlert(ctx, {
		key: `legal-notice-undelivered:${recipient._id}`,
		severity: "critical",
		subject: complaint
			? "A customer marked a Composery legal notice as spam"
			: "A Composery legal notice was not delivered",
		text: `Notice ${recipient.notice_id} was not delivered to ${recipient.email}.\n\n${
			deliveryError(event) ?? event.type
		}\n\n${
			complaint
				? "The notice arrived and the customer rejected it, so the obligation is discharged but the channel is damaged: legal notices share a verified sender domain with box owner notices, and repeated complaints degrade both. Review what was sent."
				: "This customer has not been told, and a notice of this kind is owed to them individually rather than to the customer base in aggregate. Reaching them by another route is a manual step, and it is one somebody has to take."
		}\n\n${staffConsoleUrl()}`
	});
}

export const recordEmailEvent = internalMutation({
	args: vOnEmailEventArgs,
	handler: async (ctx, args) => {
		const alert = await ctx.db
			.query("staff_alerts")
			.withIndex("email_id", (query) => query.eq("email_id", args.id))
			.first();
		if (alert) {
			await ctx.db.patch(alert._id, {
				last_email_event: args.event.type,
				delivery_error: deliveryError(args.event),
				updated_at: Date.now()
			});
			return;
		}

		const recipient = await ctx.db
			.query("legal_notice_recipients")
			.withIndex("email_id", (query) => query.eq("email_id", args.id))
			.first();
		if (recipient) {
			await recordNoticeEvent(ctx, recipient, args.event);
			return;
		}

		const notice = undeliveredNoticeAlert(args.id, args.event);
		if (notice) await raiseAlert(ctx, notice);
	}
});

export const retryPending = internalMutation({
	args: {},
	handler: async (ctx) => {
		if (!alertsSender()) return 0;
		let retried = 0;
		for (const status of [
			"pending",
			"disabled",
			"no_recipients",
			"queue_failed"
		] as const) {
			const alerts = await ctx.db
				.query("staff_alerts")
				.withIndex("queue_status_created_at", (query) =>
					query.eq("queue_status", status)
				)
				.take(RETRY_BATCH - retried);
			for (const alert of alerts) {
				await enqueueAlert(ctx, alert);
				retried += 1;
			}
			if (retried >= RETRY_BATCH) break;
		}
		return retried;
	}
});

export const purgeExpired = internalMutation({
	args: {},
	handler: async (ctx) => {
		const alerts = await ctx.db
			.query("staff_alerts")
			.withIndex("purge_at", (query) =>
				query.gte("purge_at", 0).lte("purge_at", Date.now())
			)
			.take(PURGE_BATCH);
		for (const alert of alerts) await ctx.db.delete(alert._id);
		if (alerts.length === PURGE_BATCH) {
			await ctx.scheduler.runAfter(0, internal.staff.alerts.purgeExpired, {});
		}
		return alerts.length;
	}
});

// An alert that did not reach a person, or cannot be known to have reached one.
//
// The last clause is gated on delivery tracking because without the webhook
// there is no event to wait for: every alert would age past the window into a
// permanent "delivery issue" that no amount of healthy sending could clear, on
// a deployment whose only real problem - the missing webhook secret - the panel
// already reports on its own line.
function alertIssue(alert: Doc<"staff_alerts">, now: number, tracked: boolean) {
	if (alert.queue_status !== "queued") return true;
	if (deliveryFailed(alert.last_email_event)) return true;
	if (alert.last_email_event === "email.delivery_delayed") return true;
	return (
		tracked &&
		now - alert.created_at >= STALE_DELIVERY_MS &&
		(!alert.last_email_event || alert.last_email_event === "email.sent")
	);
}

export const health = query({
	args: {},
	handler: async (ctx) => {
		await requireCapability(ctx, "staff_console");
		const tracked = emailDeliveryTracked();
		const recent = await ctx.db
			.query("staff_alerts")
			.withIndex("created_at")
			.order("desc")
			.take(RECENT_ALERT_LIMIT);
		const now = Date.now();

		return {
			// Every sender, not just this module's own. Three separate variables
			// have no implication between them, so each has to be
			// reported on its own line or an unset one is invisible until the day it
			// was needed - see `emailSendersConfigured`.
			senders: emailSendersConfigured(),
			deliveryTrackingConfigured: tracked,
			recipientCount: (await alertRecipients(ctx)).length,
			recentIssues: recent
				.filter((alert) => alertIssue(alert, now, tracked))
				.slice(0, RECENT_ISSUE_LIMIT)
				.map((alert) => ({
					id: alert._id,
					subject: alert.subject,
					queueStatus: alert.queue_status,
					lastEmailEvent: alert.last_email_event ?? null,
					error: alert.delivery_error ?? null,
					createdAt: alert.created_at
				}))
		};
	}
});
