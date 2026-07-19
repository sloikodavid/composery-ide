import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { BOXES_PATH } from "../model/box/path";
import { SUPPORT_EMAIL } from "../model/links";
import { optionalWebsiteUrl } from "../env";
import { accountsSender, customerEmailAlertKey, resendClient } from "../email";
import { raiseAlert } from "../staff/alerts";

// What an account holder is told when their account changes under them.
//
// The sibling of `ownerEmail.ts`, one level up: that one mails about a box, this
// one about the account itself, and the sender each uses follows that split
// (`RESEND_NOTICES_FROM`, `RESEND_ACCOUNTS_FROM`). `legalNotice.ts` is the third thing
// on this sender and is not this - it mails every account holder about the
// agreement, keeps evidence, and exists because the law requires it.
//
// Two notices, and the same rule earns them their place as the box notices: each
// is a fact about the person's own account that they cannot learn any other way
// at the moment it becomes true. A suspension is the clearest case in the
// product. Everything they own stops answering at once, the website refuses
// every action with a card they only see if they go looking, and they were not
// looking - nobody opens a dashboard to check whether their account still works.
//
// It closes a gap rather than adding a channel. Suspending an account already
// suspended its boxes, and each of those mailed its owner, so the usual case was
// covered by accident: what was silent was an account with no running box -
// somebody between purchases, somebody whose boxes were stopped, somebody who
// had signed up and not bought yet. Those are exactly the people for whom the
// account is the only thing there is to suspend.

export type AccountNotice =
	{ type: "suspended"; reason: string | undefined } | { type: "unsuspended" };

function paragraphs(lines: (string | undefined)[]) {
	return lines.filter((line) => line !== undefined).join("\n\n");
}

// The whole message, as a pure function of the notice.
//
// Separated from sending for the same reason as the box notices: the wording is
// the part with the judgement in it, and it should be decided somewhere a test
// can read the answer rather than only inside a mutation whose one observable is
// that an email was handed to a queue.
export function accountNoticeEmail(notice: AccountNotice) {
	const link = optionalWebsiteUrl(BOXES_PATH);

	if (notice.type === "suspended") {
		return {
			subject: "Your Composery account has been suspended",
			text: paragraphs([
				"Your Composery account has been suspended.",
				"While it is suspended you cannot create, change or start boxes, and any box that was running has been suspended with the account.",
				// The same reason the account block shows this person on the website
				// and the same one their box notices carry, because a customer reading
				// two Composery explanations of one event must not find two answers.
				notice.reason,
				"Nothing has been deleted. Your files are exactly as you left them and come back with the account.",
				link ? `Your account: ${link}` : undefined,
				`Reply to this email to have the suspension reviewed - it reaches ${SUPPORT_EMAIL}.`
			])
		};
	}

	return {
		subject: "Your Composery account is active again",
		text: paragraphs([
			"The suspension on your Composery account has been lifted.",
			"You can use the account normally again, and any box that was suspended with it has been brought back.",
			link ? `Your account: ${link}` : undefined,
			`Reply to this email if you need a hand - it reaches ${SUPPORT_EMAIL}.`
		])
	};
}

// Email an account holder. Never throws.
//
// Same discipline, and the same reason, as `sendOwnerNotice`: the caller is a
// mutation whose real work - the account is suspended - has already happened in
// the same transaction. A notice that could not be sent must not undo it, so the
// whole body is caught, and so is the alert reporting the catch, because there
// is nothing behind that alert to rescue it.
export async function sendAccountNotice(
	ctx: MutationCtx,
	user: Doc<"users">,
	notice: AccountNotice
) {
	try {
		// Silent by configuration, and the console's delivery panel is where it says
		// so - one line per sender (`emailSendersConfigured`).
		const from = accountsSender();
		if (!from) return;

		// A finished account deletion holds a `@deleted.invalid` placeholder, and it
		// is also marked suspended by that same deletion. Mailing it would be a
		// guaranteed bounce telling someone who asked to be forgotten that the
		// account they closed has been suspended.
		if (user.deletion_finished_at) return;

		const { subject, text } = accountNoticeEmail(notice);
		await resendClient().sendEmail(ctx, {
			from,
			to: user.email,
			subject,
			text,
			replyTo: [SUPPORT_EMAIL]
		});
	} catch (error) {
		console.error("Failed to email an account holder", error);
		try {
			await raiseAlert(ctx, {
				key: customerEmailAlertKey("accounts"),
				severity: "warning",
				subject: "An account holder could not be emailed",
				text: `A ${notice.type} notice for ${user.email} (${user.clerk_user_id}) could not be queued.\n\n${
					error instanceof Error ? error.message : String(error)
				}\n\nThese are not retried: the account has moved on, and re-sending later would tell somebody about a state their account has since left. Check RESEND_API_KEY and the RESEND_ACCOUNTS_FROM sender against the delivery panel in the console. That this alert reached you narrows it sharply: the key works, and the senders share a verified domain, so the domain works too. What is left is the RESEND_ACCOUNTS_FROM value itself.`
			});
		} catch {
			// The alert is the fallback and has nothing behind it. It must not be the
			// thing that finally fails the mutation this function promised not to.
		}
	}
}
