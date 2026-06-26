import { afterEach, describe, expect, test, vi } from "vitest";

import { loadOverlayModule } from "../../../../support/overlay.ts";

// The server-side k-anonymity relay behind the breach check on the auth pages.
//
// Two properties matter and neither is visible from reading the route: the
// browser must never be able to send more than a 5-hex prefix of its SHA-1, and
// a check that cannot be performed must let the user through rather than lock
// them out. A breach warning is advisory; a login that refuses because a
// third-party API is down is an outage.

type Handler = (req: Req, res: Res) => Promise<unknown>;
type Req = { params: { prefix: string } };
type Res = {
	status: (code: number) => Res;
	end: () => Res;
	send: (body: string) => Res;
	setHeader: (name: string, value: string) => void;
};

function load(tokens = 120) {
	let handler: Handler | undefined;
	loadOverlayModule({
		source: new URL(
			"../../../../../overlay/src/node/routes/pwned.ts",
			import.meta.url
		),
		dependencies: {
			express: {
				Router: () => ({
					get: (_path: string, fn: Handler) => {
						handler = fn;
					}
				})
			},
			limiter: {
				RateLimiter: class {
					private remaining = tokens;
					tryRemoveTokens(count: number) {
						if (this.remaining < count) return false;
						this.remaining -= count;
						return true;
					}
				}
			}
		},
		globals: { fetch: globalThis.fetch, AbortSignal }
	});
	if (!handler) throw new Error("pwned route registered no handler");
	return handler;
}

function response() {
	const headers: Record<string, string> = {};
	const state = { body: undefined as string | undefined, status: 200, headers };
	const res: Res = {
		status: (code) => {
			state.status = code;
			return res;
		},
		end: () => res,
		send: (body) => {
			state.body = body;
			return res;
		},
		setHeader: (name, value) => {
			headers[name] = value;
		}
	};
	return { res, state };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

// Only the two things the route reads off a response are modelled; a full
// `fetch` type here would make every stub a cast.
function stubFetch(impl: (...args: never[]) => Promise<unknown>) {
	vi.stubGlobal("fetch", impl);
}

async function call(prefix: string, tokens?: number) {
	const handler = load(tokens);
	const { res, state } = response();
	await handler({ params: { prefix } }, res);
	return state;
}

describe("what the relay accepts", () => {
	// The whole point of k-anonymity: the server may only ever be asked for a
	// bucket, never for a password's full hash. Anything longer is refused before
	// it can be forwarded.
	test("refuses anything that is not exactly a five-hex prefix", async () => {
		stubFetch(() => Promise.reject(new Error("must not be called")));

		for (const prefix of ["ABCD", "ABCDEF", "ZZZZZ", "", "ABCD!"]) {
			expect((await call(prefix)).status).toBe(400);
		}
	});

	test("accepts a lower-case prefix by upper-casing it", async () => {
		const seen: string[] = [];
		stubFetch((url: string) => {
			seen.push(url);
			return Promise.resolve({
				ok: true,
				text: () => Promise.resolve("SUFFIX:1")
			});
		});

		expect((await call("abc12")).status).toBe(200);
		expect(seen[0]).toContain("/range/ABC12");
	});

	test("refuses once its own budget is spent", async () => {
		stubFetch(() =>
			Promise.resolve({ ok: true, text: () => Promise.resolve("") })
		);

		expect((await call("ABC12", 0)).status).toBe(429);
	});
});

describe("what it asks the breach API", () => {
	test("requests padding so the bucket size reveals nothing", async () => {
		let init: RequestInit | undefined;
		stubFetch((_url: string, options: RequestInit) => {
			init = options;
			return Promise.resolve({ ok: true, text: () => Promise.resolve("") });
		});

		await call("ABC12");

		expect(
			(init?.headers as Record<string, string> | undefined)?.["Add-Padding"]
		).toBe("true");
		// Bounded, so a hanging upstream cannot hold the request open.
		expect(init?.signal).toBeDefined();
	});
});

describe("what it returns", () => {
	test("relays the suffix list, uncached and without a referrer", async () => {
		stubFetch(() =>
			Promise.resolve({
				ok: true,
				text: () => Promise.resolve("0018A45C4D1DEF81644B54AB7F969B88D65:1")
			})
		);

		const state = await call("ABC12");

		expect(state.body).toBe("0018A45C4D1DEF81644B54AB7F969B88D65:1");
		expect(state.headers["Cache-Control"]).toBe("no-store");
		expect(state.headers["Referrer-Policy"]).toBe("no-referrer");
		expect(state.headers["Content-Type"]).toContain("text/plain");
	});

	// Fail open, deliberately. The client treats 502 as "could not check" and
	// lets the password through; treating an unreachable third party as a
	// rejection would turn their outage into ours.
	test("answers 502 when the breach API refuses or cannot be reached", async () => {
		stubFetch(() =>
			Promise.resolve({ ok: false, text: () => Promise.resolve("") })
		);
		expect((await call("ABC12")).status).toBe(502);

		stubFetch(() => Promise.reject(new Error("network down")));
		expect((await call("ABC12")).status).toBe(502);
	});
});
