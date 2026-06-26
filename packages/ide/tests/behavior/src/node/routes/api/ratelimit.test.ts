import { describe, expect, test } from "vitest";

import { loadOverlayModule } from "../../../../../support/overlay.ts";

// What stops one API key, or one flood of bad ones, from being the whole box's
// problem. Three limiters with three different jobs, and the properties that
// matter are the ones nobody notices when they break: a refill that never
// happens turns a rate limit into a permanent lockout, and a sweep that never
// runs turns a public listener into unbounded memory.
//
// The clock and the sweep timer are injected rather than faked globally, so
// every case here states the time it happens at instead of waiting for one.

type Limiters = {
	rateLimit: { allow: (key: string) => boolean };
	authFail: { allow: (ip: string) => boolean; record: (ip: string) => void };
	sessions: {
		tryAcquire: (key?: string) => boolean;
		release: (key?: string) => void;
	};
};

const MINUTE = 60_000;

function limiters({
	rateRps = 1,
	rateBurst = 2,
	authFailPerMin = 3,
	maxSessions = 2
} = {}) {
	let now = 1_000_000;
	const sweeps: (() => void)[] = [];
	const module = loadOverlayModule<Limiters>({
		source: new URL(
			"../../../../../../overlay/src/node/routes/api/ratelimit.ts",
			import.meta.url
		),
		dependencies: {
			"./config": {
				apiConfig: { rateRps, rateBurst, authFailPerMin, maxSessions }
			}
		},
		globals: {
			Date: { now: () => now },
			Math,
			// Every limiter arms a sweep on construction. Holding the callbacks is
			// what makes the sweep testable at all - it is private, and the memory
			// it frees is not observable any other way.
			setInterval: (callback: () => void) => {
				sweeps.push(callback);
				return { unref: () => undefined };
			}
		}
	}).exports;

	return {
		...module,
		sweep: () => sweeps.forEach((callback) => callback()),
		advance: (ms: number) => {
			now += ms;
		}
	};
}

describe("the per-key request rate", () => {
	test("allows a burst, then refuses until the bucket refills", () => {
		const { rateLimit, advance } = limiters({ rateRps: 1, rateBurst: 2 });

		expect(rateLimit.allow("key_one")).toBe(true);
		expect(rateLimit.allow("key_one")).toBe(true);
		expect(rateLimit.allow("key_one")).toBe(false);

		// One token per second, so a second buys exactly one more request.
		advance(1_000);
		expect(rateLimit.allow("key_one")).toBe(true);
		expect(rateLimit.allow("key_one")).toBe(false);
	});

	test("never refills past the burst it started with", () => {
		const { rateLimit, advance } = limiters({ rateRps: 1, rateBurst: 2 });
		rateLimit.allow("key_one");

		// An hour idle must not bank an hour of requests.
		advance(60 * MINUTE);

		expect(rateLimit.allow("key_one")).toBe(true);
		expect(rateLimit.allow("key_one")).toBe(true);
		expect(rateLimit.allow("key_one")).toBe(false);
	});

	test("gives each key its own budget", () => {
		const { rateLimit } = limiters({ rateBurst: 1 });

		expect(rateLimit.allow("key_one")).toBe(true);
		expect(rateLimit.allow("key_one")).toBe(false);
		expect(rateLimit.allow("key_two")).toBe(true);
	});

	// The map is the only thing here that grows, so a sweep frees keys the box
	// has stopped hearing from. Dropping one that is still short of a full
	// bucket would hand its next request a brand new budget, which is the one
	// way a sweep can quietly become a way around the limit. Slow enough here
	// that the bucket is still refilling long after the idle cutoff.
	test("does not hand a throttled key a fresh budget when it sweeps", () => {
		const { rateLimit, advance, sweep } = limiters({
			rateRps: 0.001,
			rateBurst: 2
		});
		rateLimit.allow("key_one");
		rateLimit.allow("key_one");
		expect(rateLimit.allow("key_one")).toBe(false);

		// Past the idle cutoff, but only 0.36 of a token back.
		advance(6 * MINUTE);
		sweep();

		expect(rateLimit.allow("key_one")).toBe(false);
	});
});

describe("the failed-authentication window", () => {
	test("allows a set number of failures a minute", () => {
		const { authFail } = limiters({ authFailPerMin: 3 });

		for (let attempt = 0; attempt < 3; attempt += 1) {
			expect(authFail.allow("10.0.0.1")).toBe(true);
			authFail.record("10.0.0.1");
		}

		expect(authFail.allow("10.0.0.1")).toBe(false);
	});

	test("is a rolling window, not a bucket that stays empty", () => {
		const { authFail, advance } = limiters({ authFailPerMin: 2 });
		authFail.record("10.0.0.1");
		authFail.record("10.0.0.1");
		expect(authFail.allow("10.0.0.1")).toBe(false);

		advance(MINUTE + 1);

		expect(authFail.allow("10.0.0.1")).toBe(true);
	});

	test("counts each source separately", () => {
		const { authFail } = limiters({ authFailPerMin: 1 });
		authFail.record("10.0.0.1");

		expect(authFail.allow("10.0.0.1")).toBe(false);
		expect(authFail.allow("10.0.0.2")).toBe(true);
	});

	test("drops a source once its failures age out", () => {
		const { authFail, advance, sweep } = limiters({ authFailPerMin: 1 });
		authFail.record("10.0.0.1");

		advance(MINUTE + 1);
		sweep();

		expect(authFail.allow("10.0.0.1")).toBe(true);
	});
});

describe("concurrent session slots", () => {
	test("hands out a fixed number and refuses the next", () => {
		const { sessions } = limiters({ maxSessions: 2 });

		expect(sessions.tryAcquire()).toBe(true);
		expect(sessions.tryAcquire()).toBe(true);
		expect(sessions.tryAcquire()).toBe(false);
	});

	test("takes a slot back when it is released", () => {
		const { sessions } = limiters({ maxSessions: 1 });
		sessions.tryAcquire();
		expect(sessions.tryAcquire()).toBe(false);

		sessions.release();

		expect(sessions.tryAcquire()).toBe(true);
	});

	// A release that never acquired must not mint a slot, or a double release
	// somewhere in the terminal code becomes a way past the cap.
	test("cannot be released into a surplus", () => {
		const { sessions } = limiters({ maxSessions: 1 });
		sessions.release();
		sessions.release();

		expect(sessions.tryAcquire()).toBe(true);
		expect(sessions.tryAcquire()).toBe(false);
	});
});
