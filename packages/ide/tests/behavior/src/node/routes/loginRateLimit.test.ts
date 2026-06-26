import { describe, expect, test } from "vitest";

import { loadOverlayModule } from "../../../../support/overlay.ts";

// The two things `loginSource` reads off a request. Spelled out rather than
// imported from express, which is code-server's dependency and not resolvable
// from this package - and the loader hands the module back structurally anyway.
type LoginRequest = {
	headers: Record<string, string | string[] | undefined>;
	socket: { remoteAddress: string | undefined };
};

// A property rather than a method, because the tests destructure it off the
// loaded module and a method type would read as an unbound `this`.
type LoginRateLimit = {
	loginRateLimit: {
		canTry: (source: string) => boolean;
		recordFailure: (source: string) => void;
	};
	loginSource: (req: LoginRequest) => string;
};

type Bucket = { tokensPerInterval: number; interval: string };

// The key a password guess is counted against, and the budget it is counted
// from. Both are security controls, but only one of them is ours: `limiter`
// owns the token arithmetic, and it is not resolvable from here anyway - it is
// a code-server dependency that exists only in the assembled build tree. So it
// is stubbed to the point of letting the module load, and what is asserted is
// the policy this file chooses and the source key it chooses it per.

function load() {
	const buckets: Bucket[] = [];
	const module = loadOverlayModule<LoginRateLimit>({
		source: new URL(
			"../../../../../overlay/src/node/routes/loginRateLimit.ts",
			import.meta.url
		),
		dependencies: {
			limiter: {
				// Counts tokens and never refills. `limiter` owns the refill
				// algorithm and is not resolvable from here anyway; what is under
				// test is which bucket a guess is spent from and how the three
				// combine, which is ours.
				RateLimiter: class {
					private remaining: number;
					constructor(bucket: Bucket) {
						buckets.push(bucket);
						this.remaining = bucket.tokensPerInterval;
					}
					getTokensRemaining() {
						return this.remaining;
					}
					tryRemoveTokens(count: number) {
						if (this.remaining < count) return false;
						this.remaining -= count;
						return true;
					}
				}
			}
		},
		// The module arms a sweep timer on construction. It never fires in a test,
		// but it has to exist and `unref` has to be callable on it.
		globals: { setInterval: () => ({ unref: () => undefined }) }
	});
	return { buckets, ...module.exports };
}

function request(
	headers: LoginRequest["headers"],
	remoteAddress?: string
): LoginRequest {
	return { headers, socket: { remoteAddress } };
}

describe("the guess budget", () => {
	// One instance-wide ceiling, high enough that an ordinary scanner cannot
	// reach it and spend the owner's own budget, and counted per hour so a
	// distributed flood has to sustain itself to keep Argon2 busy. The per-source
	// pair is deliberately far smaller.
	test("holds a high instance-wide ceiling over small per-source ones", () => {
		const { buckets, loginRateLimit } = load();
		loginRateLimit.canTry("10.0.0.1");

		expect(buckets).toContainEqual({
			tokensPerInterval: 10_000,
			interval: "hour"
		});
		expect(buckets).toContainEqual({
			tokensPerInterval: 5,
			interval: "minute"
		});
		expect(buckets).toContainEqual({ tokensPerInterval: 30, interval: "hour" });
	});

	// A guess costs a token in all three buckets, and any one of them running out
	// refuses the next guess. Testing the minute bucket is enough to prove the
	// conjunction: it is the smallest, so it is the one that stops an attacker.
	test("spends from every bucket and refuses once the smallest is empty", () => {
		const { loginRateLimit } = load();

		expect(loginRateLimit.canTry("10.0.0.1")).toBe(true);
		for (let attempt = 0; attempt < 5; attempt += 1) {
			loginRateLimit.recordFailure("10.0.0.1");
		}

		expect(loginRateLimit.canTry("10.0.0.1")).toBe(false);
	});

	// Per source, so one scanner burning its own budget cannot lock the owner out
	// of their own box.
	test("leaves an unrelated source its full budget", () => {
		const { loginRateLimit } = load();

		for (let attempt = 0; attempt < 5; attempt += 1) {
			loginRateLimit.recordFailure("10.0.0.1");
		}

		expect(loginRateLimit.canTry("10.0.0.2")).toBe(true);
	});

	// The map is the one thing here an attacker could grow without bound: a fresh
	// source per request would otherwise allocate two buckets each time. Past the
	// cap every new source shares one bucket, so the memory is bounded and the
	// flood still pays.
	test("collapses new sources into one shared budget past the cap", () => {
		const { loginRateLimit } = load();

		for (let index = 0; index < 10_000; index += 1) {
			loginRateLimit.canTry(`10.1.${Math.floor(index / 256)}.${index % 256}`);
		}
		// Two sources never seen before, both now sharing the overflow bucket.
		for (let attempt = 0; attempt < 5; attempt += 1) {
			loginRateLimit.recordFailure("203.0.113.1");
		}

		expect(loginRateLimit.canTry("203.0.113.2")).toBe(false);
	});
});

// Caddy is the only process able to reach the IDE's loopback listener, and it
// appends the connecting address to X-Forwarded-For. So the *last* value is the
// one Caddy wrote and the only one an internet client cannot choose - taking the
// first would let a guesser rotate a header and hand themselves a fresh budget
// on every attempt.
describe("which source a guess is counted against", () => {
	test("takes the last forwarded address, not the client's own", () => {
		const { loginSource } = load();

		expect(
			loginSource(request({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }))
		).toBe("203.0.113.9");
	});

	test("ignores blank and padded entries around it", () => {
		const { loginSource } = load();

		expect(
			loginSource(request({ "x-forwarded-for": " 1.2.3.4 ,  203.0.113.9 , " }))
		).toBe("203.0.113.9");
	});

	// Node hands a repeated header through as an array.
	test("reads a repeated header rather than ignoring it", () => {
		const { loginSource } = load();

		expect(
			loginSource(request({ "x-forwarded-for": ["1.2.3.4, 203.0.113.9"] }))
		).toBe("203.0.113.9");
	});

	test("falls back to the socket when the header is absent or empty", () => {
		const { loginSource } = load();

		expect(loginSource(request({}, "198.51.100.7"))).toBe("198.51.100.7");
		expect(
			loginSource(request({ "x-forwarded-for": "" }, "198.51.100.7"))
		).toBe("198.51.100.7");
	});

	// Never an empty key: two unidentifiable requests share one bucket rather
	// than each being handed a budget of their own.
	test("names an unidentifiable request rather than keying on nothing", () => {
		const { loginSource } = load();

		expect(loginSource(request({}))).toBe("unknown");
	});
});
