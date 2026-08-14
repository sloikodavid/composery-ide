import { describe, expect, test } from "vitest";

import { billingLabel } from "@/lib/box/billing";
import { formatDate } from "@/lib/datetime";

const PERIOD_END = "2026-03-03T00:00:00.000Z";
const paid = { comp: false, plan: "pro" } as const;

describe("billingLabel", () => {
	test("names the plan and the next thing the subscription does", () => {
		expect(
			billingLabel(paid, {
				cancelAtPeriodEnd: false,
				currentPeriodEnd: PERIOD_END
			})
		).toBe(`Box Pro - Renews ${formatDate(PERIOD_END)}`);

		expect(
			billingLabel(paid, {
				cancelAtPeriodEnd: true,
				currentPeriodEnd: PERIOD_END
			})
		).toBe(`Box Pro - Cancels ${formatDate(PERIOD_END)}`);
	});

	// A date we do not have is never invented, and the two ways of not having one
	// say different things: a subscription ending on an unknown day is still
	// ending.
	test("says what it knows when there is no date to name", () => {
		expect(billingLabel(paid, { cancelAtPeriodEnd: true })).toBe(
			"Box Pro - Cancellation scheduled"
		);
		expect(billingLabel(paid, null)).toBe("Box Pro - Billing date unavailable");
		expect(billingLabel(paid, undefined)).toBe(
			"Box Pro - Billing date unavailable"
		);
	});

	// A comped box has no subscription at all, so every sentence about renewal or
	// cancellation would be a report about something that does not exist.
	test("names the plan alone for a comped box", () => {
		expect(
			billingLabel(
				{ comp: true, plan: "air" },
				{ cancelAtPeriodEnd: true, currentPeriodEnd: PERIOD_END }
			)
		).toBe("Comped - Box Air");
	});
});
