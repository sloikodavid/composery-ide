import { describe, expect, test } from "vitest";

import { loadOverlayModule } from "../../../../support/overlay.ts";

// Rotating the password of an instance you can already open. Holding the
// current password is the whole credential - no session, no website account -
// so this route is a password oracle, and everything here is about what that
// costs an attacker and what order the write happens in.
//
// Two orderings carry the risk. A guess has to be paid for out of login's own
// budget, or this becomes the way around login's rate limit; and on a cloud
// instance the website has to accept the change before it is written locally,
// or the box ends up holding a password the next bootstrap silently reverts.

type Query = Record<string, unknown>;

type Args = {
	"hashed-password"?: string;
	password?: string;
};

type Request = {
	args: Args;
	body?: Record<string, unknown>;
	cookieSessionName: string;
	headers: Record<string, string | string[] | undefined>;
	query: Query;
	socket: { remoteAddress?: string };
};

type Response = {
	body: string;
	headers: Record<string, string>;
	json: (value: unknown) => void;
	payload: unknown;
	redirected: { to: string; override: Query } | undefined;
	send: (body: string) => void;
	sessionOptions: unknown;
	setHeader: (name: string, value: string) => void;
	status: (code: number) => Response;
	statusCode: number;
};

type Handler = (req: Request, res: Response, next: () => void) => unknown;

type Options = {
	cloud?: boolean;
	/** Rejects, as the website does when it does not hold the current hash. */
	cloudRefuses?: boolean;
	envManaged?: boolean;
	password?: string | undefined;
	tokens?: number;
};

function response(): Response {
	const res: Response = {
		body: "",
		headers: {},
		payload: undefined,
		redirected: undefined,
		sessionOptions: undefined,
		statusCode: 200,
		json: (value) => {
			res.payload = value;
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
		cloud = false,
		cloudRefuses = false,
		envManaged = false,
		tokens = 5
	} = options;

	const calls: string[] = [];
	let budget = tokens;
	// A destructuring default would fire on an explicit `undefined`, which is
	// how a test says "this instance has no password yet".
	let stored = Object.hasOwn(options, "password")
		? options.password
		: "current";

	const guards: Handler[] = [];
	const routes = new Map<string, Handler>();
	// What each route was registered behind. The harness calls handlers
	// directly, so a POST that lost `ensureOrigin` would pass everything below;
	// the chain itself is what says it is still there.
	const chains = new Map<string, unknown[]>();
	const ensureOrigin = () => undefined;
	const module = loadOverlayModule<Record<string, unknown>>({
		source: new URL(
			"../../../../../overlay/src/node/routes/changePassword.ts",
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
			"./authPage": { renderAuthPage: () => Promise.resolve("<page/>") },
			"./cloudAuth": {
				changeCloudPassword: (current: string, next: string) => {
					calls.push(`cloud:${current}->${next}`);
					return cloudRefuses
						? Promise.reject(new Error("refused"))
						: Promise.resolve();
				}
			},
			"./loginRateLimit": {
				loginRateLimit: {
					canTry: () => budget > 0,
					recordFailure: () => {
						calls.push("spend");
						budget -= 1;
					}
				},
				loginSource: () => "10.0.0.1"
			},
			"./passwordConfig": {
				hasPassword: () => stored !== undefined,
				isEnvPasswordManaged: () => envManaged,
				isPasswordValid: (_args: Args, value: string) =>
					Promise.resolve(value === stored),
				writeHashedPassword: (_args: Args, hashed: string) => {
					calls.push(`write:${hashed}`);
					stored = hashed;
					return Promise.resolve(true);
				}
			}
		},
		globals: { console }
	}).exports;

	function request(body: Record<string, unknown> = {}): Request {
		return {
			args: { "hashed-password": "$argon2id$current" },
			body,
			cookieSessionName: "composery-session",
			headers: {},
			query: {},
			socket: { remoteAddress: "10.0.0.1" }
		};
	}

	async function visit(route: string, body: Record<string, unknown> = {}) {
		const req = request(body);
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
		module,
		calls,
		ensureOrigin,
		chainOf: (route: string) => chains.get(route) ?? [],
		page: () => visit("GET /"),
		verify: (body: Record<string, unknown>) => visit("POST /verify", body),
		submit: (body: Record<string, unknown>) => visit("POST /", body),
		budgetLeft: () => budget,
		storedPassword: () => stored
	};
}

const change = {
	currentPassword: "current",
	newPassword: "next",
	confirmPassword: "next"
};

// Both POSTs answer "is this the password?", so both are worth forging from
// another origin - the submit to change it, and the live check as an oracle.
describe("the cross-origin guard", () => {
	test("stands in front of every route that takes a password", () => {
		const box = instance();

		expect(box.chainOf("POST /")).toEqual([box.ensureOrigin]);
		expect(box.chainOf("POST /verify")).toEqual([box.ensureOrigin]);
	});
});

describe("who may change a password here", () => {
	test("nobody, when the environment owns it", async () => {
		const box = instance({ envManaged: true });
		const res = await box.page();

		expect(res.statusCode).toBe(404);
		// Not merely hidden - the submit is unreachable too, or the page being
		// gone would be cosmetic.
		expect((await box.submit(change)).statusCode).toBe(404);
		expect(box.calls).toEqual([]);
	});

	test("an instance with no password yet is sent to claim it instead", async () => {
		const box = instance({ password: undefined });

		expect((await box.page()).redirected?.to).toBe("register");
	});

	// Deliberately no session check: proving the current password is a stronger
	// credential than the cookie this would otherwise demand, and requiring one
	// would lock out the case the page exists for.
	test("anyone holding the current password, with no session", async () => {
		const box = instance();
		const res = await box.submit(change);

		expect(res.redirected).toEqual({ to: "", override: { error: undefined } });
		expect(box.storedPassword()).toBe("$argon2id$next");
	});
});

describe("what a guess costs", () => {
	test("a wrong current password spends a token and says so", async () => {
		const box = instance();
		const res = await box.submit({ ...change, currentPassword: "wrong" });

		expect(res.redirected?.override).toEqual({ error: "incorrect-current" });
		expect(box.calls).toEqual(["spend"]);
		expect(box.storedPassword()).toBe("current");
	});

	test("a right one costs nothing", async () => {
		const box = instance();
		await box.submit(change);

		expect(box.calls).not.toContain("spend");
		expect(box.budgetLeft()).toBe(5);
	});

	// The budget is login's own, so guessing here cannot be a way around the
	// limit that protects the sign-in page.
	test("an exhausted budget refuses before the password is even checked", async () => {
		const box = instance({ tokens: 0 });
		const res = await box.submit(change);

		expect(res.redirected?.override).toEqual({ error: "rate-limit" });
		expect(box.calls).toEqual([]);
		expect(box.storedPassword()).toBe("current");
	});

	// The step the page calls as the user leaves the field. It answers the same
	// question as a login attempt, so it spends from the same budget.
	test("the live check is the same oracle and spends the same budget", async () => {
		const box = instance();

		expect((await box.verify({ currentPassword: "current" })).payload).toEqual({
			valid: true
		});
		expect(box.calls).toEqual([]);

		expect((await box.verify({ currentPassword: "wrong" })).payload).toEqual({
			valid: false,
			reason: "incorrect"
		});
		expect(box.calls).toEqual(["spend"]);
	});

	test("the live check refuses out of budget without checking", async () => {
		const box = instance({ tokens: 0 });
		const res = await box.verify({ currentPassword: "current" });

		expect(res.payload).toEqual({ valid: false, reason: "rate-limit" });
		expect(res.headers["Cache-Control"]).toBe("no-store");
	});

	// A bare status would be indistinguishable from the 401 or 404 that
	// unrelated middleware answers with, so only this body counts as "wrong".
	test("the live check reports a missing password as a result, not a status", async () => {
		const res = await instance().verify({ currentPassword: "  " });

		expect(res.payload).toEqual({ valid: false, reason: "missing" });
		expect(res.statusCode).toBe(200);
	});
});

describe("what has to agree before the password moves", () => {
	test("a new password is required, and has to be typed twice the same", async () => {
		const box = instance();

		expect(
			(await box.submit({ ...change, newPassword: "" })).redirected?.override
		).toEqual({ error: "missing-new" });
		expect(
			(await box.submit({ ...change, confirmPassword: "other" })).redirected
				?.override
		).toEqual({ error: "mismatch" });
		expect(box.storedPassword()).toBe("current");
	});

	test("a missing current password is refused without spending a token", async () => {
		const box = instance();
		const res = await box.submit({ ...change, currentPassword: "" });

		expect(res.redirected?.override).toEqual({ error: "missing-current" });
		expect(box.calls).toEqual([]);
	});
});

// The website is the source of truth across rebuilds: it renders
// COMPOSERY_HASHED_PASSWORD into the env file from the hash it holds. A local
// write it never heard about survives until the next bootstrap and then
// silently reverts, so the order is not an implementation detail.
describe("a cloud instance", () => {
	test("tells the website before it writes anything locally", async () => {
		const box = instance({ cloud: true });

		await box.submit(change);

		expect(box.calls).toEqual([
			"cloud:$argon2id$current->$argon2id$next",
			"write:$argon2id$next"
		]);
	});

	test("keeps the old password when the website refuses", async () => {
		const box = instance({ cloud: true, cloudRefuses: true });
		const res = await box.submit(change);

		expect(res.redirected?.override).toEqual({ error: "unavailable" });
		expect(box.calls).toEqual(["cloud:$argon2id$current->$argon2id$next"]);
		expect(box.storedPassword()).toBe("current");
		expect(res.sessionOptions).toBeUndefined();
	});

	test("a self-hosted instance has nobody to tell", async () => {
		const box = instance({ cloud: false });
		await box.submit(change);

		expect(box.calls).toEqual(["write:$argon2id$next"]);
	});
});

describe("after the change", () => {
	test("issues the session the new password is worth", async () => {
		const box = instance();
		const res = await box.submit(change);

		// The same cookie options every other entry point uses, so Sign Out can
		// clear what this issued.
		expect(res.sessionOptions).toEqual({ path: "/ide/" });
	});
});
