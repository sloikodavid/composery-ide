// The fleet's Let's Encrypt budget, as words.
//
// Every box is `<slug>.CLOUD_DOMAIN` with its own Caddy and its own certificate,
// so every box in the deployment draws on one apex's allowance. Two different
// Let's Encrypt limits bind here and this repository enforces both, in two
// places, deliberately:
//
//   1. **Certificates per registered domain** - roughly 50 a week for the whole
//      apex. That is a *fleet* fact, so it is enforced by capacity admission
//      (`boxes/capacity.ts`) beside the provider allocation, which is the other
//      fleet-wide resource a new box commits.
//   2. **Duplicate certificates** - roughly 5 a week for one identical name set.
//      That is a *per box* fact, so it is enforced per box, at the operations
//      that reissue one (`owner/boxes.ts`).
//
// These are not two counters of one thing and must not be merged. A box that has
// reset five times this week has exhausted (2) while the apex may be almost
// untouched; an apex that has issued fifty has exhausted (1) while every
// individual box is well inside its own allowance. Merging them would enforce
// the smaller number everywhere and silently stop enforcing the other.
//
// Nothing here observes an actual issuance - Caddy on each box asks Let's
// Encrypt, and no signal comes back to the control plane. So both counters count
// the operations this deployment performs that *cause* one. That is a proxy, and
// it is deliberately the pessimistic direction: an operation that ends up
// reusing a cached certificate still spends budget here, because the alternative
// is discovering the real ceiling by hitting it, at which point new boxes,
// resets and slug changes all fail fleet-wide until the week rolls.

import type { BoxOperationType } from "./operation";

export const CERTIFICATE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Every operation that makes a box ask for a certificate, and the one place that
// set is stated.
//
// `create` covers Duplicate: a duplicate is provisioned by the ordinary create
// operation on the new box, under a new slug, so it asks for a certificate by
// exactly the same route as any other new box and needs no entry of its own.
// Repair is absent because it rebuilds the host from the box's existing files
// and Caddy's storage volume survives it, so the certificate on disk is reused.
export const CERTIFICATE_ISSUING_OPERATIONS = [
	"create",
	"reset",
	"change_slug",
	"restore"
] as const satisfies readonly BoxOperationType[];

export type CertificateIssuingOperation =
	(typeof CERTIFICATE_ISSUING_OPERATIONS)[number];

// Of those, the ones that add a box to the fleet rather than recover one that
// already exists. Only this set is held back by the reserve below.
export const CERTIFICATE_CREATING_OPERATIONS = [
	"create"
] as const satisfies readonly CertificateIssuingOperation[];

// Certificates held below the ceiling that only a recovery may spend.
//
// Duplicate is what makes this necessary. Bulk creation used to be impossible -
// each new box was a separate purchase - so the apex ceiling was never reachable
// in a week and nothing had to ration it. One click that creates twenty boxes
// can now exhaust it, and the cost of exhausting it falls on *everybody*: for the
// rest of that week no box in the deployment can be reset, renamed or restored,
// because those need a certificate too.
//
// So the two are not given equal claim on the last slots. A reset or a slug
// change is an owner recovering a box they have already bought; a duplicate is
// discretionary. One agency's twenty copies must not lock every other owner out
// of a repair for six days.
//
// Reserved rather than taken out of the ceiling, and named rather than written
// as a bare number, for the same reason as `RESERVED_SNAPSHOT_SLOTS`: the
// arithmetic is meant to be read together with the reason it exists.
//
// **What 10 buys, so the next person can retune it against reality rather than
// guess what it meant.** At Let's Encrypt's ordinary ~50 per registered domain
// per week, this holds back a fifth of the allowance, so that even in a week
// where creation has taken everything else, the fleet can still perform ten
// recovery-shaped operations - ten resets, renames or restores, across all
// boxes, not per box. That is sized against how often owners actually recover a
// box, which is rare and bursty: a handful in a normal week, concentrated when
// something has gone wrong. Ten is meant to cover a bad week, not a busy one.
//
// Retune it against two real numbers once they exist: how many issuing
// operations a week this deployment performs, and what its apex allowance
// actually is after any rate limit adjustment. If recovery ever exhausts this
// reserve, the reserve is too small; if creation is routinely blocked while the
// reserve sits untouched, it is too large or the allowance is.
export const CERTIFICATE_RECOVERY_RESERVE = 10;

export function isCertificateCreatingOperation(
	type: CertificateIssuingOperation
): boolean {
	return (
		CERTIFICATE_CREATING_OPERATIONS as readonly CertificateIssuingOperation[]
	).includes(type);
}

export type CertificateHeadroom = {
	// What a new box may still take. Never negative, and always the smaller of
	// the two.
	forCreation: number;
	// What a reset, rename or restore may still take.
	forRecovery: number;
};

// How much of the week's allowance is left, split by what may spend it.
//
// A null limit means the operator has not told us the apex allowance. It reads
// as no headroom at all rather than unlimited: this is the number that decides
// whether the fleet can still recover itself, and guessing high on it is how a
// deployment discovers the real ceiling by breaking every box's reset at once.
// Capacity admission already fails closed on an unconfigured provider
// allocation for the same reason.
export function certificateHeadroom({
	issuedThisWeek,
	limit,
	reserve = CERTIFICATE_RECOVERY_RESERVE
}: {
	issuedThisWeek: number;
	limit: number | null;
	reserve?: number;
}): CertificateHeadroom {
	if (limit === null) return { forCreation: 0, forRecovery: 0 };

	const remaining = Math.max(0, limit - issuedThisWeek);
	return {
		forRecovery: remaining,
		// The reserve is subtracted from what is left, not from the ceiling, so a
		// week that has already eaten into it leaves creation at zero rather than
		// at a negative number that would read as headroom after a Math.max.
		forCreation: Math.max(0, remaining - reserve)
	};
}
