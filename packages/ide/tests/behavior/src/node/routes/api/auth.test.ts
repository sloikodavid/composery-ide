import { describe, expect, test } from "vitest";

import { loadOverlayModule } from "../../../../../support/overlay.ts";

// Who is allowed to drive the box's HTTP API. Three answers have to stay
// distinct, because each sends whoever asked somewhere different: 401 is "that
// key is not one of ours", 429 is "stop asking", and 503 is "we cannot tell
// right now" - an owner who gets 401 for an unreadable key store reissues a key
// that was never the problem.
//
// The order of the two limiters is the part with no other guard on it. Caddy is
// what reaches this listener, so every client shares one source address here,
// and a budget spent before the key is checked would let one anonymous flood
// lock out the owner's own valid key. `verifyKey` and the limiters are the seams
// this drives, because what is under test is the sequence, not their arithmetic
// - both have tests of their own next door.

type Result = { id?: string; status?: number; message?: string };

type Request = {
	headers: Record<string, string | string[] | undefined>;
	ip?: string;
	socket: { remoteAddress?: string };
};

type Api = {
	authenticate: (req: Request) => Promise<Result>;
	httpAuth: () => (
		req: Request,
		res: unknown,
		next: () => void
	) => Promise<void>;
};

type Options = {
	/** Key ids by secret. A secret absent from this map is not one of ours. */
	keys?: Record<string, string>;
	/** Set to have the key store fail to answer rather than answer no. */
	unreadable?: boolean;
	failBudget?: number;
	perKeyBudget?: number;
};

function api(options: Options = {}) {
	const {
		keys = { "secret-one": "key_one" },
		unreadable = false,
		failBudget = 3,
		perKeyBudget = 2
	} = options;

	const calls: string[] = [];
	let failsLeft = failBudget;
	const perKeyLeft = new Map<string, number>();

	const module = loadOverlayModule<Api>({
		source: new URL(
			"../../../../../../overlay/src/node/routes/api/auth.ts",
			import.meta.url
		),
		dependencies: {
			// Imported for its types only, but the emit still requires it.
			express: {},
			"./keystore": {
				verifyKey: (secret: string) => {
					calls.push(`verify:${secret}`);
					if (unreadable) return Promise.reject(new Error("unreadable"));
					return Promise.resolve(keys[secret]);
				}
			},
			"./ratelimit": {
				authFail: {
					allow: (ip: string) => {
						calls.push(`authFail.allow:${ip}`);
						return failsLeft > 0;
					},
					record: (ip: string) => {
						calls.push(`authFail.record:${ip}`);
						failsLeft -= 1;
					}
				},
				rateLimit: {
					allow: (id: string) => {
						calls.push(`rateLimit.allow:${id}`);
						const left = perKeyLeft.get(id) ?? perKeyBudget;
						if (left <= 0) return false;
						perKeyLeft.set(id, left - 1);
						return true;
					}
				}
			}
		}
	}).exports;

	return { ...module, calls };
}

const request = (
	headers: Request["headers"] = {},
	address = "127.0.0.1"
): Request => ({ headers, socket: { remoteAddress: address } });

const bearer = (secret: string) =>
	request({ authorization: `Bearer ${secret}` });

describe("presenting a key", () => {
	test("takes one from either header the API documents", async () => {
		expect((await api().authenticate(bearer("secret-one"))).id).toBe("key_one");
		expect(
			(await api().authenticate(request({ "x-api-key": "secret-one" }))).id
		).toBe("key_one");
	});

	// A key pasted out of a terminal or a config file arrives padded, and both
	// headers forgive that rather than answering 401 for a key that is right.
	test("ignores padding around it", async () => {
		expect(
			(
				await api().authenticate(
					request({ authorization: "Bearer  secret-one " })
				)
			).id
		).toBe("key_one");
		expect(
			(await api().authenticate(request({ "x-api-key": " secret-one " }))).id
		).toBe("key_one");
	});

	test("refuses a request carrying no key, without consulting the store", async () => {
		const box = api();
		const result = await box.authenticate(request());

		expect(result).toMatchObject({ status: 401 });
		expect(box.calls).not.toContain("verify:undefined");
	});

	test("refuses an authorization scheme that is not Bearer", async () => {
		const result = await api().authenticate(
			request({ authorization: "Basic secret-one" })
		);

		expect(result).toMatchObject({ status: 401 });
	});
});

describe("the two budgets, and the order they are spent in", () => {
	// The documented subtlety, and the reason the gate sits after the store
	// lookup rather than before it. Behind a reverse proxy every caller shares
	// one address, so an anonymous flood exhausts the shared budget - and the
	// owner's own valid key still has to work.
	test("a valid key still works after a flood has spent the shared budget", async () => {
		const box = api({ failBudget: 2 });
		for (let attempt = 0; attempt < 4; attempt += 1) {
			await box.authenticate(bearer("wrong"));
		}

		expect((await box.authenticate(bearer("secret-one"))).id).toBe("key_one");
	});

	test("a bad key spends the shared budget and is then told to stop", async () => {
		const box = api({ failBudget: 2 });

		expect(await box.authenticate(bearer("wrong"))).toMatchObject({
			status: 401
		});
		expect(await box.authenticate(bearer("wrong"))).toMatchObject({
			status: 401
		});
		expect(await box.authenticate(bearer("wrong"))).toMatchObject({
			status: 429
		});
	});

	test("counts a flood against the address that reached this listener", async () => {
		const box = api();
		await box.authenticate(
			request({ authorization: "Bearer wrong" }, "10.0.0.9")
		);

		expect(box.calls).toContain("authFail.allow:10.0.0.9");
		// Express only fills `req.ip` when it is configured to trust a proxy, and
		// this app is not - so the socket is what identifies a caller, and a
		// request with neither is still counted rather than keyed on nothing.
		const anonymous = api();
		await anonymous.authenticate({
			headers: { authorization: "Bearer wrong" },
			socket: {}
		});
		expect(anonymous.calls).toContain("authFail.allow:unknown");
	});

	test("spends nothing on a request that turns out to hold a real key", async () => {
		const box = api();
		await box.authenticate(bearer("secret-one"));

		expect(box.calls.filter((call) => call.startsWith("authFail"))).toEqual([]);
	});

	// The per-key budget is the one an authenticated caller can exhaust, and it
	// is theirs alone: spending it must not touch anyone else's.
	test("throttles a key that asks too often, and only that key", async () => {
		const box = api({
			keys: { "secret-one": "key_one", "secret-two": "key_two" },
			perKeyBudget: 1
		});

		expect((await box.authenticate(bearer("secret-one"))).id).toBe("key_one");
		expect(await box.authenticate(bearer("secret-one"))).toMatchObject({
			status: 429
		});
		expect((await box.authenticate(bearer("secret-two"))).id).toBe("key_two");
	});
});

describe("a key store that cannot answer", () => {
	test("says so instead of calling the key invalid", async () => {
		const box = api({ unreadable: true });
		const result = await box.authenticate(bearer("secret-one"));

		expect(result).toMatchObject({ status: 503 });
		expect(result.id).toBeUndefined();
		// ...and it is not counted as a failed guess: nobody guessed anything.
		expect(box.calls.filter((call) => call.startsWith("authFail"))).toEqual([]);
	});
});

describe("the middleware around it", () => {
	function response() {
		const sent: { status: number; body: unknown }[] = [];
		return {
			sent,
			status(code: number) {
				return {
					json: (body: unknown) => sent.push({ status: code, body })
				};
			}
		};
	}

	test("hands the route the key that authenticated, and continues", async () => {
		const box = api();
		const req = bearer("secret-one");
		const res = response();
		let continued = 0;

		await box.httpAuth()(req, res, () => {
			continued += 1;
		});

		expect(continued).toBe(1);
		expect(res.sent).toEqual([]);
		expect((req as { apiKeyId?: string }).apiKeyId).toBe("key_one");
	});

	test("answers a refused request itself rather than continuing", async () => {
		const box = api();
		const res = response();
		let continued = 0;

		await box.httpAuth()(bearer("wrong"), res, () => {
			continued += 1;
		});

		expect(continued).toBe(0);
		expect(res.sent).toEqual([
			{ status: 401, body: { message: "Invalid or missing API key" } }
		]);
	});
});
