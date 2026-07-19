import { Resend } from "@convex-dev/resend";
import { components, internal } from "./_generated/api";
import { optionalEnv } from "./env";
import { HOUR_MS } from "./time";

// The deployment's one mail client, and the one answer to "can this deployment
// send that?".
//
// Three senders ride it, and every one needs the same two things to be true
// before anything can leave: a Resend key, and a verified from-address for that
// class of mail. Asking that question in one place is what stops a caller from
// checking half of it.
//
// Each is named for what its mail is about, because that is the only axis that
// stays stable - who receives it and why it was sent both follow from it:
//
//   - `alertsSender`   an incident on this deployment (convex/staff/alerts.ts)
//   - `noticesSender`  one customer's box             (convex/notice/owner.ts)
//   - `accountsSender` the account itself     (accountEmail.ts, legalNotice.ts)
//
// One word per sender - `alerts`, `notices`, `accounts` - names the variable,
// the address local part, the helper here and the key the console reports, so
// no layer needs a mapping to the next.
//
// The split is between addresses, and deliberately not between domains. An
// address costs nothing and is what a recipient reads and filters on; a verified
// domain costs a slot in the Resend account and, far more than that, a
// reputation that only volume can earn. Three addresses on one verified domain
// concentrate what little sending there is behind one reputation; three domains
// would be three that no receiver has heard of. So all three of these are
// addresses at the same domain until the volume makes the separation mean
// something, and `docs/developing/web/services/resend.md` is where the threshold
// for that and the shape it moves to are written down.

// Built per use rather than once at module load.
//
// The client captures `RESEND_API_KEY` when it is constructed, while every "is
// email configured" answer below reads the variable when it is asked. A client
// built at import time makes those two disagree for as long as a deployment's
// module cache outlives an environment change - the configured-looking half
// reporting healthy while the sending half throws "API key is not set". One of
// them had to move, and this one is free to move: a client is a component handle
// beside a plain config object, and the config it sends is assembled per call
// regardless.
export function resendClient(): Resend {
	return new Resend(components.resend, {
		onEmailEvent: internal.staff.alerts.recordEmailEvent,
		testMode: false
	});
}

// The from-address for a class of mail, or `undefined` where this deployment
// cannot send it. A missing key and a missing sender are the same answer,
// because either one alone sends nothing.
//
// One function per class rather than one taking the variable's name, because a
// name arriving as an argument is a name no reader of this file can see. The
// argument is readability, not enforcement: `optionalEnv` only accepts a member
// of `CONVEX_ENV_NAMES`, so an undeclared variable is a type error either way.
export function alertsSender() {
	return optionalEnv("RESEND_API_KEY")
		? optionalEnv("RESEND_ALERTS_FROM")
		: undefined;
}

export function noticesSender() {
	return optionalEnv("RESEND_API_KEY")
		? optionalEnv("RESEND_NOTICES_FROM")
		: undefined;
}

export function accountsSender() {
	return optionalEnv("RESEND_API_KEY")
		? optionalEnv("RESEND_ACCOUNTS_FROM")
		: undefined;
}

// Whether Resend can tell us what became of a message it accepted. Without the
// webhook secret the `/resend/events` route has nothing to verify against, so no
// delivery event ever arrives and every message stays at "handed over".
export function emailDeliveryTracked() {
	return Boolean(optionalEnv("RESEND_WEBHOOK_SECRET"));
}

// Which classes of mail this deployment can send, for the console's delivery
// panel to report one line each.
//
// It reports all three rather than the alert channel alone, because the three
// senders are three separate variables and nothing about one implies another -
// sharing a verified domain does not make them share a spelling mistake. While
// there was a single shared sender, an unmailable box owner was visible as an
// unhealthy alert channel and needed no signal of its own. That inference is
// exactly what splitting the senders
// destroyed, and an unset `RESEND_ACCOUNTS_FROM` is the worst thing it could have
// left behind: legal notices that silently go nowhere, on the one channel whose
// whole purpose is proving a customer was told.
export function emailSendersConfigured() {
	return {
		accounts: Boolean(accountsSender()),
		alerts: Boolean(alertsSender()),
		notices: Boolean(noticesSender())
	};
}

// One alert per window, however many customers could not be reached on it.
//
// A queue failure is a property of the deployment - key revoked, sender
// unverified, component down - never of one customer, so a key naming the
// customer would open the same incident once per person in the fleet. Both
// fire-and-forget streams (`ownerEmail.ts`, `accountEmail.ts`) key on this so
// the window cannot come to mean two different lengths of time.
const CUSTOMER_EMAIL_ALERT_WINDOW_MS = 6 * HOUR_MS;

export function customerEmailAlertKey(stream: "notices" | "accounts") {
	const window = Math.floor(Date.now() / CUSTOMER_EMAIL_ALERT_WINDOW_MS);
	return `${stream}-email-failed:${window}`;
}
