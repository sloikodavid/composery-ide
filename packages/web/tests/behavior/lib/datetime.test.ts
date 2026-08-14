import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ageInWords, formatDate, formatDateTime } from "@/lib/datetime";

// "The current year" is the thing these formatters branch on, so reading it from
// the wall clock made the suite's answer depend on the day it ran - and the one
// day it would have differed is the one nobody runs it on. The clock is pinned
// instead, mid-year so neither boundary is adjacent.
const NOW = new Date("2026-06-04T09:30:00.000Z");

describe("formatDate / formatDateTime", () => {
	beforeAll(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});
	afterAll(() => {
		vi.useRealTimers();
	});

	test("returns an empty string for missing or zero values", () => {
		expect(formatDate(null)).toBe("");
		expect(formatDate(undefined)).toBe("");
		expect(formatDate(0)).toBe("");
		expect(formatDateTime(null)).toBe("");
		expect(formatDateTime(undefined)).toBe("");
		expect(formatDateTime(0)).toBe("");
	});

	test("formats real timestamps to a non-empty string", () => {
		expect(formatDate(Date.now()).length).toBeGreaterThan(0);
		expect(formatDateTime(new Date().toISOString()).length).toBeGreaterThan(0);
	});

	test("formats numeric and ISO string inputs identically", () => {
		const iso = "2026-06-04T09:30:00.000Z";
		const ms = Date.parse(iso);
		expect(formatDate(iso)).toBe(formatDate(ms));
		expect(formatDateTime(iso)).toBe(formatDateTime(ms));
	});

	test("includes the year only outside the current year", () => {
		const currentYear = new Date().getFullYear();
		const current = new Date(currentYear, 5, 4, 9, 30).getTime();
		const previous = new Date(currentYear - 1, 5, 4, 9, 30).getTime();
		expect(formatDate(current)).not.toContain(String(currentYear));
		expect(formatDateTime(current)).not.toContain(String(currentYear));
		expect(formatDate(previous)).toContain(String(currentYear - 1));
		expect(formatDateTime(previous)).toContain(String(currentYear - 1));
	});

	test("falls back to a string for unparseable input rather than throwing", () => {
		const result = formatDate("not-a-date");
		expect(typeof result).toBe("string");
	});
});

describe("ageInWords", () => {
	const LAUNCH = "2026-08-10";
	const at = (iso: string) => ageInWords(LAUNCH, Date.parse(iso));

	test("counts whole days through the first two months", () => {
		expect(at("2026-08-11T00:00:00Z")).toBe("1 day old");
		expect(at("2026-08-13T00:00:00Z")).toBe("3 days old");
		expect(at("2026-09-20T00:00:00Z")).toBe("41 days old");
	});

	// A part-day is not a day, and the strip is read all day: without the floor
	// the same visit would say "1 day old" in the morning and "2 days old" after
	// lunch.
	test("rounds down rather than up", () => {
		expect(at("2026-08-11T23:59:59Z")).toBe("1 day old");
	});

	// The state a preview deployment sits in before the date arrives, and the
	// state the site opens in on the day itself. Neither may print "0 days old",
	// and a negative age must not reach the reader as "-3 days old".
	test("never reports less than a day", () => {
		expect(at("2026-08-10T00:00:00Z")).toBe("1 day old");
		expect(at("2026-08-10T13:00:00Z")).toBe("1 day old");
		expect(at("2026-08-07T00:00:00Z")).toBe("1 day old");
	});

	test("moves up to months, then to years", () => {
		expect(at("2026-10-09T00:00:00Z")).toBe("2 months old");
		expect(at("2027-06-10T00:00:00Z")).toBe("10 months old");
		expect(at("2027-08-10T00:00:00Z")).toBe("1 year old");
		expect(at("2029-08-10T00:00:00Z")).toBe("3 years old");
	});

	// Every unit crosses at some point, and a singular "1 days old" is the kind of
	// thing nobody notices until it is on the front page.
	test("says one day, one month and one year in the singular", () => {
		expect(at("2026-08-11T00:00:00Z")).toBe("1 day old");
		expect(at("2026-10-09T00:00:00Z")).not.toContain("1 months");
		expect(at("2027-08-10T00:00:00Z")).toBe("1 year old");
	});
});
