import { describe, expect, test } from "vitest";

import { BOX_PLANS, BOX_PLAN_ORDER } from "@/convex/model/box/plan";
import {
	USAGE_FULL_STEP,
	USAGE_SIGNALS,
	USAGE_SIGNAL_NAMES,
	USAGE_STEPS,
	boxPlanTrafficLabel,
	formatBytes,
	planTrafficAllowanceBytes,
	usagePercent,
	usageStepReached,
	usageStepsPhrase
} from "@/convex/model/box/usage";

// The arithmetic behind every meter, notice and allowance sentence. It is all
// pure, and it is all load-bearing: the same two functions decide the colour of a
// bar, whether an email is sent, and what that email claims about somebody's
// disk.

describe("which step a level has reached", () => {
	test("is nothing below the first step", () => {
		expect(usageStepReached(0)).toBe(null);
		expect(usageStepReached(USAGE_STEPS[0] - 1)).toBe(null);
	});

	test("is the step itself at the boundary, not one below it", () => {
		for (const step of USAGE_STEPS) expect(usageStepReached(step)).toBe(step);
	});

	test("is the highest step reached, never the first one passed", () => {
		expect(usageStepReached(100)).toBe(USAGE_FULL_STEP);
	});

	// A reading that could not be taken is not a low one. Everything downstream
	// leans on this: a null that resolved to a step would email an owner about a
	// disk nobody measured, and a null that resolved to "fine" would draw a green
	// meter for the same disk.
	test("is nothing at all for a level that was never measured", () => {
		expect(usageStepReached(null)).toBe(null);
		expect(usageStepReached(Number.NaN)).toBe(null);
		expect(usageStepReached(Number.POSITIVE_INFINITY)).toBe(null);
	});
});

describe("a share of an allowance", () => {
	test("is a whole percentage", () => {
		expect(usagePercent(1, 3)).toBe(33);
		expect(usagePercent(2, 3)).toBe(67);
	});

	// Both allowances can be exceeded - the provider keeps carrying traffic past
	// the included amount - and a bar drawn past its own end says nothing the
	// figures beside it do not.
	test("stops at the end of the meter, however far past it the box went", () => {
		expect(usagePercent(40, 20)).toBe(100);
	});

	test("does not exist where there is nothing to measure against", () => {
		expect(usagePercent(1, 0)).toBe(null);
		expect(usagePercent(1, -1)).toBe(null);
		expect(usagePercent(-1, 10)).toBe(null);
		expect(usagePercent(Number.NaN, 10)).toBe(null);
	});

	// Zero is a measurement, and the one every box starts its billing month at.
	// Folding it in with the readings that do not exist would draw "Unknown" on the
	// traffic meter of every box that has not sent anything yet - the state with
	// least to worry about, reported as the state we could not read.
	test("is nothing used, not nothing known, at zero", () => {
		expect(usagePercent(0, 20)).toBe(0);
	});
});

describe("bytes as words", () => {
	// Decimal units, because that is what the provider bills in. The binary reading
	// of the same letters is about ten percent larger, so quoting it against a
	// 20 TB allowance would under-report an owner's own usage.
	test("scale in thousands, the way the allowance is sold", () => {
		expect(formatBytes(999)).toBe("999 B");
		expect(formatBytes(1_000)).toBe("1.0 kB");
		expect(formatBytes(40_000_000_000)).toBe("40.0 GB");
		expect(formatBytes(20_000_000_000_000)).toBe("20.0 TB");
	});

	test("say so rather than guessing at an unreadable figure", () => {
		expect(formatBytes(Number.NaN)).toBe("unknown");
		expect(formatBytes(-1)).toBe("unknown");
	});

	// Zero bytes is a figure, not a missing one - see `usagePercent` above for the
	// same distinction. "unknown of 20.0 TB" is what a fresh box would otherwise
	// read.
	test("count zero as none rather than as unreadable", () => {
		expect(formatBytes(0)).toBe("0 B");
	});

	// The unit walk stops at the last unit it has a name for. Past that it would
	// index off the end of the list and quote a figure in `undefined` - which no
	// box will reach, and which is exactly why nothing else would ever notice.
	test("stop at the largest unit they can name", () => {
		expect(formatBytes(10 ** 21)).toBe("1,000,000.0 PB");
	});
});

describe("what a plan allows", () => {
	test.each(BOX_PLAN_ORDER)("%s converts its terabytes once", (plan) => {
		expect(planTrafficAllowanceBytes(plan)).toBe(
			BOX_PLANS[plan].trafficTb * 1_000 ** 4
		);
	});

	// The pricing card prints this. A figure typed onto the card instead is the
	// copy that keeps advertising the old allowance after the plan changes.
	test.each(BOX_PLAN_ORDER)("%s states its own allowance", (plan) => {
		expect(boxPlanTrafficLabel(plan)).toBe(
			`${BOX_PLANS[plan].trafficTb} TB outbound traffic each month`
		);
	});
});

describe("the schedule reader-facing prose derives", () => {
	// The exact sentence, not merely the numbers in it. This lands mid-paragraph
	// in the Terms and in the pricing FAQ, so a separator that vanished would ship
	// "80%95%" into the agreement a customer is asked to accept.
	test("reads as a sentence, not as a run of figures", () => {
		expect(usageStepsPhrase()).toBe(
			USAGE_STEPS.map((step) => `${step}%`).join(" and again at ")
		);
		expect(usageStepsPhrase()).toContain(" and again at ");
	});

	test("names every step, in order", () => {
		const phrase = usageStepsPhrase();
		for (const step of USAGE_STEPS) expect(phrase).toContain(`${step}%`);
		expect(phrase.indexOf(`${USAGE_STEPS[0]}%`)).toBeLessThan(
			phrase.indexOf(`${USAGE_FULL_STEP}%`)
		);
	});
});

describe("the signal vocabulary", () => {
	test("names every signal exactly once", () => {
		expect(USAGE_SIGNAL_NAMES).toEqual(Object.keys(USAGE_SIGNALS));
		expect(USAGE_SIGNAL_NAMES).toEqual([...new Set(USAGE_SIGNAL_NAMES)]);
	});

	// A signal with no consequence or no remedy would send an owner an email that
	// states a percentage and stops - which is the notice this whole feature
	// exists to be better than.
	test.each(USAGE_SIGNAL_NAMES)(
		"%s says what it costs and what to do",
		(name) => {
			const signal = USAGE_SIGNALS[name];
			expect(signal.label.trim()).not.toBe("");
			expect(signal.consequence.trim()).not.toBe("");
			expect(signal.remedy.trim()).not.toBe("");
		}
	);

	// Steps are ascending, which `usageStepReached` and the "announce only when it
	// goes up" rule both assume rather than sort for.
	test("orders its steps from first warning to last", () => {
		expect([...USAGE_STEPS]).toEqual([...USAGE_STEPS].sort((a, b) => a - b));
		expect(USAGE_STEPS.length).toBeGreaterThan(0);
		expect(USAGE_FULL_STEP).toBe(USAGE_STEPS[USAGE_STEPS.length - 1]);
	});
});
