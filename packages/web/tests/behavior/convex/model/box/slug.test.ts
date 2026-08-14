import { array, assert, constantFrom, property, string } from "fast-check";
import { describe, expect, test } from "vitest";
import {
	RESERVED_BOX_SLUGS,
	isReservedSlug,
	isValidSlug,
	isValidSlugFormat,
	sanitizeSlug
} from "@/convex/model/box/slug";

const SLUG_CHARACTER = [
	..."abcdefghijklmnopqrstuvwxyz",
	..."0123456789",
	"-"
] as const;

const validSlugArbitrary = array(constantFrom(...SLUG_CHARACTER), {
	minLength: 1,
	maxLength: 53
}).map((middle) => `property-${middle.join("")}x`);

describe("sanitizeSlug", () => {
	test("never turns a valid slug into an invalid one", () => {
		assert(
			property(validSlugArbitrary, (slug) => {
				const sanitized = sanitizeSlug(slug);
				expect(sanitized).toBe(slug);
				expect(isValidSlug(sanitized)).toBe(true);
			})
		);
	});

	test("lowercases, strips invalid characters, and trims leading dashes", () => {
		expect(sanitizeSlug("--My Box!!")).toBe("mybox");
	});

	test("limits slugs to 63 characters", () => {
		expect(sanitizeSlug("a".repeat(70))).toHaveLength(63);
	});

	test("returns an empty string for input with no usable characters", () => {
		expect(sanitizeSlug("")).toBe("");
		expect(sanitizeSlug("---")).toBe("");
		expect(sanitizeSlug("   ")).toBe("");
		expect(sanitizeSlug("!!!")).toBe("");
	});

	test("removes every character outside the a-z0-9- set", () => {
		expect(sanitizeSlug("H3ll0_Wörld-2026")).toBe("h3ll0wrld-2026");
	});

	test("collapses nothing: trailing dashes are preserved by sanitize", () => {
		expect(sanitizeSlug("box-")).toBe("box-");
	});

	test("drops invalid characters but keeps the dashes around them", () => {
		expect(sanitizeSlug("café-Æ-🐍-box")).toBe("caf---box");
	});

	// A grapheme is not a character here, and the difference is visible.
	//
	// `1️⃣` is three codepoints - DIGIT ONE, VARIATION SELECTOR-16, COMBINING
	// ENCLOSING KEYCAP - so what the reader typed as one emoji contains a literal
	// ASCII `1`, and a filter over `[a-z0-9-]` keeps it. That is the right
	// behaviour: the rule is "characters a DNS label may hold", and this one may.
	// It is pinned because it reads like a bug at a glance, and the next person to
	// notice it should find this rather than "fix" the filter into stripping
	// digits that arrived inside something decorative.
	test("keeps the ASCII a decorative grapheme is built from", () => {
		expect(sanitizeSlug("café-Æ-1️⃣-box")).toBe("caf--1-box");
	});
});

describe("isValidSlug", () => {
	test("never accepts a slug outside the DNS and reservation rules", () => {
		const reserved = new Set<string>(RESERVED_BOX_SLUGS);
		assert(
			property(string({ maxLength: 100 }), (slug) => {
				const validByContract =
					slug.length >= 3 &&
					slug.length <= 63 &&
					!slug.startsWith("xn--") &&
					/^[a-z0-9]$/.test(slug[0] ?? "") &&
					/^[a-z0-9]$/.test(slug.at(-1) ?? "") &&
					[...slug].every((character) => /^[a-z0-9-]$/.test(character)) &&
					!reserved.has(slug);
				expect(isValidSlug(slug)).toBe(validByContract);
			}),
			{ examples: [["xn--box"], ["box-\n"], ["abc\n"]] }
		);
	});

	test("accepts DNS-safe box slugs", () => {
		expect(isValidSlug("my-box")).toBe(true);
		expect(isValidSlug("abc")).toBe(true);
		expect(isValidSlug("a-b-c")).toBe(true);
		expect(isValidSlug("box1")).toBe(true);
		expect(isValidSlug("123")).toBe(true);
	});

	test("rejects too-short slugs", () => {
		expect(isValidSlug("ab")).toBe(false);
		expect(isValidSlug("a")).toBe(false);
		expect(isValidSlug("")).toBe(false);
	});

	test("rejects leading and trailing dashes", () => {
		expect(isValidSlug("-box")).toBe(false);
		expect(isValidSlug("box-")).toBe(false);
		expect(isValidSlug("-box-")).toBe(false);
	});

	test("rejects punycode-prefixed slugs", () => {
		expect(isValidSlug("xn--box")).toBe(false);
	});

	test("rejects invalid characters and casing", () => {
		expect(isValidSlug("my_box")).toBe(false);
		expect(isValidSlug("My-Box")).toBe(false);
		expect(isValidSlug("my.box")).toBe(false);
		expect(isValidSlug("my box")).toBe(false);
	});

	test("accepts the maximum 63-character slug and rejects 64", () => {
		expect(isValidSlug("a".repeat(63))).toBe(true);
		expect(isValidSlug("a".repeat(64))).toBe(false);
	});

	test("allows consecutive interior dashes", () => {
		expect(isValidSlug("a--b")).toBe(true);
	});
});

describe("isValidSlugFormat", () => {
	test("separates well-formed reserved names from malformed slugs", () => {
		expect(isValidSlugFormat("console")).toBe(true);
		expect(isValidSlugFormat("my-box")).toBe(true);
		expect(isValidSlugFormat("ab")).toBe(false);
		expect(isValidSlugFormat("my-box-")).toBe(false);
	});
});

describe("reserved slugs", () => {
	test("blocks runtime subdomains from being claimed as box slugs", () => {
		for (const slug of ["console", "www", "api", "admin", "docs", "status"]) {
			expect(isReservedSlug(slug)).toBe(true);
			expect(isValidSlug(slug)).toBe(false);
		}
	});

	test("does not block ordinary box slugs", () => {
		expect(isReservedSlug("my-box")).toBe(false);
		expect(isReservedSlug("productionbox")).toBe(false);
	});

	test("reserved checks are case-sensitive (reservations are lowercase)", () => {
		expect(isReservedSlug("Console")).toBe(false);
		expect(isReservedSlug("CONSOLE")).toBe(false);
	});
});
