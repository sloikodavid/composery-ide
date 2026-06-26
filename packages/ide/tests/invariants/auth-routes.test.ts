import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

import { readRepoFile, repoRoot } from "../../../../tests/support/repo.ts";
import { addedLines } from "../support/patch.ts";

// What is left of the auth flows once the routes themselves are run rather than
// read. Every remaining check is one no running module can make:
//
//   - the text of `auth.diff`, because a patch can only ever be read - login and
//     the workbench command live inside it;
//   - agreements between this package and packages/web, where neither side's own
//     tests can load the other's copy;
//   - facts about the tree as a whole, like every auth link staying relative to
//     a mount this server cannot know.
//
// Everything that used to be a `toContain` over a route's own source has moved
// next door to packages/ide/tests/behavior/src/node/routes/, which drives the
// shipped module through the overlay loader
// (packages/ide/tests/support/overlay.ts). Anything added here that a test could
// instead run belongs there: a grep over code that could have executed is the
// one shape that cannot fail for the right reason.

const register = readRepoFile(
	"packages/ide/overlay/src/node/routes/register.ts"
);
const changePassword = readRepoFile(
	"packages/ide/overlay/src/node/routes/changePassword.ts"
);

describe("auth page navigation", () => {
	const pagesDir = "packages/ide/overlay/src/browser/pages";
	const authPage = readRepoFile(`${pagesDir}/../../node/routes/authPage.ts`);

	test("every page but login offers a way back to sign in", () => {
		const fragments = readdirSync(resolve(repoRoot, pagesDir)).filter((name) =>
			name.endsWith("-fields.html")
		);
		expect(fragments).toContain("login-fields.html");
		for (const fragment of fragments) {
			const source = readRepoFile(`${pagesDir}/${fragment}`);
			// login is where the link points, so it carries the reverse edge.
			const expected =
				fragment === "login-fields.html"
					? "{{CHANGE_PASSWORD_LINK}}"
					: "{{SIGN_IN_LINK}}";
			expect(source, fragment).toContain(expected);
		}
	});

	test("the sign-in link is gated on a password existing", () => {
		// First-run registration has no password yet, so a sign-in link there
		// would lead to a page that cannot let anyone through.
		expect(authPage).toContain('page !== "login" && hasPassword(req.args)');
		expect(authPage).toContain('href="{{BASE}}/login">Sign in');
	});

	test("all owned auth navigation remains relative to the unknown public mount", () => {
		const routeDir = "packages/ide/overlay/src/node/routes";
		const routeFiles = (dir: string): string[] =>
			readdirSync(resolve(repoRoot, dir)).flatMap((name) => {
				const path = `${dir}/${name}`;
				return statSync(resolve(repoRoot, path)).isDirectory()
					? routeFiles(path)
					: name.endsWith(".ts")
						? [path]
						: [];
			});

		const absoluteRedirects = routeFiles(routeDir).flatMap((path) => {
			const source = readRepoFile(path);
			return [
				...source.matchAll(
					/(?:\bres\.redirect\(|\bredirect\(\s*req,\s*res,)\s*["'`]\/(?!\/)/g
				)
			].map((match) => `${path}:${match.index}`);
		});
		const absoluteLinks = readdirSync(resolve(repoRoot, pagesDir))
			.filter((name) => name.endsWith(".html"))
			.flatMap((name) => {
				const source = readRepoFile(`${pagesDir}/${name}`);
				return [...source.matchAll(/\b(?:action|href)=["']\/(?!\/)/g)].map(
					(match) => `${name}:${match.index}`
				);
			});

		expect(absoluteRedirects).toEqual([]);
		expect(absoluteLinks).toEqual([]);
	});
});

// The register route is run rather than read, in
// packages/ide/tests/behavior/src/node/routes/register.test.ts: that it refuses
// once a password exists, that only a setup grant may pass that guard, that the
// environment still outranks the grant, and that `ensureOrigin` stands in front
// of the claim. Each of those was checked by breaking it and watching a test
// fail, which is what a `toContain` over the same code could never do.

describe("change-password route", () => {
	// What this route does is run rather than read, in
	// packages/ide/tests/behavior/src/node/routes/changePassword.test.ts: that a
	// cloud instance changes its password on the same terms as a self-hosted
	// one, that the website is told before anything is written locally, that a
	// wrong guess costs a token and a right one does not, and that `ensureOrigin`
	// stands in front of both POSTs. What is left here is the part no single
	// module can show - that the budget being spent is *login's*, which lives in
	// a patch, and that only one of it exists.
	test("the recovery link is offered from the page, not forced on the route", () => {
		// Holding the password must never require a Composery website account:
		// someone handed the password can rotate it. The grant flow stays the
		// recovery path for a password you cannot produce.
		expect(
			readRepoFile("packages/ide/overlay/src/node/routes/authPage.ts")
		).toContain(
			'href="{{BASE}}/_composery/cloud/authorize?type=password">Forgot password?'
		);
	});

	test("guessing here spends login's own per-source budget", () => {
		// /change-password/verify answers the same question as /login, so a
		// limiter of its own would just be a way around login's. One shared
		// instance, keyed the same way, is what makes that impossible - and
		// login lives in a patch, which can only ever be read.
		const login = addedLines(readRepoFile("packages/ide/patches/auth.diff"));
		for (const source of [changePassword, login]) {
			expect(source).toContain(
				'loginRateLimit, loginSource } from "./loginRateLimit"'
			);
			expect(source).toContain("loginRateLimit.canTry(source)");
			expect(source).toContain("loginRateLimit.recordFailure(source)");
		}
		// ...and only one instance exists to share.
		expect(
			readRepoFile("packages/ide/overlay/src/node/routes/loginRateLimit.ts")
		).toContain("export const loginRateLimit = new LoginRateLimit()");
		expect(changePassword).not.toMatch(/new\s+\w*(?:RateLimit|Limiter)/);
	});

	test("the workbench asks the same question the route does", () => {
		// The website renders COMPOSERY_HASHED_PASSWORD into every cloud
		// instance's env file, so a rule of "the environment owns the password"
		// would lock the change and recovery flows out of every cloud instance
		// that had one. That `isEnvPasswordManaged` says otherwise is run in
		// packages/ide/tests/behavior/src/node/routes/passwordConfig.test.ts;
		// what is pinned here is that the workbench command reads the same
		// predicate rather than a second copy of the rule, because that half
		// lives in a patch.
		expect(
			addedLines(readRepoFile("packages/ide/patches/auth.diff"))
		).toContain(
			'"change-password": args.auth === AuthType.Password && !isEnvPasswordManaged(args),'
		);
	});

	test("a password an instance changed itself is reconciled into its env file", () => {
		// The env file the website renders is where a cloud instance reads its
		// password from, and it still holds the old hash after a local change.
		// Recording the new one in Convex alone leaves a password that works
		// until the next restart and then silently reverts.
		const auth = readRepoFile("packages/web/convex/instance/auth.ts");
		const start = auth.indexOf("export const applyPasswordChange");
		const apply = auth.slice(start, auth.indexOf("\nexport const", start + 1));
		expect(apply).toContain("internal.instance.auth.reconcilePassword");
		// ...and the reconcile has to re-render the env file from the new hash,
		// not merely restart the instance on the old one.
		const host = readRepoFile("packages/web/convex/boxes/infra/host.ts");
		const rewrite = host.slice(
			host.indexOf("export const rewritePasswordAndRestart")
		);
		expect(rewrite.slice(0, rewrite.indexOf("await runSsh"))).toContain(
			"runtimeAuthHash: args.runtimeAuthHash"
		);
	});
});

describe("signed sessions", () => {
	const sessions = readRepoFile("packages/ide/patches/sessions.diff");
	const cloudAuth = readRepoFile(
		"packages/ide/overlay/src/node/routes/cloudAuth.ts"
	);

	test("password and Composery sign-in issue the same local capability", () => {
		// The same call with the same options at every entry point. Composery
		// sign-in used to mint its cookie with a scope of its own, which the
		// browser kept as a second cookie that Sign Out could not clear.
		const login = addedLines(readRepoFile("packages/ide/patches/auth.diff"));
		for (const source of [login, register, changePassword, cloudAuth]) {
			expect(source).toContain(
				"setSessionCookie(req, res, getCookieOptions(req))"
			);
		}
	});

	test("the session cookie reaches every route this server authenticates", () => {
		// /proxy and /absproxy are mounted above the workbench, so a cookie
		// scoped to the workbench mount was never sent to them and the port
		// proxy answered every browser request with a redirect to sign in.
		expect(addedLines(sessions)).toContain('    path: "/",');
		// Nothing about the scope may come from the caller: a client that picks
		// the Domain widens its own session to a parent domain.
		const http = sessions.slice(sessions.indexOf("getCookieOptions"));
		expect(http).not.toContain("+    domain:");
		expect(sessions).toContain("-    req.query.base || req.body?.base");
		expect(
			readRepoFile("packages/ide/overlay/src/browser/pages/auth.html")
		).not.toContain('name="href"');
	});

	test("authentication validates signed session tokens", () => {
		expect(addedLines(sessions)).toContain(
			"return isSessionTokenValid(sanitizeString(req.cookies[req.cookieSessionName]), req.args)"
		);
	});

	// That the two capabilities cannot be interchanged is no longer read at all:
	// both ends run it. The instance refuses a grant of the kind it did not ask
	// for in
	// packages/ide/tests/behavior/src/node/routes/cloudAuth.test.ts, and the
	// website refuses to issue one in
	// packages/web/tests/behavior/convex/instance/auth.test.ts.
});

describe("disabled authentication", () => {
	const disableAuth = readRepoFile("packages/ide/patches/auth.diff");

	test("only an explicit 1/true unprotects the instance", () => {
		// Every other value, typos included, has to leave sign-in required: a
		// misread switch must never be the thing that opens the instance. The
		// reading itself lives in envFlag.ts and is tested there; what this pins
		// is that the switch goes through it rather than carrying a fifth copy.
		expect(disableAuth).toContain('envFlag("COMPOSERY_DISABLE_AUTH")');
		expect(disableAuth).not.toMatch(
			/COMPOSERY_DISABLE_AUTH["'`]?\s*\??\.\s*(match|test|toLowerCase|trim)/
		);
	});

	test("the switch selects the auth type every gate already reads", () => {
		// authenticated() short-circuits on AuthType.None, so selecting it is
		// what opens the workbench, both proxies and the websockets together.
		// A surface gated on the env var directly would drift out of step.
		expect(disableAuth).toContain("args.auth = AuthType.None");
		const elsewhere = readRepoFile("packages/ide/patches/series")
			.split(/\r?\n/)
			.filter((patch) => patch && patch !== "auth.diff")
			.flatMap((patch) =>
				addedLines(readRepoFile(`packages/ide/patches/${patch}`)).split("\n")
			);
		expect(
			elsewhere.filter((line) => line.includes("COMPOSERY_DISABLE_AUTH"))
		).toEqual([]);
	});

	test("the disabled state is a warning, not a log line", () => {
		// Silent success is the failure mode here: an operator who does not
		// notice keeps a root-capable terminal open to whoever finds it.
		expect(disableAuth).toContain(
			'-    logger.info("  - Authentication is disabled")'
		);
		expect(disableAuth).toContain("+    logger.warn(");
	});

	test("a configured password says it is being ignored", () => {
		expect(disableAuth).toContain('args.password || args["hashed-password"]');
	});

	// That the cloud flows stop here too - with sign-in off their only job would
	// be to report a success that gates nothing - is run in
	// packages/ide/tests/behavior/src/node/routes/cloudAuth.test.ts.
});
