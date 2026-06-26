import { describe, expect, test } from "vitest";

import { loadOverlayModule } from "../../../../support/overlay.ts";

// Claiming an instance that nobody has claimed yet. It is the one auth route
// that has to answer before anyone can sign in, so the guard in front of it is
// the whole of the protection: once a password exists this must stop being a
// way to set one, or reaching an instance first is the same as owning it.
//
// The cloud recovery flow is the single exception, and it is not an exception
// to the rule so much as a different proof - a setup grant means the website
// already established who the owner is. Even then the environment outranks it,
// because a COMPOSERY_PASSWORD an owner sets on their own host wins at the next
// restart, and writing over it would store a password that silently stops
// working.

type Query = Record<string, unknown>;

type Request = {
	args: Record<string, unknown>;
	body?: Record<string, unknown>;
	cookieSessionName: string;
	query: Query;
};

type Response = {
	body: string;
	cleared: string[];
	redirected: { to: string; override: Query } | undefined;
	send: (body: string) => void;
	sessionOptions: unknown;
};

type Handler = (req: Request, res: Response, next: () => void) => unknown;

type Options = {
	cloud?: boolean;
	envManaged?: boolean;
	grant?: boolean;
	/** A password already configured on this instance. */
	existing?: string;
	/** The website refuses to record the password against the grant. */
	installFails?: boolean;
	/** Somebody else claimed the instance between the guard and the write. */
	claimedFirst?: boolean;
};

function response(): Response {
	const res: Response = {
		body: "",
		cleared: [],
		redirected: undefined,
		sessionOptions: undefined,
		send: (body) => {
			res.body = body;
		}
	};
	return res;
}

function instance(options: Options = {}) {
	const {
		cloud = false,
		envManaged = false,
		grant = false,
		installFails = false,
		claimedFirst = false
	} = options;

	const calls: string[] = [];
	let stored = Object.hasOwn(options, "existing")
		? options.existing
		: undefined;

	const guards: Handler[] = [];
	const routes = new Map<string, Handler>();
	// What each route was registered behind. A POST that lost `ensureOrigin`
	// would still pass every test below, because the harness calls the handler
	// directly - so the chain itself is what gets asserted.
	const chains = new Map<string, unknown[]>();
	const ensureOrigin = () => undefined;
	loadOverlayModule<Record<string, unknown>>({
		source: new URL(
			"../../../../../overlay/src/node/routes/register.ts",
			import.meta.url
		),
		dependencies: {
			express: {
				Router: () => ({
					use: (handler: Handler) => guards.push(handler),
					get: (path: string, ...rest: Handler[]) => {
						const handler = rest[rest.length - 1];
						chains.set(`GET ${path}`, rest.slice(0, -1));
						if (handler) routes.set(`GET ${path}`, handler);
					},
					post: (path: string, ...rest: Handler[]) => {
						const handler = rest[rest.length - 1];
						chains.set(`POST ${path}`, rest.slice(0, -1));
						if (handler) routes.set(`POST ${path}`, handler);
					}
				})
			},
			"../cloud": { cloudConfig: cloud ? { boxId: "j57box" } : undefined },
			"../http": {
				ensureOrigin,
				getCookieOptions: () => ({ path: "/ide/" }),
				redirect: (
					_req: unknown,
					res: Response,
					to: string,
					override: Query = {}
				) => {
					res.redirected = { to, override };
				}
			},
			"../session": {
				setSessionCookie: (_req: unknown, res: Response, cookie: unknown) => {
					res.sessionOptions = cookie;
				}
			},
			"../util": {
				hash: (value: string) => Promise.resolve(`$argon2id$${value}`),
				sanitizeString: (value: unknown) =>
					typeof value === "string" ? value.trim() : ""
			},
			"./authErrors": { authErrorMessage: () => undefined },
			"./authPage": {
				renderAuthPage: (_req: unknown, page: { title: string }) =>
					Promise.resolve(`<page title="${page.title}"/>`),
				// The real one: where the browser is sent afterwards is a security
				// decision, and it is this function that makes it.
				returnPath: (value: unknown): string =>
					typeof value === "string" &&
					value.length <= 512 &&
					value.startsWith("/") &&
					!value.startsWith("//") &&
					!value.includes("\\") &&
					!value.includes("?") &&
					!value.includes("#")
						? value
						: "/"
			},
			"./cloudAuth": {
				hasCloudSetupGrant: () => grant,
				clearCloudSetupGrant: (_req: unknown, res: Response) => {
					res.cleared.push("grant");
				},
				installCloudPassword: (_req: unknown, hashed: string) => {
					calls.push(`install:${hashed}`);
					return installFails
						? Promise.reject(new Error("refused"))
						: Promise.resolve();
				}
			},
			"./passwordConfig": {
				hasPassword: () => stored !== undefined,
				isEnvPasswordManaged: () => envManaged,
				writeHashedPassword: (
					_args: unknown,
					hashed: string,
					writeOptions?: { allowExisting?: boolean }
				) => {
					calls.push(
						`write:${hashed}:allowExisting=${String(!!writeOptions?.allowExisting)}`
					);
					if (
						claimedFirst ||
						(stored !== undefined && !writeOptions?.allowExisting)
					) {
						return Promise.resolve(false);
					}
					stored = hashed;
					return Promise.resolve(true);
				}
			}
		},
		globals: { console }
	});

	async function visit(
		route: string,
		{
			body = {},
			query = {}
		}: { body?: Record<string, unknown>; query?: Query } = {}
	) {
		const req: Request = {
			args: {},
			body,
			cookieSessionName: "composery-session",
			query
		};
		const res = response();
		for (const guard of guards) {
			let advanced = false;
			await guard(req, res, () => {
				advanced = true;
			});
			if (!advanced) return res;
		}
		const handler = routes.get(route);
		if (!handler) throw new Error(`no route at ${route}`);
		await handler(req, res, () => undefined);
		return res;
	}

	return {
		calls,
		ensureOrigin,
		chainOf: (route: string) => chains.get(route) ?? [],
		page: () => visit("GET /"),
		submit: (body: Record<string, unknown>, query: Query = {}) =>
			visit("POST /", { body, query }),
		storedPassword: () => stored
	};
}

const claim = { password: "hunter2", confirmPassword: "hunter2" };

// Without this a page on any other origin can form-POST a claim at an
// unclaimed instance and take it over - worst on a localhost bind, where the
// instance is reachable from every tab the person has open.
describe("the cross-origin guard", () => {
	test("stands in front of the claim", () => {
		const box = instance();

		expect(box.chainOf("POST /")).toEqual([box.ensureOrigin]);
	});
});

describe("an instance nobody has claimed", () => {
	test("can be claimed, signed into, and lands on the workbench", async () => {
		const box = instance();
		const res = await box.submit(claim);

		expect(box.calls).toEqual(["write:$argon2id$hunter2:allowExisting=false"]);
		expect(box.storedPassword()).toBe("$argon2id$hunter2");
		expect(res.sessionOptions).toEqual({ path: "/ide/" });
		expect(res.redirected).toEqual({
			to: "/",
			override: { to: undefined, error: undefined }
		});
	});

	test("offers a page that says what it is for", async () => {
		expect((await instance().page()).body).toContain("Create password");
	});

	test("wants the password twice, and not empty", async () => {
		const box = instance();

		expect((await box.submit({ password: "" })).redirected?.override).toEqual({
			error: "missing"
		});
		expect(
			(await box.submit({ password: "a", confirmPassword: "b" })).redirected
				?.override
		).toEqual({ error: "mismatch" });
		expect(box.calls).toEqual([]);
	});

	// Two browsers racing to claim a fresh instance: the write is what decides,
	// and the loser is told to sign in rather than handed a session.
	test("hands nothing to whoever loses a race to claim it", async () => {
		const box = instance({ claimedFirst: true });
		const res = await box.submit(claim, { to: "/workspace" });

		expect(res.redirected).toEqual({
			to: "login",
			override: { to: "/workspace", error: "configured" }
		});
		expect(res.sessionOptions).toBeUndefined();
	});

	// Where the browser goes next comes from the query, so it is a redirect an
	// attacker would like to choose.
	test("never lands anywhere but this instance", async () => {
		for (const to of [
			"https://evil.example",
			"//evil.example",
			"/a?b",
			"/a#b"
		]) {
			const res = await instance().submit(claim, { to });

			expect(res.redirected?.to, to).toBe("/");
		}
		expect(
			(await instance().submit(claim, { to: "/workspace" })).redirected?.to
		).toBe("/workspace");
	});
});

// The guard. Registration stays reachable - the page has to be able to say the
// instance is taken - but it must stop being a way to set a password.
describe("an instance that already has a password", () => {
	test("sends a self-hosted visitor to sign in instead", async () => {
		const box = instance({ existing: "$argon2id$old" });
		const res = await box.submit(claim);

		expect(res.redirected).toEqual({
			to: "login",
			override: { error: undefined }
		});
		expect(box.calls).toEqual([]);
		expect(box.storedPassword()).toBe("$argon2id$old");
	});

	test("sends a visitor away when the environment owns the password", async () => {
		const box = instance({ envManaged: true });
		const res = await box.submit(claim);

		expect(res.redirected?.to).toBe("login");
		expect(box.calls).toEqual([]);
	});
});

// On a cloud instance the website knows who the owner is, so an unclaimed one
// is not first-come-first-served: the visitor is walked through proving it.
describe("a cloud instance", () => {
	test("sends an unproven visitor to prove ownership, not to sign in", async () => {
		const box = instance({ cloud: true });
		const res = await box.submit(claim);

		expect(res.redirected).toEqual({
			to: "_composery/cloud/authorize",
			override: { error: undefined }
		});
		expect(box.calls).toEqual([]);
	});

	// Recovery: a grant is the website's word that this is the owner, so it may
	// overwrite a password that already exists.
	test("lets a proven owner replace a password they cannot produce", async () => {
		const box = instance({
			cloud: true,
			grant: true,
			existing: "$argon2id$old"
		});
		const res = await box.submit(claim);

		expect(box.calls).toEqual([
			// Recorded with the website first, then written locally.
			"install:$argon2id$hunter2",
			"write:$argon2id$hunter2:allowExisting=true"
		]);
		expect(box.storedPassword()).toBe("$argon2id$hunter2");
		expect(res.sessionOptions).toEqual({ path: "/ide/" });
		// The grant is spent, so the same page cannot be replayed into a second
		// password change.
		expect(res.cleared).toEqual(["grant"]);
	});

	// The environment still wins: it is rendered fresh at every restart, so a
	// password written under it would work until then and no longer.
	test("refuses a proven owner when the environment owns the password", async () => {
		const box = instance({ cloud: true, grant: true, envManaged: true });
		const res = await box.submit(claim);

		expect(res.redirected).toEqual({
			to: "login",
			override: { error: "env-managed" }
		});
		expect(box.calls).toEqual([]);
	});

	// The grant is spent either way, so the owner has to start again - and the
	// page that says so is the cloud error page. /authorize renders nothing, so
	// an error code sent there would be discarded silently.
	test("spends the grant and explains itself when the website refuses", async () => {
		const box = instance({ cloud: true, grant: true, installFails: true });
		const res = await box.submit(claim);

		expect(res.redirected?.to).toBe("_composery/cloud/error");
		expect(res.cleared).toEqual(["grant"]);
		expect(box.calls).toEqual(["install:$argon2id$hunter2"]);
		expect(box.storedPassword()).toBeUndefined();
		expect(res.sessionOptions).toBeUndefined();
	});
});
