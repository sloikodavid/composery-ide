import { describe, expect, test } from "vitest";

import {
	SESSION_LIFETIMES,
	createSessionToken,
	isSessionTokenValid,
	readSessionLifetime,
	sessionCookieOptions,
	setSessionCookie
} from "../../overlay/src/node/session.ts";

const NOW = Date.UTC(2026, 6, 27, 12);
const NONCE = "a".repeat(43);

describe("IDE sessions", () => {
	test("the default session lasts eight hours and expires on the server", () => {
		const args = { password: "correct horse battery staple" };
		const token = createSessionToken(args, NOW, NONCE);

		expect(isSessionTokenValid(token, args, NOW)).toBe(true);
		expect(
			isSessionTokenValid(
				token,
				args,
				NOW + SESSION_LIFETIMES["8h"].maxAgeSec * 1000 - 1
			)
		).toBe(true);
		expect(
			isSessionTokenValid(
				token,
				args,
				NOW + SESSION_LIFETIMES["8h"].maxAgeSec * 1000
			)
		).toBe(false);
	});

	test("tampering and password rotation both revoke a session", () => {
		const args = { "hashed-password": "$argon2id$old" };
		const token = createSessionToken(args, NOW, NONCE);
		const replacement = token.endsWith("A") ? "B" : "A";

		expect(
			isSessionTokenValid(`${token.slice(0, -1)}${replacement}`, args, NOW)
		).toBe(false);
		expect(
			isSessionTokenValid(token, { "hashed-password": "$argon2id$new" }, NOW)
		).toBe(false);
	});

	test("browser sessions are non-persistent but still have a signed 30-day cap", () => {
		const args = { password: "password" };
		const token = createSessionToken(args, NOW, NONCE, "browser");
		const options = sessionCookieOptions(
			{ path: "/ide/", sameSite: "lax", secure: true },
			"browser"
		);

		expect(options).toEqual({
			httpOnly: true,
			path: "/ide/",
			sameSite: "lax",
			secure: true
		});
		expect(
			isSessionTokenValid(
				token,
				args,
				NOW + SESSION_LIFETIMES["30d"].maxAgeSec * 1000
			)
		).toBe(false);
	});

	test("persistent policies put the same duration on the cookie", () => {
		for (const lifetime of ["8h", "1d", "7d", "30d"] as const) {
			expect(sessionCookieOptions({}, lifetime).maxAge).toBe(
				SESSION_LIFETIMES[lifetime].maxAgeSec * 1000
			);
		}
	});

	test("invalid configuration fails instead of silently changing security", () => {
		expect(readSessionLifetime(undefined)).toBe("8h");
		expect(() => readSessionLifetime("forever")).toThrow(
			/COMPOSERY_SESSION_LIFETIME must be one of/
		);
	});
});

// The one place a session is actually handed to a browser. It reads the cookie
// name off the request rather than holding one of its own, because code-server
// derives that name per instance - a hard-coded one would authenticate against
// the wrong box on a machine running two.
describe("issuing the cookie", () => {
	test("signs the token with this instance's password and names it per instance", () => {
		const args = { password: "correct horse battery staple" };
		// One slot rather than a list: exactly one cookie is the assertion, and an
		// index would be a possibly-undefined read under the root tsconfig.
		let issued: { name: string; value: string } | undefined;
		let calls = 0;
		const req = { args, cookieSessionName: "composery-session-9911" };
		const res = {
			cookie: (name: string, value: string) => {
				calls += 1;
				issued = { name, value };
			}
		};

		setSessionCookie(req, res, { domain: "box.test" });

		expect(calls).toBe(1);
		expect(issued?.name).toBe("composery-session-9911");
		// Whatever it wrote has to be a session this instance will accept back.
		expect(isSessionTokenValid(issued?.value ?? "", args)).toBe(true);
		// And it must be rejected by an instance with a different password.
		expect(
			isSessionTokenValid(issued?.value ?? "", { password: "something else" })
		).toBe(false);
	});
});
