import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { accountBlock, errorMessage } from "@/lib/error-message";

describe("errorMessage", () => {
	test("extracts the string payload of a ConvexError", () => {
		expect(errorMessage(new ConvexError("nope"))).toBe("nope");
	});

	test("serializes a non-string ConvexError payload", () => {
		expect(errorMessage(new ConvexError({ kind: "user_suspended" }))).toBe(
			JSON.stringify({ kind: "user_suspended" })
		);
	});

	test("reads the message of a plain Error", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
	});

	test("stringifies non-Error throwables", () => {
		expect(errorMessage("literal string")).toBe("literal string");
		expect(errorMessage(42)).toBe("42");
		expect(errorMessage(undefined)).toBe("undefined");
	});
});

// The one refusal a page draws as a card rather than a toast: an account that is
// suspended or mid-deletion (see `convex/users.ts` -> AccountBlock). `kind` is
// what separates it from any other error that happens to carry prose, so a
// titled error without it must stay a toast.
describe("accountBlock", () => {
	const blocked = new ConvexError({
		kind: "account_unavailable",
		title: "Your account is suspended",
		detail: "abuse"
	});

	test("reads the two strings a blocked account carries", () => {
		expect(accountBlock(blocked)).toEqual({
			title: "Your account is suspended",
			detail: "abuse"
		});
	});

	// The same words a card would show, joined, so an action's toast and the page
	// behind it cannot describe one refusal two ways.
	test("is the same wording errorMessage gives a toast", () => {
		expect(errorMessage(blocked)).toBe("Your account is suspended. abuse");
	});

	test("ignores an error of any other kind", () => {
		expect(
			accountBlock(
				new ConvexError({ kind: "something_else", title: "T", detail: "D" })
			)
		).toBeNull();
		expect(accountBlock(new ConvexError("Box not found."))).toBeNull();
		expect(accountBlock(new Error("boom"))).toBeNull();
		expect(accountBlock("not an error")).toBeNull();
	});

	// Half a payload is not a card. A page that rendered `undefined` under a
	// heading would be worse than the generic error page it fell back from.
	test("refuses a payload missing either string", () => {
		expect(
			accountBlock(
				new ConvexError({ kind: "account_unavailable", title: "Only a title" })
			)
		).toBeNull();
		expect(
			accountBlock(
				new ConvexError({
					kind: "account_unavailable",
					detail: "Only a detail"
				})
			)
		).toBeNull();
	});
});
