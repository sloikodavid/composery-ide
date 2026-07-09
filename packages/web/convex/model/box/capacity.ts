// Why capacity admission is refusing a new box, as words.
//
// Here rather than in `boxes/capacity.ts` because `convex/schema.ts` builds the
// stored column from it and that module cannot import the capacity module - the
// capacity module reads settings, and settings is built from the schema, so the
// import would close a cycle. This is the same split every other vocabulary in
// `model/box/` uses, and it is what makes the stored union and the runtime type
// one list instead of two that can disagree.
//
// The distinction the two lists encode: a *limit* reason is a resource that ran
// out and will come back, so it is worth alerting on and worth clearing when it
// recovers. `manual_pause` and `limits_not_configured` are decisions somebody
// made, which need no alert because somebody already knows.

// Resources a deployment can exhaust. Each one is a fleet-wide allowance a new
// box commits some of.
export const CAPACITY_LIMIT_BLOCK_REASONS = [
	"server_limit",
	"snapshot_limit",
	// The apex's weekly Let's Encrypt allowance. See `model/box/certificate.ts`
	// for why this is admitted here while the per-box reissue cap is enforced
	// separately - they are two different Let's Encrypt limits, not two counters
	// of one.
	"certificate_limit"
] as const;

export type CapacityLimitBlockReason =
	(typeof CAPACITY_LIMIT_BLOCK_REASONS)[number];

// The decisions, which are not resources and never raise or clear an alert.
export const CAPACITY_DECISION_BLOCK_REASONS = [
	"manual_pause",
	"limits_not_configured"
] as const;

export type CapacityBlockReason =
	| CapacityLimitBlockReason
	| (typeof CAPACITY_DECISION_BLOCK_REASONS)[number]
	| null;
