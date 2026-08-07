import {
	USAGE_FULL_STEP,
	USAGE_SIGNALS,
	formatBytes,
	usageStepReached,
	type UsageSignal
} from "@/convex/model/box/usage";
import type { Tone } from "@/lib/box/repair";

// How a usage level looks. The model decides which step a percentage has
// reached - that is the rule the notices are sent on - and this decides what
// colour that step is drawn in, which is a rendering choice and belongs on the
// side that renders. Both surfaces read the same step, so the colour an owner
// sees and the level they were emailed about can never be different answers.
//
// `muted` keeps the meaning it has everywhere else in `lib/box/`: "we could not
// read this", never "this is fine". A box whose disk has never been sampled says
// so rather than drawing an empty meter.
export function usageTone(percent: number | null): Tone {
	if (percent === null) return "muted";
	const step = usageStepReached(percent);
	if (step === null) return "ok";
	return step === USAGE_FULL_STEP ? "bad" : "warn";
}

export type UsageReading = {
	signal: UsageSignal;
	usedBytes: number;
	allowanceBytes: number;
	percent: number | null;
	sampledAt: number;
	counterResetAt: number | null;
};

export type UsageMeter = {
	label: string;
	// "38.2 GB of 40 GB" - both figures, because a percentage alone cannot tell an
	// owner whether the remaining fifth is 8 GB or 4 TB, and those call for
	// different actions.
	detail: string;
	percent: number | null;
	// Shown only once there is something to act on. A meter at 12% with a
	// paragraph under it about what a full disk costs is a warning about nothing,
	// and an interface that warns about nothing is one nobody reads.
	advice: string | null;
	tone: Tone;
};

export function usageMeter(reading: UsageReading): UsageMeter {
	const { label, consequence, remedy } = USAGE_SIGNALS[reading.signal];
	const tone = usageTone(reading.percent);
	return {
		label,
		detail: `${formatBytes(reading.usedBytes)} of ${formatBytes(
			reading.allowanceBytes
		)}`,
		percent: reading.percent,
		advice:
			tone === "warn" || tone === "bad" ? `${consequence} ${remedy}` : null,
		tone
	};
}
