import { describe, expect, test } from "vitest";

import { loadOverlayModule } from "../../../../support/overlay.ts";

// Every page an unauthenticated visitor can see. One shell around a per-page
// fragment, so what this module actually decides is which way out each page
// offers - and each of those links is a claim about what this instance can do.
//
// Offering the wrong one is not cosmetic. A "Forgot password?" on a self-hosted
// instance leads somewhere that cannot help, because there is no website to
// prove ownership to. A "Sign in" on first-run registration leads to a page that
// cannot let anyone through. A "Change password" where the environment owns the
// password offers a change that silently reverts at the next restart.
//
// Rendered from the real fragments and the real shell: a page that fails to
// render is a blank 500 at the moment somebody is locked out.

import { fileURLToPath } from "node:url";

type AuthPage = {
	page: "change-password" | "cloud-error" | "login" | "register";
	title: string;
	formLabel: string;
	error?: string;
};

type Module = {
	renderAuthPage: (req: unknown, page: AuthPage) => Promise<string>;
	returnPath: (value: unknown) => string;
};

const OVERLAY = new URL("../../../../../overlay/", import.meta.url);

type Options = { cloud?: boolean; envManaged?: boolean; password?: boolean };

function authPage(options: Options = {}) {
	const { cloud = false, envManaged = false, password = true } = options;
	return loadOverlayModule<Module>({
		source: new URL("src/node/routes/authPage.ts", OVERLAY),
		dependencies: {
			"../cloud": {
				cloudConfig: cloud
					? { boxId: "j57box", origin: "https://www.composery.io" }
					: undefined
			},
			"../constants": { rootPath: fileURLToPath(OVERLAY) },
			// Upstream's, and not what is under test: the template pass runs after
			// this module has decided what the page contains.
			"../http": {
				replaceTemplates: (_req: unknown, content: string) => content
			},
			// Marked rather than reimplemented, so an assertion can say "this went
			// through the escaper" without restating what escaping is.
			"../util": { escapeHtml: (value: string) => `ESC(${value})` },
			"./passwordConfig": {
				hasPassword: () => password,
				isEnvPasswordManaged: () => envManaged
			}
		}
	}).exports;
}

const render = (
	options: Options,
	page: Partial<AuthPage> & { page: AuthPage["page"] },
	to?: unknown
) =>
	authPage(options).renderAuthPage(
		{ args: {}, query: to === undefined ? {} : { to } },
		{ title: "Title", formLabel: "Form", ...page }
	);

describe("where each page says you can go next", () => {
	// Only a cloud instance has somewhere to prove ownership, so only a cloud
	// instance can recover a password nobody can produce.
	test("offers password recovery only where there is a website to ask", async () => {
		const link = "/_composery/cloud/authorize?type=password";

		expect(
			await render({ cloud: true }, { page: "change-password" })
		).toContain(link);
		expect(
			await render({ cloud: false }, { page: "change-password" })
		).not.toContain(link);
		// ...and only from the page that is about the password.
		expect(await render({ cloud: true }, { page: "login" })).not.toContain(
			link
		);
	});

	test("offers Composery sign-in only on the sign-in page of a cloud instance", async () => {
		expect(await render({ cloud: true }, { page: "login" })).toContain(
			"Continue with Composery"
		);
		expect(await render({ cloud: false }, { page: "login" })).not.toContain(
			"Continue with Composery"
		);
		expect(await render({ cloud: true }, { page: "register" })).not.toContain(
			"Continue with Composery"
		);
	});

	// The cloud sign-in carries where to land afterwards, taken from the query -
	// so it is a redirect target a visitor chooses, and it is sanitised before it
	// is written into a link this page hands back.
	test("never builds a sign-in link that leaves this instance", async () => {
		for (const to of [
			"https://evil.example",
			"//evil.example",
			"/a?b",
			"/a#b"
		]) {
			const page = await render({ cloud: true }, { page: "login" }, to);

			expect(page, String(to)).toContain('to=%2F"');
			expect(page, String(to)).not.toContain("evil.example");
		}
		expect(
			await render({ cloud: true }, { page: "login" }, "/workspace/project")
		).toContain("to=%2Fworkspace%2Fproject");
	});

	// First-run registration has no password yet, so a way back to sign in would
	// lead to a page that cannot let anybody through.
	test("offers a way back to sign in only once a password exists", async () => {
		// The link, not the words: the sign-in page's own submit button also says
		// "Sign in", so a looser assertion would pass for the wrong reason.
		const link = 'href="{{BASE}}/login">Sign in</a>';

		expect(await render({ password: true }, { page: "register" })).toContain(
			link
		);
		expect(
			await render({ password: false }, { page: "register" })
		).not.toContain(link);
		// Never on the page it would point at.
		expect(await render({ password: true }, { page: "login" })).not.toContain(
			link
		);
	});

	// One rule: shown unless the environment owns the password, because that is
	// the only case where a change made here would not survive a restart.
	test("offers a password change unless the environment owns the password", async () => {
		expect(await render({ envManaged: false }, { page: "login" })).toContain(
			"/change-password"
		);
		expect(await render({ envManaged: true }, { page: "login" })).not.toContain(
			"/change-password"
		);
	});

	test("loads the strength check only on the pages that take a new password", async () => {
		const script = "password-check.js";

		for (const page of ["register", "change-password"] as const) {
			expect(await render({}, { page }), page).toContain(script);
		}
		for (const page of ["login", "cloud-error"] as const) {
			expect(await render({}, { page }), page).not.toContain(script);
		}
	});
});

describe("what the page is told", () => {
	test("escapes everything it is handed", async () => {
		const page = await render(
			{},
			{ page: "login", title: "T", formLabel: "F", error: "E" }
		);

		expect(page).toContain("ESC(T)");
		expect(page).toContain("ESC(F)");
		expect(page).toContain("ESC(E)");
	});

	test("shows an error as an alert, and nothing at all when there is none", async () => {
		expect(
			await render({}, { page: "login", error: "Wrong password" })
		).toContain('role="alert"');
		expect(await render({}, { page: "login" })).not.toContain('role="alert"');
	});

	// The logo is inlined so its currentColor resolves against this page. The
	// generated file hard-codes a colour off prefers-color-scheme so it works as
	// a standalone asset; inlined, that rule would both override the page and be
	// refused by the page's CSP.
	test("inlines the logo without the stylesheet that would fight the page", async () => {
		const page = await render({}, { page: "login" });

		expect(page).toContain('class="auth-logo"');
		// The shell's own <meta> tags legitimately name the colour scheme, so what
		// is asserted is the absence of the stylesheet the logo carries.
		expect(page).not.toContain("<style>");
		expect(page).not.toContain("@media (prefers-color-scheme:dark){svg");
	});

	test("renders every page it offers rather than failing on a missing fragment", async () => {
		for (const page of [
			"login",
			"register",
			"change-password",
			"cloud-error"
		] as const) {
			expect(await render({ cloud: true }, { page }), page).toContain(
				"</html>"
			);
		}
	});
});

// The one rule for where a visitor is sent afterwards, used by this page and by
// every route that takes a `to`.
describe("the return path", () => {
	test("takes a path on this instance and nothing else", () => {
		const { returnPath } = authPage();

		expect(returnPath("/workspace")).toBe("/workspace");
		for (const value of [
			"https://evil.example",
			"//evil.example",
			"/a?b",
			"/a#b",
			"/a\\b",
			"workspace",
			"",
			`/${"a".repeat(512)}`,
			5,
			null,
			undefined
		]) {
			expect(returnPath(value), JSON.stringify(value)).toBe("/");
		}
	});
});
