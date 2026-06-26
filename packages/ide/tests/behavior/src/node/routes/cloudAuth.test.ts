import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { loadOverlayModule } from "../../../../support/overlay.ts";

// The cloud sign-in and password-recovery path, run rather than read. Every
// decision here hands out a capability over a redirect the browser carries: the
// PKCE binding, the transaction this instance started, which kind of grant came
// back, and where the browser is sent afterwards. Each is one `if` away from
// being decorative, and none of them fails loudly when it stops working - a
// callback that mints a session for a grant nobody asked for looks exactly like
// a successful sign-in.
//
// The module talks to the website over `fetch` and to the browser over express,
// so both are supplied here. What is asserted is the request this instance makes
// and the response it writes; the transport is not ours.

const OVERLAY = new URL("../../../../../overlay/", import.meta.url);
const CLOUD = { boxId: "j57box", origin: "https://www.composery.io" };
// Whatever code-server decided the cookie scope is. Its correctness belongs to
// `getCookieOptions`; what matters here is that the cloud cookies take it rather
// than inventing a scope of their own.
const COOKIE_OPTIONS = { path: "/ide/", sameSite: "lax" };
const HOST = "box.test";
const CALLBACK = `https://${HOST}/ide/_composery/cloud/callback`;
const TRANSACTION_COOKIE = "composery-cloud-authorization";
const SETUP_COOKIE = "composery-cloud-setup";
const TEN_MINUTES = 10 * 60_000;

// 43 base64url characters, the shape every token in this flow has to have.
const token = (seed: string) =>
	createHash("sha256").update(seed).digest("base64url");
const CODE = token("code");
const GRANT = token("grant");

const encode = (value: unknown) =>
	Buffer.from(JSON.stringify(value)).toString("base64url");

type Query = Record<string, unknown>;
type CookieOptions = Record<string, unknown>;
type Transaction = {
	state: string;
	to: string;
	type: string;
	verifier: string;
};

type Request = {
	args: { auth: string };
	cookieSessionName: string;
	cookies: Record<string, string>;
	headers: { host?: string };
	originalUrl: string;
	query: Query;
};

// Both halves of what a handler writes: the express calls, and the two overlay
// helpers it reaches for instead (`redirect` is upstream's relative-mount
// redirect, `setSessionCookie` the one place a local session is issued).
type Response = {
	body: string;
	cleared: string[];
	cookies: { name: string; value: string; options: CookieOptions }[];
	headers: Record<string, string>;
	redirected: string;
	relative: { to: string; override: Query } | undefined;
	sessionOptions: CookieOptions | undefined;
	statusCode: number;
	clearCookie: (name: string, options: CookieOptions) => void;
	cookie: (name: string, value: string, options: CookieOptions) => void;
	redirect: (to: string) => void;
	send: (body: string) => void;
	setHeader: (name: string, value: string) => void;
	status: (code: number) => Response;
};

type Handler = (req: Request, res: Response, next: () => void) => unknown;

type Answer = { ok: boolean; body: unknown };

type RequestOptions = {
	cookies?: Record<string, string>;
	host?: string | undefined;
	query?: Query;
};

type Options = RequestOptions & {
	auth?: string;
	cloud?: { boxId: string; origin: string } | undefined;
	password?: boolean;
	respond?: (body: Record<string, unknown>) => Answer;
};

type CloudAuth = {
	changeCloudPassword: (current: string, next: string) => Promise<void>;
	clearCloudSetupGrant: (req: Request, res: Response) => void;
	hasCloudSetupGrant: (req: Request) => boolean;
	installCloudPassword: (req: Request, hash: string) => Promise<void>;
};

function response(): Response {
	const res: Response = {
		body: "",
		cleared: [],
		cookies: [],
		headers: {},
		redirected: "",
		relative: undefined,
		sessionOptions: undefined,
		statusCode: 200,
		clearCookie: (name) => {
			res.cleared.push(name);
		},
		cookie: (name, value, options) => {
			res.cookies.push({ name, value, options });
		},
		redirect: (to) => {
			res.redirected = to;
		},
		send: (body) => {
			res.body = body;
		},
		setHeader: (name, value) => {
			res.headers[name] = value;
		},
		status: (code) => {
			res.statusCode = code;
			return res;
		}
	};
	return res;
}

function instance(options: Options = {}) {
	const {
		auth = "password",
		password = true,
		// The website echoes back the kind of grant it issued; a run that wants to
		// see the two kinds crossed replaces this.
		respond = (body: Record<string, unknown>): Answer => ({
			ok: true,
			body: { grant: GRANT, type: body["type"] }
		})
	} = options;
	// A destructuring default would fire on an explicit `undefined`, which is
	// exactly the self-hosted case these tests need to express.
	const cloud = Object.hasOwn(options, "cloud") ? options.cloud : CLOUD;

	const exchanges: { url: string; body: Record<string, unknown> }[] = [];
	// Shaped like `fetch` and its response rather than declared `async`, which
	// would only be a promise this never awaits.
	function exchange(url: URL, init: { body: string }) {
		const body = JSON.parse(init.body) as Record<string, unknown>;
		exchanges.push({ url: url.toString(), body });
		const answer = respond(body);
		return Promise.resolve({
			ok: answer.ok,
			json: () => Promise.resolve(answer.body)
		});
	}

	// The real page renderer, pointed at the real fragments: a cloud failure that
	// renders nothing is a 500, and stubbing the renderer would hide it. Its own
	// dependencies are upstream's and are not what is under test here.
	const authPage = loadOverlayModule<Record<string, unknown>>({
		source: new URL("src/node/routes/authPage.ts", OVERLAY),
		dependencies: {
			"../cloud": { cloudConfig: cloud },
			"../constants": { rootPath: fileURLToPath(OVERLAY) },
			"../http": {
				replaceTemplates: (_req: unknown, content: string) => content
			},
			"../util": { escapeHtml: (value: string) => value },
			"./passwordConfig": {
				hasPassword: () => password,
				isEnvPasswordManaged: () => false
			}
		}
	}).exports;

	const guards: Handler[] = [];
	const routes = new Map<string, Handler>();
	const module = loadOverlayModule<CloudAuth>({
		source: new URL("src/node/routes/cloudAuth.ts", OVERLAY),
		dependencies: {
			express: {
				Router: () => ({
					use: (handler: Handler) => guards.push(handler),
					get: (path: string, handler: Handler) => routes.set(path, handler)
				})
			},
			"../cli": { AuthType: { None: "none", Password: "password" } },
			"../cloud": { cloudConfig: cloud },
			"../http": {
				// Upstream's relative-mount arithmetic is tested upstream; here the
				// question is only which target was chosen.
				constructRedirectPath: (_req: unknown, _query: Query, to: string) => to,
				getCookieOptions: () => COOKIE_OPTIONS,
				redirect: (
					_req: unknown,
					res: Response,
					to: string,
					override: Query = {}
				) => {
					res.relative = { to, override };
				}
			},
			"../session": {
				setSessionCookie: (
					_req: unknown,
					res: Response,
					cookieOptions: CookieOptions
				) => {
					res.sessionOptions = cookieOptions;
				}
			},
			"./authPage": authPage,
			"./passwordConfig": { hasPassword: () => password }
		},
		globals: { AbortSignal, Buffer, URL, fetch: exchange }
	}).exports;

	function request(request_: RequestOptions = {}): Request {
		// As with `cloud` above: a request that arrives with no Host header is a
		// case these tests have to be able to state, so an explicit `undefined`
		// cannot be allowed to fall back to one.
		const host = Object.hasOwn(request_, "host") ? request_.host : HOST;
		return {
			args: { auth },
			cookieSessionName: "composery-session",
			cookies: request_.cookies ?? {},
			headers: host === undefined ? {} : { host },
			originalUrl: "/ide/_composery/cloud/authorize",
			query: request_.query ?? {}
		};
	}

	async function visit(path: string, req: Request): Promise<Response> {
		const res = response();
		for (const guard of guards) {
			let advanced = false;
			await guard(req, res, () => {
				advanced = true;
			});
			if (!advanced) return res;
		}
		const handler = routes.get(path);
		if (!handler) throw new Error(`no route at ${path}`);
		await handler(req, res, () => undefined);
		return res;
	}

	return {
		...module,
		exchanges,
		authorize: (request_: RequestOptions = {}) =>
			visit("/authorize", request(request_)),
		callback: (request_: RequestOptions = {}) =>
			visit("/callback", request(request_)),
		errorPage: () => visit("/error", request()),
		request,
		// One browser carrying one authorization through: whatever /authorize wrote
		// is what /callback is handed back, rather than a cookie a test made up.
		async start(request_: RequestOptions = {}) {
			const res = await visit("/authorize", request(request_));
			return { open: open(res), cookies: carried(res), res };
		}
	};
}

function written(res: Response, name: string) {
	return res.cookies.findLast((entry) => entry.name === name);
}

function carried(res: Response): Record<string, string> {
	const cookie = written(res, TRANSACTION_COOKIE);
	return cookie ? { [TRANSACTION_COOKIE]: cookie.value } : {};
}

function transactions(res: Response): Transaction[] {
	const cookie = written(res, TRANSACTION_COOKIE);
	if (!cookie) return [];
	return JSON.parse(
		Buffer.from(cookie.value, "base64url").toString("utf8")
	) as Transaction[];
}

/** The single open transaction, asserting on the way that there is exactly one. */
function open(res: Response): Transaction {
	const all = transactions(res);
	const [first] = all;
	if (all.length !== 1 || !first) {
		throw new Error(`expected one open transaction, got ${all.length}`);
	}
	return first;
}

describe("starting a cloud authorization", () => {
	// The whole point of PKCE: what travels through the browser is a hash, so a
	// stolen authorization code cannot be redeemed by whoever stole it. A
	// challenge that were merely the verifier again would look identical from the
	// outside and prove nothing.
	test("sends a challenge the browser cannot turn back into the verifier", async () => {
		const res = await instance().authorize();
		const transaction = open(res);
		const authorization = new URL(res.redirected);

		expect(authorization.searchParams.get("code_challenge")).toBe(
			createHash("sha256").update(transaction.verifier).digest("base64url")
		);
		expect(res.redirected).not.toContain(transaction.verifier);
		expect(authorization.searchParams.get("state")).toBe(transaction.state);
	});

	test("names this instance and a callback on its own host", async () => {
		const res = await instance().authorize();
		const authorization = new URL(res.redirected);

		expect(authorization.origin).toBe(CLOUD.origin);
		expect(authorization.pathname).toBe("/boxes/authorize");
		expect(authorization.searchParams.get("box_id")).toBe(CLOUD.boxId);
		expect(authorization.searchParams.get("redirect_uri")).toBe(CALLBACK);
		// Setting the password is what an owner with no session can still start.
		expect(authorization.searchParams.get("type")).toBe("password");
		expect(res.headers["Cache-Control"]).toBe("no-store");
		// The state is in this URL, so it must not travel to the website as a
		// referrer from any page the browser lands on.
		expect(res.headers["Referrer-Policy"]).toBe("no-referrer");
	});

	// Not the instance's own host header: a request that arrives without one
	// would otherwise build `https://undefined/...` and send an owner there.
	test("will not invent a callback host it was not given", async () => {
		await expect(instance().authorize({ host: undefined })).rejects.toThrow(
			/Missing request host/
		);
	});

	test("scopes the transaction like every other cookie and expires it", async () => {
		const res = await instance().authorize();

		expect(written(res, TRANSACTION_COOKIE)?.options).toEqual({
			...COOKIE_OPTIONS,
			maxAge: TEN_MINUTES
		});
	});

	test("refuses an authorization type it did not define", async () => {
		const res = await instance().authorize({ query: { type: "admin" } });

		expect(res.statusCode).toBe(400);
		expect(res.cookies).toEqual([]);
		expect(res.redirected).toBe("");
	});

	// A cloud session is signed by the password, so there is nothing to sign with
	// until one exists. Offering the session flow first would hand back a grant
	// this instance could not turn into a session.
	test("sends an owner with no password through the password capability first", async () => {
		const res = await instance({ password: false }).authorize({
			query: { type: "session", to: "/workspace" }
		});

		expect(res.relative).toEqual({
			to: "_composery/cloud/authorize",
			override: { type: "password", to: undefined }
		});
		expect(res.cookies).toEqual([]);
	});

	// A browser that opened several tabs, or gave up halfway and started again,
	// still has to be able to finish the one it comes back with - but the cookie
	// cannot grow without bound on an instance anyone can hit.
	test("remembers a few open transactions and forgets the oldest", async () => {
		const box = instance();
		let cookies: Record<string, string> = {};
		const states: string[] = [];
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const res = await box.authorize({ cookies });
			cookies = carried(res);
			states.push(...transactions(res).map((entry) => entry.state));
		}
		const res = await box.authorize({ cookies });

		expect(transactions(res)).toHaveLength(4);
		// The first one started is the one dropped.
		expect(transactions(res).map((entry) => entry.state)).not.toContain(
			states[0]
		);
	});

	test("is not offered by a self-hosted instance", async () => {
		const box = instance({ cloud: undefined });

		expect((await box.authorize()).statusCode).toBe(404);
		expect((await box.callback()).statusCode).toBe(404);
	});

	// With sign-in off there is nothing to sign in to and a password would gate
	// nothing, so both capabilities stop rather than reporting a success that
	// protects nobody. Landing on the workbench is what the operator already has.
	test("stops when sign-in is disabled", async () => {
		const box = instance({ auth: "none" });

		for (const res of [
			await box.authorize(),
			await box.callback(),
			await box.errorPage()
		]) {
			expect(res.relative).toEqual({ to: "", override: {} });
			expect(res.cookies).toEqual([]);
			expect(res.statusCode).toBe(200);
			expect(res.redirected).toBe("");
		}
	});
});

describe("finishing a cloud authorization", () => {
	test("mints a session for the transaction the browser started", async () => {
		const box = instance();
		const { open: transaction, cookies } = await box.start({
			query: { type: "session", to: "/workspace/project" }
		});
		const res = await box.callback({
			cookies,
			query: { code: CODE, state: transaction.state }
		});

		// The same local capability password sign-in issues, on the same scope.
		expect(res.sessionOptions).toEqual(COOKIE_OPTIONS);
		expect(res.redirected).toBe("/workspace/project");
		expect(res.headers["Cache-Control"]).toBe("no-store");
		// Signing in must not also hand out the capability to set a password.
		expect(written(res, SETUP_COOKIE)).toBeUndefined();
	});

	test("sends the verifier it kept with the code that came back", async () => {
		const box = instance();
		const { open: transaction, cookies } = await box.start({
			query: { type: "session" }
		});
		await box.callback({
			cookies,
			query: { code: CODE, state: transaction.state }
		});

		expect(box.exchanges).toEqual([
			{
				url: `${CLOUD.origin}/api/cloud/auth/exchange`,
				body: {
					boxId: CLOUD.boxId,
					code: CODE,
					codeVerifier: transaction.verifier,
					// Must match the one /authorize sent, or the website refuses it.
					redirectUri: CALLBACK,
					type: "session"
				}
			}
		]);
	});

	// The transaction is what proves this browser started this authorization, so
	// it is spent on first use. Otherwise a callback URL in history, or in a
	// referrer, stays redeemable for as long as the cookie lives.
	test("spends a transaction once", async () => {
		const box = instance();
		const { open: transaction, cookies } = await box.start({
			query: { type: "session" }
		});
		const query = { code: CODE, state: transaction.state };

		const first = await box.callback({ cookies, query });
		const again = await box.callback({ cookies: carried(first), query });

		expect(first.sessionOptions).toEqual(COOKIE_OPTIONS);
		expect(again.sessionOptions).toBeUndefined();
		expect(again.relative?.to).toBe("_composery/cloud/error");
		expect(box.exchanges).toHaveLength(1);
	});

	test("refuses a state it never issued", async () => {
		const box = instance();
		const { cookies } = await box.start({ query: { type: "session" } });
		const res = await box.callback({
			cookies,
			query: { code: CODE, state: token("someone else's state") }
		});

		expect(res.sessionOptions).toBeUndefined();
		expect(res.relative?.to).toBe("_composery/cloud/error");
		// Nothing is even asked of the website: no transaction, no exchange.
		expect(box.exchanges).toEqual([]);
	});

	test("refuses a code that is not shaped like one", async () => {
		const box = instance();
		const { open: transaction, cookies } = await box.start({
			query: { type: "session" }
		});
		const res = await box.callback({
			cookies,
			query: { code: "../../etc/passwd", state: transaction.state }
		});

		expect(res.sessionOptions).toBeUndefined();
		expect(res.relative?.to).toBe("_composery/cloud/error");
		expect(box.exchanges).toEqual([]);
	});

	// The two capabilities are not interchangeable: one signs you in, the other
	// lets you overwrite the password. A response that answers with the kind
	// nobody asked for is a confused website or a crossed wire, and either way
	// the answer is no.
	test("will not let one kind of grant stand in for the other", async () => {
		for (const [started, returned] of [
			["session", "password"],
			["password", "session"]
		]) {
			const box = instance({
				respond: () => ({ ok: true, body: { grant: GRANT, type: returned } })
			});
			const { open: transaction, cookies } = await box.start({
				query: { type: started }
			});
			const res = await box.callback({
				cookies,
				query: { code: CODE, state: transaction.state }
			});

			expect(res.sessionOptions, `${started} started`).toBeUndefined();
			expect(written(res, SETUP_COOKIE), `${started} started`).toBeUndefined();
			expect(res.relative?.to).toBe("_composery/cloud/error");
		}
	});

	// Proving ownership through the website earns the right to set a password,
	// not access. Registering it is what signs the owner in.
	test("hands a password grant to the register page without signing anyone in", async () => {
		const box = instance();
		const { open: transaction, cookies } = await box.start();
		const res = await box.callback({
			cookies,
			query: { code: CODE, state: transaction.state }
		});

		expect(written(res, SETUP_COOKIE)).toEqual({
			name: SETUP_COOKIE,
			value: GRANT,
			options: { ...COOKIE_OPTIONS, maxAge: TEN_MINUTES }
		});
		expect(res.relative?.to).toBe("register");
		expect(res.sessionOptions).toBeUndefined();
	});

	test("refuses a grant that is not a token", async () => {
		for (const grant of [undefined, 42, { grant: GRANT }]) {
			const box = instance({
				respond: () => ({ ok: true, body: { grant, type: "password" } })
			});
			const { open: transaction, cookies } = await box.start();
			const res = await box.callback({
				cookies,
				query: { code: CODE, state: transaction.state }
			});

			expect(written(res, SETUP_COOKIE)).toBeUndefined();
			expect(res.relative?.to).toBe("_composery/cloud/error");
		}
	});

	test("treats a refused exchange as a failed authorization", async () => {
		const box = instance({ respond: () => ({ ok: false, body: {} }) });
		const { open: transaction, cookies } = await box.start({
			query: { type: "session" }
		});
		const res = await box.callback({
			cookies,
			query: { code: CODE, state: transaction.state }
		});

		expect(res.sessionOptions).toBeUndefined();
		expect(written(res, SETUP_COOKIE)).toBeUndefined();
		expect(res.relative?.to).toBe("_composery/cloud/error");
	});

	// Nothing signs this cookie, so a page that can write cookies for this host
	// can choose where a successful sign-in lands. The return path is re-checked
	// when it is read, not only when it is written.
	test("never returns the browser anywhere but this Composery", async () => {
		const box = instance();
		for (const to of [
			"https://evil.example",
			"//evil.example",
			"/workspace?next=/x",
			"/workspace#x",
			"/workspace\\..\\x"
		]) {
			const state = token(`state ${to}`);
			const res = await box.callback({
				cookies: {
					[TRANSACTION_COOKIE]: encode([
						{ state, to, type: "session", verifier: token(`verifier ${to}`) }
					])
				},
				query: { code: CODE, state }
			});

			expect(res.redirected, to).toBe("/");
		}
		// ...and the same answer when it arrives as a query parameter.
		const res = await box.authorize({
			query: { type: "session", to: "https://evil.example" }
		});
		expect(open(res).to).toBe("/");
	});

	test("ignores a transaction cookie it did not write", async () => {
		const box = instance();
		const state = token("state");
		const complete = {
			state,
			to: "/",
			type: "session",
			verifier: token("verifier")
		};
		for (const value of [
			"not base64url at all !!",
			encode({ state }),
			encode([null, 42, "text"]),
			encode([{ ...complete, state: "short" }]),
			encode([{ ...complete, verifier: "short" }]),
			encode([{ ...complete, type: "admin" }]),
			// Larger than the cookie is ever written, so it is dropped before it is
			// parsed rather than after.
			encode(Array.from({ length: 200 }, () => complete))
		]) {
			const res = await box.callback({
				cookies: { [TRANSACTION_COOKIE]: value },
				query: { code: CODE, state }
			});

			expect(res.sessionOptions, value.slice(0, 40)).toBeUndefined();
			expect(res.relative?.to).toBe("_composery/cloud/error");
		}
		expect(box.exchanges).toEqual([]);
	});
});

describe("the cloud error page", () => {
	// Where every failure above lands. Rendered from the real fragments, because
	// a missing one is an unhandled rejection and a blank 500 at the exact moment
	// an owner is locked out.
	test("explains the failure and offers the flow again", async () => {
		const res = await instance().errorPage();

		expect(res.statusCode).toBe(503);
		expect(res.headers["Cache-Control"]).toBe("no-store");
		expect(res.headers["Referrer-Policy"]).toBe("no-referrer");
		expect(res.body).toContain("Cloud authorization could not finish.");
		expect(res.body).toContain("Try again");
		expect(res.body).toContain("{{BASE}}/_composery/cloud/authorize");
	});
});

describe("the setup grant", () => {
	const withGrant = (grant: string) => ({ cookies: { [SETUP_COOKIE]: grant } });

	test("is a grant only if it looks like one", () => {
		const box = instance();

		expect(box.hasCloudSetupGrant(box.request(withGrant(GRANT)))).toBe(true);
		expect(box.hasCloudSetupGrant(box.request(withGrant("short")))).toBe(false);
		expect(box.hasCloudSetupGrant(box.request())).toBe(false);
	});

	test("is cleared on the scope it was written to", () => {
		const box = instance();
		const res = response();
		box.clearCloudSetupGrant(box.request(withGrant(GRANT)), res);

		expect(res.cleared).toEqual([SETUP_COOKIE]);
	});

	test("sends the grant with the hash it is installing", async () => {
		const box = instance();
		await box.installCloudPassword(
			box.request(withGrant(GRANT)),
			"$argon2id$new"
		);

		expect(box.exchanges).toEqual([
			{
				url: `${CLOUD.origin}/api/cloud/auth/password`,
				body: {
					boxId: CLOUD.boxId,
					grant: GRANT,
					runtimeAuthHash: "$argon2id$new"
				}
			}
		]);
	});

	// Without this the register route's grant bypass - the one branch allowed to
	// overwrite an existing password - would be reachable by anyone who could
	// reach the route.
	test("will not install a password without one", async () => {
		const box = instance();

		await expect(
			box.installCloudPassword(box.request(), "$argon2id$new")
		).rejects.toThrow(/Missing cloud setup grant/);
		await expect(
			box.installCloudPassword(box.request(withGrant("short")), "$argon2id$new")
		).rejects.toThrow(/Missing cloud setup grant/);
		expect(box.exchanges).toEqual([]);
	});

	// Changing a password you can already produce needs no website account: the
	// hash being replaced is the proof, and no grant is involved.
	test("is not what records a password an owner changed for themselves", async () => {
		const box = instance();
		await box.changeCloudPassword("$argon2id$old", "$argon2id$new");

		expect(box.exchanges).toEqual([
			{
				url: `${CLOUD.origin}/api/cloud/auth/password`,
				body: {
					boxId: CLOUD.boxId,
					currentRuntimeAuthHash: "$argon2id$old",
					runtimeAuthHash: "$argon2id$new"
				}
			}
		]);
	});

	// Both callers write the password locally only if this resolves. A refusal
	// that resolved anyway would leave a password the next bootstrap reverts.
	test("treats a refused write as a failure", async () => {
		const box = instance({ respond: () => ({ ok: false, body: {} }) });

		await expect(
			box.installCloudPassword(box.request(withGrant(GRANT)), "$argon2id$new")
		).rejects.toThrow(/Cloud password setup failed/);
		await expect(
			box.changeCloudPassword("$argon2id$old", "$argon2id$new")
		).rejects.toThrow(/Cloud password change failed/);
	});

	test("has nowhere to go on a self-hosted instance", async () => {
		const box = instance({ cloud: undefined });

		await expect(
			box.installCloudPassword(box.request(withGrant(GRANT)), "$argon2id$new")
		).rejects.toThrow(/not configured/);
		await expect(
			box.changeCloudPassword("$argon2id$old", "$argon2id$new")
		).rejects.toThrow(/not configured/);
		expect(box.exchanges).toEqual([]);
	});
});
