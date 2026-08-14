import { describe, expect, test } from "vitest";
import {
	normalizeInternalReturnPath,
	parseAuthorizedParties,
	signInUrlForReturnPath
} from "@/lib/auth-routing";

describe("parseAuthorizedParties", () => {
	test("trims and filters configured origins", () => {
		expect(
			parseAuthorizedParties(
				" http://localhost:3000, , https://www.composery.io "
			)
		).toEqual(["http://localhost:3000", "https://www.composery.io"]);
	});

	test("returns an empty list when the value is missing", () => {
		expect(parseAuthorizedParties(undefined)).toEqual([]);
		expect(parseAuthorizedParties("")).toEqual([]);
	});

	test("normalizes origins by stripping the trailing slash", () => {
		expect(parseAuthorizedParties("https://www.composery.io/")).toEqual([
			"https://www.composery.io"
		]);
	});

	test("rejects paths, queries, and hashes on origins", () => {
		expect(() =>
			parseAuthorizedParties("https://www.composery.io/path")
		).toThrow("origins only");
		expect(() =>
			parseAuthorizedParties("https://www.composery.io?q=1")
		).toThrow("origins only");
		expect(() => parseAuthorizedParties("https://www.composery.io#x")).toThrow(
			"origins only"
		);
	});

	test("rejects non-http(s) schemes", () => {
		expect(() => parseAuthorizedParties("ftp://composery.io")).toThrow(
			"http(s)"
		);
		expect(() => parseAuthorizedParties("javascript:alert(1)")).toThrow();
	});

	test("rejects malformed origins", () => {
		expect(() => parseAuthorizedParties("not-a-url")).toThrow();
	});
});

describe("normalizeInternalReturnPath", () => {
	test("keeps internal paths with search params and hashes", () => {
		expect(normalizeInternalReturnPath("/pricing?billing=year#slug")).toBe(
			"/pricing?billing=year#slug"
		);
	});

	test("preserves query-only and hash-only internal paths", () => {
		expect(normalizeInternalReturnPath("/?q=1")).toBe("/?q=1");
		expect(normalizeInternalReturnPath("/boxes#x")).toBe("/boxes#x");
	});

	test("falls back to root for external or protocol-relative paths", () => {
		expect(normalizeInternalReturnPath("https://evil.test/boxes")).toBe("/");
		expect(normalizeInternalReturnPath("//evil.test/boxes")).toBe("/");
		expect(normalizeInternalReturnPath("pricing")).toBe("/");
	});

	test("falls back to root for backslash-based protocol evasion", () => {
		expect(normalizeInternalReturnPath("/\\evil.test/boxes")).toBe("/");
	});

	test("rejects data and javascript URIs", () => {
		expect(normalizeInternalReturnPath("data:text/html,x")).toBe("/");
	});

	test("always returns a path starting with a single slash", () => {
		for (const input of ["/boxes", "/a/b?c=1#d", "//x", "bad", ""]) {
			const result = normalizeInternalReturnPath(input);
			expect(result.startsWith("/")).toBe(true);
			expect(result.startsWith("//")).toBe(false);
		}
	});
});

describe("signInUrlForReturnPath", () => {
	test("preserves the redirect query contract", () => {
		expect(signInUrlForReturnPath("/pricing")).toBe(
			"/sign-in?redirect_url=%2Fpricing"
		);
	});

	test("url-encodes the query string and separators in the return path", () => {
		expect(signInUrlForReturnPath("/pricing?slug=a&billing=year")).toBe(
			"/sign-in?redirect_url=%2Fpricing%3Fslug%3Da%26billing%3Dyear"
		);
	});

	test("neutralizes an external return path into the root", () => {
		expect(signInUrlForReturnPath("//evil.test/x")).toBe(
			"/sign-in?redirect_url=%2F"
		);
	});
});
