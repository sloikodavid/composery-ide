// What a box has spent of what its plan includes, and the words for it.
//
// Vocabulary and arithmetic only - no query, no validator, no chart. It is the
// third thing a box's telemetry can be, and the two that already existed had no
// room for it: `metric.ts` names *rates* (bytes per second, packets per second),
// and the flag thresholds built on them catch a box behaving badly right
// now. Neither can answer "how full is the disk" or "how much of this month's
// traffic is left", because those are levels measured against a limit rather
// than rates measured against each other.
//
// The distinction decides everything downstream. A rate is sampled, drawn and
// forgotten; a level is compared to an allowance, told to its owner once when it
// crosses, and never told again until it crosses again.

import { BOX_PLANS, BOX_PLAN_ORDER, type BoxPlan } from "./plan";

// The two things a box can run out of. Declaration order is the order the box
// page lays the meters out in.
export const USAGE_SIGNALS = {
	disk: {
		label: "Disk",
		// Whether this counter starts again on a period boundary. It decides two
		// things at once, which is why it is a property of the signal rather than
		// something inferred from the numbers: a signal that resets has its notice
		// re-armed when its counter drops, and it is the only kind the box page may
		// date ("counts from the 4th").
		//
		// Inferring it was the first design and it was wrong in both directions. A
		// disk emptied by a `docker prune` looks exactly like a counter rolling over,
		// so it was recorded as one - and the box page, which has only one such date
		// to show, would then print a disk cleanup as the day the billing month began.
		resets: false,
		// The sentence the notice and the meter's caption are built from. It says
		// what filling it costs the owner, because "80% used" on its own is a number
		// nobody acts on.
		consequence:
			"A full disk stops the box writing anything - files, snapshots and the editor's own state.",
		// What an owner does about it. Never "contact support" where they have a
		// lever of their own.
		remedy:
			"Delete what you do not need, and prune Docker images and build cache from a terminal in the box."
	},
	traffic: {
		label: "Outbound traffic",
		// The provider starts this again at the top of each billing month. Nothing
		// here knows that calendar, so the counter going down is the signal - but
		// only for a signal that has one.
		resets: true,
		// Worded against the Terms, not merely near them. A notice that threatens
		// more than the agreement allows is the one kind of wrong a warning email
		// cannot be: "Disk and traffic allowances" promises Composery gets in touch
		// and agrees a larger allowance, a charge, or a cut in use before any other
		// step, so this says exactly that and no more.
		consequence:
			"Going over does not switch the box off. Composery gets in touch before anything else happens.",
		remedy:
			"Check what is serving or sending from the box, and get in touch if you need a larger allowance."
	}
} as const;

export type UsageSignal = keyof typeof USAGE_SIGNALS;

export const USAGE_SIGNAL_NAMES = Object.keys(USAGE_SIGNALS) as UsageSignal[];

// The percentages at which an owner is told, highest last.
//
// Two, not a slider: the first is early enough to act on and the second is the
// one that says the allowance is effectively gone. A third step would train an
// owner to ignore all of them, which is the same argument `notice/owner.ts`
// makes for keeping its own list short.
export const USAGE_STEPS = [80, 95] as const;

export type UsageStep = (typeof USAGE_STEPS)[number];

// The highest step this percentage has reached, or null below the first.
//
// One rule, read by the sweep that decides whether to send a notice, by the
// card that colours a meter, and by the tests. It used to be two: the Repair
// dialog carried its own 75/90 disk bands, which meant the colour an owner saw
// and the level they were emailed about were different questions with different
// answers.
export function usageStepReached(percent: number | null): UsageStep | null {
	// Two tests where one would do at runtime - `Number.isFinite(null)` is already
	// false - because `Number.isFinite` is not a type guard, so dropping the null
	// check leaves `percent` as `number | null` for the comparison below. The
	// redundancy is the type checker's, and it is the reason the mutant that
	// removes it cannot be killed: both branches return null for the same input.
	// Stryker disable next-line ConditionalExpression: null already fails Number.isFinite, so the branch this removes is unreachable by a second route.
	if (percent === null || !Number.isFinite(percent)) return null;
	let reached: UsageStep | null = null;
	for (const step of USAGE_STEPS) {
		if (percent >= step) reached = step;
	}
	return reached;
}

// "80% and again at 95%" - the steps as a fragment of a sentence.
//
// Every reader-facing surface that promises a warning schedule builds its
// sentence from this, and there is deliberately no surface that does not: the
// pricing FAQ and the Terms are prose about a rule that lives in code, and a
// percentage typed into either is a promise nothing keeps.
//
// That is also the argument against documenting the schedule anywhere markdown
// can reach. A `docs/` page stating it needed a test to pin the copy, and the
// copy was most of what the page was - so the page went instead. These two
// callers are the whole set, and both derive.
export function usageStepsPhrase() {
	return USAGE_STEPS.map((step) => `${step}%`).join(" and again at ");
}

// The last step, and so the one that means the allowance is effectively gone.
// Read off the list rather than written as 95, so adding a step cannot leave a
// reader pointing at the middle of it.
export const USAGE_FULL_STEP = USAGE_STEPS[USAGE_STEPS.length - 1];

// A share of an allowance as a whole percentage, clamped at the top.
//
// Clamped because both allowances can be exceeded - Hetzner keeps carrying
// traffic past the included amount, and a disk can report 100% while the box
// keeps trying to write - and a meter that draws past its own end says nothing
// the number beside it does not already say. An allowance of zero has no
// percentage rather than an infinite one.
export function usagePercent(used: number, allowance: number): number | null {
	if (!Number.isFinite(used) || !Number.isFinite(allowance)) return null;
	if (allowance <= 0 || used < 0) return null;
	return Math.min(100, Math.round((used / allowance) * 100));
}

const TERABYTE = 1_000 ** 4;
const BYTE_UNITS = ["B", "kB", "MB", "GB", "TB", "PB"] as const;

// Bytes as words, in the decimal units every provider bills in - Hetzner quotes
// a 20 TB allowance meaning 20 x 1000^4, not 20 x 1024^4, and quoting the other
// one would under-report an owner's own usage against their own allowance.
//
// The locale is pinned for the reason `formatFlagValue` pins its own: this
// string reaches an email and a stored notice, so CI and a developer machine
// have to produce the same one.
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
	let value = bytes;
	let unit = 0;
	while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
		value /= 1000;
		unit += 1;
	}
	// Whole bytes have no fraction to show; everything else keeps one decimal, so
	// "1.4 TB" and "980.2 GB" read at the same precision.
	const decimals = unit === 0 ? 0 : 1;
	return `${value.toLocaleString("en-US", {
		maximumFractionDigits: decimals,
		minimumFractionDigits: decimals
	})} ${BYTE_UNITS[unit]}`;
}

// What one plan includes, in bytes, from the plan table's own figure. Nothing
// else converts a plan's terabytes: a second `* 1000 ** 4` somewhere is how the
// allowance an owner is measured against stops being the one they were sold.
export function planTrafficAllowanceBytes(plan: BoxPlan): number {
	return BOX_PLANS[plan].trafficTb * TERABYTE;
}

// There is deliberately no `planDiskBytes` beside it. A disk is measured against
// the box's own filesystem, which is smaller than the plan's advertised figure by
// the image and by what the filesystem keeps for itself - so a meter drawn
// against the plan would sit short of full while the box had already stopped
// being able to write.

// "20 TB outbound traffic each month" - the pricing card's line, so a plan whose
// allowance changes cannot keep advertising the old one.
export function boxPlanTrafficLabel(plan: BoxPlan): string {
	return `${BOX_PLANS[plan].trafficTb} TB outbound traffic each month`;
}

// Whether a machine includes less traffic than the plan it carries sells.
//
// This is the one fault in the whole feature that no box's own behaviour reveals:
// every box stays inside its published allowance, every meter reads green, and
// the deployment is billed for excess anyway - because what Composery promises
// and what the provider includes are two numbers that were only ever equal by
// somebody having typed them that way.
//
// It answers per server type rather than per box because that is what the
// provider's figure is a property of, and it takes a plain string because the
// provider is who names it: a type nothing sells is not a fault, it is a machine
// this deployment does not put boxes on, and it must not be an error either.
export function trafficAllowanceGap(
	serverType: string,
	includedBytes: number
): { plan: BoxPlan; allowanceBytes: number; includedBytes: number } | null {
	const plan = BOX_PLAN_ORDER.find(
		(candidate) => BOX_PLANS[candidate].serverType === serverType
	);
	if (!plan) return null;

	const allowanceBytes = planTrafficAllowanceBytes(plan);
	// Equal is fine, and so is a machine that includes more than we sell. Only
	// selling more than we buy is the fault.
	if (includedBytes >= allowanceBytes) return null;
	return { plan, allowanceBytes, includedBytes };
}
