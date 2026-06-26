import { describe, expect, test, vi } from "vitest";

import { loadOverlayModule } from "../../../../support/overlay.ts";

type AuthPage = "login" | "register" | "change-password";
type AuthErrors = {
	authErrorCodes: (page: AuthPage) => string[];
	authErrorMessage: (page: AuthPage, code: unknown) => string | undefined;
};

// i18n is code-server's, and lives outside the overlay; stub it so the table can
// be run, and return the key so a message that comes from upstream is visible as
// one in these assertions.
const load = (t = vi.fn((key: string) => `translated:${key}`)) => ({
	t,
	...loadOverlayModule<AuthErrors>({
		source: new URL(
			"../../../../../overlay/src/node/routes/authErrors.ts",
			import.meta.url
		),
		dependencies: { "../i18n": { t } }
	}).exports
});

describe("auth page errors", () => {
	test("a page renders the codes it is sent and says nothing about the rest", () => {
		const { authErrorMessage } = load();

		expect(authErrorMessage("register", "mismatch")).toBe(
			"Passwords do not match"
		);
		expect(authErrorMessage("register", "incorrect-current")).toBeUndefined();
		expect(authErrorMessage("login", "nonsense")).toBeUndefined();
	});

	// req.query.error is whatever the URL carried: absent, repeated (an array), or
	// an object via qs's bracket syntax. None of those is a code.
	test.each<[shape: string, code: unknown]>([
		["absent", undefined],
		["repeated", ["missing", "incorrect"]],
		["an object", { toString: (): string => "missing" }],
		["empty", ""]
	])("a %s error is not a code", (_shape, code) => {
		expect(load().authErrorMessage("login", code)).toBeUndefined();
	});

	// The locale is chosen per request, so a message resolved once at load would
	// be the first visitor's language for every visitor after them.
	test("an upstream message is translated on each render, not at load", () => {
		const { t, authErrorMessage } = load();
		expect(t).not.toHaveBeenCalled();

		expect(authErrorMessage("login", "incorrect")).toBe(
			"translated:INCORRECT_PASSWORD"
		);
		expect(authErrorMessage("login", "incorrect")).toBe(
			"translated:INCORRECT_PASSWORD"
		);
		expect(t).toHaveBeenCalledTimes(2);
	});

	test("Composery's own messages are not routed through translation", () => {
		const { t, authErrorMessage } = load();

		expect(authErrorMessage("login", "configured")).toBe(
			"Password was already configured. Sign in instead."
		);
		expect(t).not.toHaveBeenCalled();
	});

	// register bounces an owner who already has a password to login, so login is
	// the page that has to explain why - a code rendered by the page that sent it
	// would never be seen.
	test("login can explain the codes register bounces to it", () => {
		const { authErrorCodes } = load();

		expect(authErrorCodes("login")).toEqual(
			expect.arrayContaining(["configured", "env-managed"])
		);
	});

	test("every page has at least one code, and no code has an empty message", () => {
		const { authErrorCodes, authErrorMessage } = load();

		for (const page of ["login", "register", "change-password"] as const) {
			const codes = authErrorCodes(page);
			expect(codes.length, page).toBeGreaterThan(0);
			for (const code of codes) {
				expect(authErrorMessage(page, code), `${page}:${code}`).toEqual(
					expect.any(String)
				);
				expect(authErrorMessage(page, code)!.length).toBeGreaterThan(0);
			}
		}
	});
});
