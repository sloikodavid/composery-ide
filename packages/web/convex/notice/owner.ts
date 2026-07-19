import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { boxPath } from "../model/box/path";
import { SUPPORT_EMAIL } from "../model/links";
import { optionalWebsiteUrl } from "../env";
import { appendBoxEvent } from "../boxes/operation/event";
import { noticesSender, customerEmailAlertKey, resendClient } from "../email";
import { raiseAlert } from "../staff/alerts";
import { findUserByClerkId } from "../users";
import type { OperationTrigger } from "../schema";
import {
	USAGE_SIGNALS,
	formatBytes,
	type UsageSignal,
	type UsageStep
} from "../model/box/usage";

// What a box owner is told by email, and when.
//
// Five notices, not a feed. Each one is a fact about the owner's own box that
// they cannot learn any other way at the moment it becomes true: nobody opens
// the website to check whether the box they were not using is still there. Every
// other thing a box does - started, stopped, snapshotted, an update waiting - is
// already on its page for whoever goes looking, and mailing those would train an
// owner to ignore the five that matter.
//
// The boundary with the other two senders is absolute, because two systems
// mailing about the same event is how a customer ends up believing the wrong
// one: Polar owns every billing email (receipt, renewal, failed charge, dunning,
// cancellation) and Clerk owns every identity email. Nothing here restates
// either. `docs/developing/web/services/resend.md` is the canonical statement of
// that split.

// A suspension notice carries its reason, whoever suspended the box.
//
// It used to forward an automatic reason and withhold a staff one, on the
// argument that a staff note is written for other staff and forwarding it would
// publish an internal note to its subject. That argument described a service
// this is not. The console's suspend dialog offers customer-worded presets
// ("Suspended for violating Composery's Terms of Service.") under a field that
// tells staff, in as many words, that the reason is shown to the account owner -
// and it already is, twice: `boxes/queries.ts` serves it to the owner's own box
// page for every suspension regardless of trigger, and `users.ts` puts an
// account's reason in the block card. So withholding it here protected nothing.
// It only meant the email said less than the page it linked to, which is the one
// thing a notice must never do.
//
// Because the trigger no longer decides anything, a suspension notice does not
// carry one.
// A box near a limit is the fifth, and it earns its place on the same test the
// other four pass. An allowance is spent inside the box, by whatever the owner
// left running, and the moment it matters is before it runs out - which is
// exactly when nobody is looking at the meter. It is also the one notice with
// something the owner can do about it while there is still time, so the message
// carries the remedy rather than only the number.
//
// It is sent once per step per period, never per sample: `boxes/usage.ts` holds
// the step it last announced, and a level that stays high stays quiet. A meter
// that mailed every ten minutes is how an owner learns that mail from Composery
// is noise.
export type OwnerNotice =
	| { type: "deleted"; trigger: OperationTrigger | undefined }
	| { type: "suspended"; reason: string | undefined }
	| { type: "unsuspended" }
	| { type: "create_failed" }
	| {
			type: "usage";
			signal: UsageSignal;
			step: UsageStep;
			usedBytes: number;
			allowanceBytes: number;
	  };

// Why a box was deleted, in the owner's terms.
//
// Read off the operation's trigger because that is the only record of who
// ordered the teardown that survives into the mutation that finishes it. A
// trigger with no sentence here contributes none: `system:delete_retry` finishes
// a deletion some earlier operation ordered, so its own row genuinely does not
// know the reason, and inventing a plausible one would be worse than the
// deletion notice standing on its own.
function deletionReason(trigger: OperationTrigger | undefined) {
	if (trigger === "system:subscription_revoked") {
		return "Its subscription ended. A box exists only while its subscription is active.";
	}
	if (trigger === "system:account_deletion") {
		return "You asked us to delete your Composery account, and every box on the account goes with it.";
	}
	if (trigger === "staff") return "Composery staff deleted it.";
	return undefined;
}

function paragraphs(lines: (string | undefined)[]) {
	return lines.filter((line) => line !== undefined).join("\n\n");
}

// The whole message, as a pure function of the notice and the box.
//
// Separated from sending so the wording - which is the part with the judgement
// in it - is decided somewhere a test can read the answer, rather than only
// inside a mutation whose sole observable is that an email was handed to a queue.
export function ownerNoticeEmail(
	notice: OwnerNotice,
	box: { slug: string; url: string | undefined }
) {
	const link = box.url;
	const reply = `Reply to this email if you need a hand - it reaches ${SUPPORT_EMAIL}.`;

	if (notice.type === "deleted") {
		return {
			subject: `Your Composery box ${box.slug} has been deleted`,
			text: paragraphs([
				`Your box ${box.slug} has been deleted.`,
				deletionReason(notice.trigger),
				"Its files, snapshots and backups went with it. Composery keeps no copy of a deleted box, so this cannot be undone.",
				link ? `Your remaining boxes: ${link}` : undefined,
				reply
			])
		};
	}

	if (notice.type === "suspended") {
		return {
			subject: `Your Composery box ${box.slug} has been suspended`,
			text: paragraphs([
				`Your box ${box.slug} has been suspended and its server powered off.`,
				"Nothing has been deleted. Your files are exactly as you left them and come back with the box.",
				notice.reason,
				link ? `The box: ${link}` : undefined,
				`Reply to this email to have the suspension reviewed - it reaches ${SUPPORT_EMAIL}.`
			])
		};
	}

	if (notice.type === "unsuspended") {
		return {
			subject: `Your Composery box ${box.slug} is running again`,
			text: paragraphs([
				`The suspension on your box ${box.slug} has been lifted and its server is back on.`,
				link ? `The box: ${link}` : undefined,
				reply
			])
		};
	}

	if (notice.type === "usage") {
		const { label, consequence, remedy } = USAGE_SIGNALS[notice.signal];
		return {
			// The signal in lower case inside the sentence, the same rule
			// `flagSignalLabel` follows: a leading capital mid-subject reads as a
			// proper noun.
			subject: `Your Composery box ${box.slug} has used ${notice.step}% of its ${label.toLowerCase()}`,
			text: paragraphs([
				`Your box ${box.slug} has used ${formatBytes(
					notice.usedBytes
				)} of the ${formatBytes(notice.allowanceBytes)} it includes.`,
				consequence,
				remedy,
				link ? `The box: ${link}` : undefined,
				reply
			])
		};
	}

	return {
		subject: `Your Composery box ${box.slug} could not be created`,
		text: paragraphs([
			`We could not finish creating your box ${box.slug}, so there is nothing running yet.`,
			"Composery staff were alerted automatically and are looking at it. You do not need to report it.",
			link ? `The box: ${link}` : undefined,
			reply
		])
	};
}

// Email a box's owner. Never throws.
//
// Every caller is a lifecycle mutation whose real work - the box is deleted, the
// box is suspended - has already happened in the same transaction by the time
// this runs. A notice that failed to send must not turn one of those into a
// failed operation, because a failed operation is what puts a box into a failure
// status and holds its lock. So the whole body is caught, and so is the alert
// that reports the catch: there is nothing behind that alert to rescue it.
export async function sendOwnerNotice(
	ctx: MutationCtx,
	box: Doc<"boxes">,
	notice: OwnerNotice
) {
	try {
		// Silent by configuration, and it says so where someone looks: the console's
		// delivery panel reports every sender this deployment has, one line each
		// (`emailSendersConfigured`). It has to, now that each class of mail has its
		// own variable: an unset `RESEND_NOTICES_FROM` is no longer something a broken
		// alert channel would reveal, and a shared verified domain does not make one
		// variable imply another.
		const from = noticesSender();
		if (!from) return;

		const owner = await findUserByClerkId(ctx, box.user_id);
		// A finished account deletion replaces the address with a `@deleted.invalid`
		// placeholder, and the last box teardown of that same deletion can land
		// after it. Mailing the placeholder would be a guaranteed bounce, and the
		// person it was for asked us to forget them.
		if (!owner || owner.deletion_finished_at) return;

		const { subject, text } = ownerNoticeEmail(notice, {
			slug: box.slug,
			url: optionalWebsiteUrl(boxPath(box._id))
		});

		const emailId = await resendClient().sendEmail(ctx, {
			from,
			to: owner.email,
			subject,
			text,
			// Support is a person reading a mailbox, not a portal, so the reply an
			// owner will send anyway is addressed rather than bounced.
			replyTo: [SUPPORT_EMAIL]
		});

		// Support's answer to "did you tell me?". It is the box's own log rather
		// than a table of its own because that log is already owner-scoped, already
		// shown in the console beside the event being reported, and already carries
		// the retention and purge rules a customer's record needs.
		// The signal is recorded beside the notice type rather than folded into it,
		// because support's question is "which limit did we warn them about" and a
		// row saying only `usage` cannot answer it. Everything else has one subject
		// and carries no signal at all.
		await appendBoxEvent(ctx, box, "box.owner_emailed", {
			metadata: {
				notice: notice.type,
				emailId,
				...(notice.type === "usage" ? { signal: notice.signal } : {})
			}
		});
		// Reached only when the mail component itself throws - a rejected key, a
		// network failure. No test reaches it: the component in the harness
		// accepts every address, so there is nothing here that can be made to
		// fail. What is tested is the property this exists to protect - a notice
		// never becomes the reason a delete fails - via the paths that return
		// before sending (no sender configured, a scrubbed account, no owner row).
	} catch (error) {
		console.error("Failed to email a box owner", error);
		try {
			await raiseAlert(ctx, {
				key: customerEmailAlertKey("notices"),
				severity: "warning",
				subject: "A box owner could not be emailed",
				text: `A ${notice.type} notice for box ${box.slug} (${box._id}) could not be queued.\n\n${
					error instanceof Error ? error.message : String(error)
				}\n\nOwner notices are not retried: the box lifecycle moved on without one, and re-sending later would tell an owner about a state their box has since left. Check RESEND_API_KEY and the RESEND_NOTICES_FROM sender against the delivery panel in the console. That this alert reached you narrows it sharply: the key works, and the senders share a verified domain, so the domain works too. What is left is the RESEND_NOTICES_FROM value itself.`
			});
		} catch {
			// The alert is the fallback and has nothing behind it. It must not be the
			// thing that finally fails the mutation this function promised not to.
		}
	}
}
