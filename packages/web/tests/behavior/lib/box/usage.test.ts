import { describe, expect, test } from "vitest";

import { USAGE_FULL_STEP, USAGE_STEPS } from "@/convex/model/box/usage";
import { usageMeter, usageTone, type UsageReading } from "@/lib/box/usage";

// How a level is drawn. The model decides which step a percentage has reached -
// that is the rule the emails are sent on - and this decides what it looks like,
// so the colour an owner sees and the level they were emailed about can never be
// two different answers.

const SAMPLED = Date.UTC(2026, 7, 2, 8, 0, 0);

function reading(overrides: Partial<UsageReading> = {}): UsageReading {
	return {
		signal: "disk",
		usedBytes: 4_000_000_000,
		allowanceBytes: 40_000_000_000,
		percent: 10,
		sampledAt: SAMPLED,
		counterResetAt: null,
		...overrides
	};
}

describe("the tone of a level", () => {
	test("is fine below the first step and warns from it", () => {
		expect(usageTone(USAGE_STEPS[0] - 1)).toBe("ok");
		expect(usageTone(USAGE_STEPS[0])).toBe("warn");
	});

	test("turns bad only once the allowance is effectively gone", () => {
		expect(usageTone(USAGE_FULL_STEP - 1)).toBe("warn");
		expect(usageTone(USAGE_FULL_STEP)).toBe("bad");
		expect(usageTone(100)).toBe("bad");
	});

	// `muted` means "we could not read this" everywhere in `lib/box/`, and this is
	// the reading that has to keep it that way: an unmeasured disk drawn as `ok`
	// is a green meter for a box nobody has looked at.
	test("is muted, never fine, for a level nobody measured", () => {
		expect(usageTone(null)).toBe("muted");
	});
});

describe("what a meter says", () => {
	test("gives both figures, because a percentage alone sizes nothing", () => {
		expect(usageMeter(reading())).toMatchObject({
			label: "Disk",
			detail: "4.0 GB of 40.0 GB",
			percent: 10,
			tone: "ok"
		});
	});

	// An interface that explains the cost of a full disk under a meter at 10% is
	// warning about nothing, and warnings about nothing are what stop the real one
	// being read.
	test("offers advice only once there is something to act on", () => {
		expect(usageMeter(reading()).advice).toBe(null);
		expect(usageMeter(reading({ percent: USAGE_STEPS[0] })).advice).toContain(
			"prune Docker"
		);
		expect(usageMeter(reading({ percent: 100 })).advice).toContain(
			"stops the box writing"
		);
	});

	test("names the signal it is about", () => {
		expect(
			usageMeter(reading({ signal: "traffic", percent: 90 }))
		).toMatchObject({ label: "Outbound traffic", tone: "warn" });
	});

	test("passes an unmeasured level through as unmeasured", () => {
		expect(usageMeter(reading({ percent: null }))).toMatchObject({
			percent: null,
			tone: "muted",
			advice: null
		});
	});
});
