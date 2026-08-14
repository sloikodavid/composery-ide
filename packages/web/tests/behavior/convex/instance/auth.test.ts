import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
	vi
} from "vitest";
import { createHash } from "node:crypto";

import { api, internal } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { isBoxIdeRedirect } from "@/convex/instance/auth";

import {
	boxOperations,
	readBox,
	scheduledArgs,
	scheduledJobs,
	seedBox,
	seedUser,
	testConvex,
	type Harness
} from "../../../support/convex.ts";

const previousDomain = process.env.CLOUD_DOMAIN;

// The database-backed halves of this file all reason about windows measured from
// now - a code's two minutes, a grant's ten, a reconciliation's retries.
const NOW = Date.UTC(2026, 6, 8, 9, 10, 11);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("isBoxIdeRedirect", () => {
	test("accepts an HTTPS callback supplied by the matching box IDE", () => {
		process.env.CLOUD_DOMAIN = "composery.cloud";
		expect(
			isBoxIdeRedirect(
				{ slug: "my-box" },
				"https://my-box.composery.cloud/ide/_composery/cloud/callback"
			)
		).toBe(true);
	});

	test.each([
		"https://other.composery.cloud/ide/_composery/cloud/callback",
		"https://my-box.composery.cloud/_composery/cloud/callback",
		"https://my-box.composery.cloud/ide/callback?send=elsewhere",
		"not a url"
	])("rejects a callback outside the box IDE: %s", (redirectUri) => {
		process.env.CLOUD_DOMAIN = "composery.cloud";
		expect(isBoxIdeRedirect({ slug: "my-box" }, redirectUri)).toBe(false);
	});
});

afterAll(() => {
	if (previousDomain === undefined) delete process.env.CLOUD_DOMAIN;
	else process.env.CLOUD_DOMAIN = previousDomain;
});

// The two tables the authorization flow writes to. Their rows are short-lived by
// design - two minutes for a code, ten for a grant - which is exactly why the
// sweep that removes them has to keep up with however many were minted rather
// than with a fixed number per run.
describe("deleting expired authorization records", () => {
	const NOW = Date.UTC(2026, 6, 8, 9, 10, 11);

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	async function seedAuthRecords(
		t: Harness,
		counts: { codes?: number; grants?: number; live?: number } = {}
	) {
		const owner = await seedUser(t);
		const boxId = await seedBox(t, { user_id: owner.clerkUserId });
		const now = NOW;
		await t.run(async (ctx) => {
			for (let index = 0; index < (counts.codes ?? 0); index += 1) {
				await ctx.db.insert("box_auth_codes", {
					box_id: boxId,
					code_hash: `expired-code-${index}`,
					code_challenge: "challenge",
					redirect_uri: "https://box.example/callback",
					type: "session",
					expires_at: now - 1,
					created_at: now - 2
				});
			}
			for (let index = 0; index < (counts.grants ?? 0); index += 1) {
				await ctx.db.insert("box_auth_grants", {
					box_id: boxId,
					token_hash: `expired-grant-${index}`,
					expires_at: now - 1,
					created_at: now - 2
				});
			}
			for (let index = 0; index < (counts.live ?? 0); index += 1) {
				await ctx.db.insert("box_auth_codes", {
					box_id: boxId,
					code_hash: `live-code-${index}`,
					code_challenge: "challenge",
					redirect_uri: "https://box.example/callback",
					type: "session",
					expires_at: now + 60_000,
					created_at: now
				});
			}
		});
		return boxId;
	}

	function countRows(t: Harness) {
		return t.run(async (ctx) => ({
			codes: (await ctx.db.query("box_auth_codes").collect()).length,
			grants: (await ctx.db.query("box_auth_grants").collect()).length
		}));
	}

	test("removes expired codes and grants and leaves live ones", async () => {
		const t = testConvex();
		await seedAuthRecords(t, { codes: 3, grants: 2, live: 2 });

		const deleted = await t.mutation(
			internal.instance.auth.deleteExpiredAuthRecords,
			{}
		);

		expect(deleted).toBe(5);
		expect(await countRows(t)).toEqual({ codes: 2, grants: 0 });
	});

	test("stops without rescheduling when it cleared everything", async () => {
		const t = testConvex();
		await seedAuthRecords(t, { codes: 3 });

		await t.mutation(internal.instance.auth.deleteExpiredAuthRecords, {});

		expect(await scheduledJobs(t)).toEqual([]);
	});

	// The failure this guards is silent by construction: the cron reports success
	// on a run that cleared its ceiling and left the rest, so both tables grow for
	// ever while nothing anywhere says so.
	test("comes back for the rest when it fills a batch", async () => {
		const t = testConvex();
		await seedAuthRecords(t, { codes: 201 });

		const deleted = await t.mutation(
			internal.instance.auth.deleteExpiredAuthRecords,
			{}
		);

		expect(deleted).toBe(200);
		expect(
			await scheduledJobs(t, "instance/auth:deleteExpiredAuthRecords")
		).toHaveLength(1);
	});
});

// The password bootstrap, end to end. A cloud box has no password until its
// owner proves ownership through the website and hands the box a grant it can
// exchange - so this flow is the only way a box ever becomes reachable, and
// every secret in it is minted here.
describe("authorizing a box through its owner's session", () => {
	const CHALLENGE = "a".repeat(43);
	const HASH = "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA";

	function stubDomain() {
		vi.stubEnv("CLOUD_DOMAIN", "composery.cloud");
	}

	async function ownedBox(t: Harness) {
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas"
		});
		return { boxId, owner };
	}

	const redirect =
		"https://atlas.composery.cloud/ide/_composery/cloud/callback";

	test("mints a single-use code the owner's own box can exchange", async () => {
		stubDomain();
		const t = testConvex();
		const { boxId, owner } = await ownedBox(t);

		const { code } = await t
			.withIdentity(owner.identity)
			.action(api.instance.auth.createAuthorizationCode, {
				boxId,
				codeChallenge: CHALLENGE,
				redirectUri: redirect,
				type: "password"
			});

		// 32 random bytes as unpadded base64url is exactly 43 characters, which is
		// the shape every other end of this flow validates against.
		expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(
			await t.run((ctx) => ctx.db.query("box_auth_codes").collect())
		).toMatchObject([{ box_id: boxId, type: "password" }]);
		// The code itself is never stored - only its digest, so a leaked table row
		// is not a code anyone can exchange.
		const [stored] = await t.run((ctx) =>
			ctx.db.query("box_auth_codes").collect()
		);
		expect(stored.code_hash).not.toBe(code);
	});

	test("refuses to authorize somebody else's box", async () => {
		stubDomain();
		const t = testConvex();
		const { boxId } = await ownedBox(t);
		const stranger = await seedUser(t, { clerkUserId: "user_stranger" });

		await expect(
			t
				.withIdentity(stranger.identity)
				.action(api.instance.auth.createAuthorizationCode, {
					boxId,
					codeChallenge: CHALLENGE,
					redirectUri: redirect,
					type: "password"
				})
		).rejects.toThrow("Box not found.");
	});

	// The redirect is where the code is handed back, so a callback outside this
	// box's own IDE would be a code delivered to somewhere else entirely.
	test("refuses a callback that is not this box's own IDE", async () => {
		stubDomain();
		const t = testConvex();
		const { boxId, owner } = await ownedBox(t);

		await expect(
			t
				.withIdentity(owner.identity)
				.action(api.instance.auth.createAuthorizationCode, {
					boxId,
					codeChallenge: CHALLENGE,
					redirectUri: "https://elsewhere.example/callback",
					type: "password"
				})
		).rejects.toThrow("Invalid authorization request.");
	});

	test("refuses a challenge that is not the shape a verifier digests to", async () => {
		stubDomain();
		const t = testConvex();
		const { boxId, owner } = await ownedBox(t);

		await expect(
			t
				.withIdentity(owner.identity)
				.action(api.instance.auth.createAuthorizationCode, {
					boxId,
					codeChallenge: "too-short",
					redirectUri: redirect,
					type: "password"
				})
		).rejects.toThrow("Invalid authorization request.");
	});

	// PKCE, and the reason the code alone is not enough: the code travels through
	// a browser redirect, and only the box that started the flow holds the
	// verifier the challenge was made from.
	test("refuses a code exchanged without the verifier it was bound to", async () => {
		stubDomain();
		const t = testConvex();
		const { boxId, owner } = await ownedBox(t);
		const { code } = await t
			.withIdentity(owner.identity)
			.action(api.instance.auth.createAuthorizationCode, {
				boxId,
				codeChallenge: CHALLENGE,
				redirectUri: redirect,
				type: "password"
			});

		await expect(
			t.action(api.instance.auth.exchangeAuthorizationCode, {
				boxId,
				code,
				codeVerifier: "b".repeat(43),
				redirectUri: redirect,
				type: "password"
			})
		).rejects.toThrow("Invalid or expired authorization code.");
	});

	test("installs a password against a grant the flow issued", async () => {
		stubDomain();
		const t = testConvex();
		const { boxId, owner } = await ownedBox(t);
		const verifier = "c".repeat(43);
		// The challenge the box would send: the digest of its own verifier.
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(verifier)
		);
		const challenge = Buffer.from(digest)
			.toString("base64")
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/g, "");

		const { code } = await t
			.withIdentity(owner.identity)
			.action(api.instance.auth.createAuthorizationCode, {
				boxId,
				codeChallenge: challenge,
				redirectUri: redirect,
				type: "password"
			});
		const exchanged = await t.action(
			api.instance.auth.exchangeAuthorizationCode,
			{
				boxId,
				code,
				codeVerifier: verifier,
				redirectUri: redirect,
				type: "password"
			}
		);
		expect(exchanged.type).toBe("password");
		if (exchanged.type !== "password") return;

		await t.action(api.instance.auth.installPassword, {
			boxId,
			grant: exchanged.grant,
			runtimeAuthHash: HASH
		});

		expect(await readBox(t, boxId)).toMatchObject({
			runtime_auth_hash: HASH
		});
	});

	// One use. A code that could be exchanged twice is a second grant for anyone
	// who saw the redirect go past.
	test("refuses to exchange the same code twice", async () => {
		stubDomain();
		const t = testConvex();
		const { boxId, owner } = await ownedBox(t);
		const verifier = "d".repeat(43);
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(verifier)
		);
		const challenge = Buffer.from(digest)
			.toString("base64")
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/g, "");
		const { code } = await t
			.withIdentity(owner.identity)
			.action(api.instance.auth.createAuthorizationCode, {
				boxId,
				codeChallenge: challenge,
				redirectUri: redirect,
				type: "password"
			});
		await t.action(api.instance.auth.exchangeAuthorizationCode, {
			boxId,
			code,
			codeVerifier: verifier,
			redirectUri: redirect,
			type: "password"
		});

		await expect(
			t.action(api.instance.auth.exchangeAuthorizationCode, {
				boxId,
				code,
				codeVerifier: verifier,
				redirectUri: redirect,
				type: "password"
			})
		).rejects.toThrow("Invalid or expired authorization code.");
	});
});

// Recording a password an owner changed on the box itself.
//
// The other half of the flow: the grant path above proves ownership through the
// website and is the only way to set a password you cannot already produce.
// This one is for somebody who *can* - they proved the current password to the
// box, changed it there, and the control plane has to record that or the next
// bootstrap renders an env file with the old hash and silently reverts it.
//
// The gate is the current hash, and it is the whole of the gate: anyone who can
// call this with the right one already holds the password.
describe("recording a password change made on the box", () => {
	const CURRENT = "$argon2id$v=19$m=65536$c2FsdA$Y3VycmVudA";
	const NEXT = "$argon2id$v=19$m=65536$c2FsdA$bmV4dA";

	async function boxWithPassword(t: Harness, hash = CURRENT) {
		const owner = await seedUser(t);
		return await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas",
			runtime_auth_hash: hash
		});
	}

	const apply = (
		t: Harness,
		boxId: Id<"boxes">,
		current: string,
		next: string
	) =>
		t.mutation(internal.instance.auth.applyPasswordChange, {
			boxId,
			currentRuntimeAuthHash: current,
			runtimeAuthHash: next
		});

	test("stores the new hash when the current one is proved", async () => {
		const t = testConvex();
		const boxId = await boxWithPassword(t);

		await apply(t, boxId, CURRENT, NEXT);

		expect(await readBox(t, boxId)).toMatchObject({
			runtime_auth_hash: NEXT
		});
	});

	// The gate. A box that cannot produce the current hash is either a different
	// box or a stale one, and letting it write here would change the control
	// plane's idea of the password without anyone proving they hold it.
	test("refuses a change that cannot produce the current hash", async () => {
		const t = testConvex();
		const boxId = await boxWithPassword(t);

		await expect(apply(t, boxId, "$argon2id$wrong", NEXT)).rejects.toThrow(
			"Current password does not match."
		);
		expect(await readBox(t, boxId)).toMatchObject({
			runtime_auth_hash: CURRENT
		});
	});

	test("refuses to record anything against a box that is gone", async () => {
		const t = testConvex();
		const boxId = await boxWithPassword(t);
		await t.run(async (ctx) => await ctx.db.delete(boxId));

		await expect(apply(t, boxId, CURRENT, NEXT)).rejects.toThrow(
			"Box not found."
		);
	});

	// The env file on the host still holds the old hash, so the new password
	// works until the box next restarts and then reverts. Reconciliation is what
	// closes that window, and it is scheduled from here.
	test("schedules the reconciliation that rewrites the env file", async () => {
		const t = testConvex();
		const boxId = await boxWithPassword(t);

		await apply(t, boxId, CURRENT, NEXT);

		expect(
			await scheduledArgs<{ runtimeAuthHash: string; attempt: number }>(
				t,
				"instance/auth:reconcilePassword"
			)
		).toMatchObject([{ runtimeAuthHash: NEXT, attempt: 1 }]);
	});

	// Re-sending the same change is a no-op, not a second reconciliation: the
	// box retries this call, and each schedule is an operation on the box.
	test("does nothing at all when the hash has not moved", async () => {
		const t = testConvex();
		const boxId = await boxWithPassword(t);

		await apply(t, boxId, CURRENT, CURRENT);

		expect(await scheduledJobs(t, "instance/auth:reconcilePassword")).toEqual(
			[]
		);
	});

	test.each([
		["a hash that is not argon2id", "$2b$12$notargon", NEXT],
		["a new hash that is not argon2id", CURRENT, "plaintext"],
		["a hash beyond the length bound", CURRENT, `$argon2id$${"a".repeat(600)}`]
	])("refuses %s at the boundary", async (_name, current, next) => {
		const t = testConvex();
		const boxId = await boxWithPassword(t);

		await expect(
			t.action(api.instance.auth.changePassword, {
				boxId,
				currentRuntimeAuthHash: current,
				runtimeAuthHash: next
			})
		).rejects.toThrow("Invalid password hash.");
	});
});

// Reconciliation: the box already applied the password itself, and this rewrites
// the env file we render so the next restart does not undo it.
describe("reconciling a password onto the host", () => {
	const HASH = "$argon2id$v=19$m=65536$c2FsdA$aGFzaA";

	async function boxAt(t: Harness, hash: string | undefined) {
		const owner = await seedUser(t);
		return await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas",
			runtime_auth_hash: hash
		});
	}

	const reconcile = (
		t: Harness,
		boxId: Id<"boxes">,
		hash: string,
		attempt = 1
	) =>
		t.action(internal.instance.auth.reconcilePassword, {
			boxId,
			idempotencyKey: `password:${boxId}`,
			runtimeAuthHash: hash,
			attempt
		});

	test("starts a password-change operation for the hash the row holds", async () => {
		const t = testConvex();
		const boxId = await boxAt(t, HASH);

		await reconcile(t, boxId, HASH);

		expect(await boxOperations(t, boxId)).toMatchObject([
			{ type: "change_password", trigger: "owner" }
		]);
	});

	// The row moved on: somebody changed the password again while this was
	// waiting, and reconciling the older one would put back a password the owner
	// has already replaced.
	test("gives up when the row has since moved to another password", async () => {
		const t = testConvex();
		const boxId = await boxAt(t, "$argon2id$newer");

		await reconcile(t, boxId, HASH);

		expect(await boxOperations(t, boxId)).toEqual([]);
	});

	test("gives up on a box that has been deleted", async () => {
		const t = testConvex();
		const boxId = await boxAt(t, HASH);
		await t.run(async (ctx) => await ctx.db.delete(boxId));

		await expect(reconcile(t, boxId, HASH)).resolves.not.toThrow();
	});

	// The box is busy with something else. Retrying is the point - the env file
	// still holds the old hash until this lands - so it comes back rather than
	// giving up.
	test("retries when the box is busy with another operation", async () => {
		const t = testConvex();
		const boxId = await boxAt(t, HASH);
		await t.run(
			async (ctx) =>
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: "repair",
					status: "running",
					idempotency_key: "busy",
					trigger: "owner",
					created_at: NOW,
					updated_at: NOW
				})
		);

		await reconcile(t, boxId, HASH);

		expect(
			await scheduledArgs<{ attempt: number }>(
				t,
				"instance/auth:reconcilePassword"
			)
		).toMatchObject([{ attempt: 2 }]);
	});

	// Bounded. Past the last attempt it throws instead of rescheduling, so the
	// failure is visible rather than a retry loop that runs for ever.
	test("stops retrying once it has run out of attempts", async () => {
		const t = testConvex();
		const boxId = await boxAt(t, HASH);
		await t.run(
			async (ctx) =>
				await ctx.db.insert("box_operations", {
					box_id: boxId,
					type: "repair",
					status: "running",
					idempotency_key: "busy",
					trigger: "owner",
					created_at: NOW,
					updated_at: NOW
				})
		);

		await expect(reconcile(t, boxId, HASH, 20)).rejects.toThrow();
		expect(await scheduledJobs(t, "instance/auth:reconcilePassword")).toEqual(
			[]
		);
	});
});

// The session half of the exchange, and the capability rule that separates the
// two types.
describe("exchanging a code for a session", () => {
	const CHALLENGE = "a".repeat(43);

	async function ownedBox(t: Harness) {
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas"
		});
		return { boxId, owner };
	}

	async function storedCode(
		t: Harness,
		boxId: Id<"boxes">,
		type: "password" | "session",
		overrides: Record<string, unknown> = {}
	) {
		await t.run(
			async (ctx) =>
				await ctx.db.insert("box_auth_codes", {
					box_id: boxId,
					code_hash: "hashed-code",
					code_challenge: CHALLENGE,
					redirect_uri: "https://atlas.composery.cloud/ide/cb",
					type,
					expires_at: NOW + 60_000,
					created_at: NOW,
					...overrides
				})
		);
	}

	const exchange = (
		t: Harness,
		boxId: Id<"boxes">,
		type: "password" | "session",
		grantHash?: string
	) =>
		t.mutation(internal.instance.auth.exchangeCode, {
			boxId,
			codeHash: "hashed-code",
			codeChallenge: CHALLENGE,
			redirectUri: "https://atlas.composery.cloud/ide/cb",
			type,
			grantHash
		});

	test("consumes the code and mints no grant", async () => {
		const t = testConvex();
		const { boxId } = await ownedBox(t);
		await storedCode(t, boxId, "session");

		await exchange(t, boxId, "session");

		expect(
			await t.run((ctx) => ctx.db.query("box_auth_grants").collect())
		).toEqual([]);
		expect(
			(await t.run((ctx) => ctx.db.query("box_auth_codes").collect()))[0]
				?.consumed_at
		).toBe(NOW);
	});

	// A session is not a capability to set a password. Accepting a grant hash
	// here would mint one from a code that was only ever authorised for a login.
	test("refuses a grant offered against a session code", async () => {
		const t = testConvex();
		const { boxId } = await ownedBox(t);
		await storedCode(t, boxId, "session");

		await expect(exchange(t, boxId, "session", "grant-hash")).rejects.toThrow(
			"Invalid authorization capability."
		);
	});

	test("refuses a password exchange that offers no grant to mint", async () => {
		const t = testConvex();
		const { boxId } = await ownedBox(t);
		await storedCode(t, boxId, "password");

		await expect(exchange(t, boxId, "password")).rejects.toThrow(
			"Invalid authorization capability."
		);
	});

	test.each([
		["a code that has expired", { expires_at: NOW - 1 }],
		["a code already consumed", { consumed_at: NOW - 1 }],
		["a code bound to another redirect", { redirect_uri: "https://x/y" }],
		["a code bound to another challenge", { code_challenge: "b".repeat(43) }]
	])("refuses %s", async (_name, overrides) => {
		const t = testConvex();
		const { boxId } = await ownedBox(t);
		await storedCode(t, boxId, "session", overrides);

		await expect(exchange(t, boxId, "session")).rejects.toThrow(
			"Invalid or expired authorization code."
		);
	});

	// A code minted for one box must never be exchangeable against another.
	test("refuses a code that belongs to a different box", async () => {
		const t = testConvex();
		const { boxId } = await ownedBox(t);
		const other = await seedBox(t, { user_id: "someone", slug: "theirs" });
		await storedCode(t, boxId, "session");

		await expect(exchange(t, other, "session")).rejects.toThrow(
			"Invalid or expired authorization code."
		);
	});

	// The two capabilities are minted by different flows and are not
	// interchangeable: a code authorised to set a password must not come back as
	// a sign-in, and a sign-in must not be redeemable for the capability to
	// overwrite the password. The box refuses the same crossing from its own
	// side, in
	// packages/ide/tests/behavior/src/node/routes/cloudAuth.test.ts.
	test.each([
		["password", "session"],
		["session", "password"]
	] as const)("refuses a %s code exchanged as a %s", async (minted, asked) => {
		const t = testConvex();
		const { boxId } = await ownedBox(t);
		await storedCode(t, boxId, minted);

		await expect(
			exchange(t, boxId, asked, asked === "password" ? "grant-hash" : undefined)
		).rejects.toThrow("Invalid or expired authorization code.");
	});
});

// The last step of the recovery flow: the box presents the grant it was handed
// and the hash it wants installed. This is what actually moves the control
// plane's idea of the password, so every way of reaching it without a live
// grant has to fail - and the one replay that must succeed is the box retrying
// the call it already made.
describe("claiming a setup grant", () => {
	const HASH = "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA";

	async function grantedBox(
		t: Harness,
		overrides: Record<string, unknown> = {}
	) {
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas"
		});
		await t.run(
			async (ctx) =>
				await ctx.db.insert("box_auth_grants", {
					box_id: boxId,
					token_hash: "hashed-grant",
					expires_at: NOW + 60_000,
					created_at: NOW,
					...overrides
				})
		);
		return boxId;
	}

	const claim = (t: Harness, boxId: Id<"boxes">, runtimeAuthHash = HASH) =>
		t.mutation(internal.instance.auth.claimGrantForPassword, {
			boxId,
			grantHash: "hashed-grant",
			runtimeAuthHash
		});

	test("installs the hash and schedules the reconciliation", async () => {
		const t = testConvex();
		const boxId = await grantedBox(t);

		await claim(t, boxId);

		expect(await readBox(t, boxId)).toMatchObject({
			runtime_auth_hash: HASH,
			password_setup_pending_at: NOW
		});
		expect(
			await scheduledArgs<{ runtimeAuthHash: string; attempt: number }>(
				t,
				"instance/auth:reconcilePassword"
			)
		).toMatchObject([{ runtimeAuthHash: HASH, attempt: 1 }]);
	});

	test("spends the grant", async () => {
		const t = testConvex();
		const boxId = await grantedBox(t);

		await claim(t, boxId);

		expect(
			(await t.run((ctx) => ctx.db.query("box_auth_grants").collect()))[0]
				?.consumed_at
		).toBe(NOW);
	});

	// The box may not have heard the answer to the call it already made, so the
	// identical retry has to succeed rather than strand an owner mid-recovery.
	test("lets the box retry the claim it already made", async () => {
		const t = testConvex();
		const boxId = await grantedBox(t);
		await claim(t, boxId);

		await claim(t, boxId);

		expect(await readBox(t, boxId)).toMatchObject({ runtime_auth_hash: HASH });
	});

	// ...but a spent grant is not a second capability. Presenting it with a
	// different hash is another password, not a retry, and it is refused.
	test("refuses a spent grant asking for a different password", async () => {
		const t = testConvex();
		const boxId = await grantedBox(t);
		await claim(t, boxId);

		await expect(claim(t, boxId, `${HASH}other`)).rejects.toThrow(
			"Invalid or expired setup grant."
		);
		expect(await readBox(t, boxId)).toMatchObject({ runtime_auth_hash: HASH });
	});

	test.each([
		["a grant that has expired", { expires_at: NOW - 1 }],
		["a grant nobody issued", { token_hash: "someone-elses-grant" }]
	])("refuses %s", async (_name, overrides) => {
		const t = testConvex();
		const boxId = await grantedBox(t, overrides);

		await expect(claim(t, boxId)).rejects.toThrow(
			"Invalid or expired setup grant."
		);
		expect(await readBox(t, boxId)).not.toHaveProperty("runtime_auth_hash");
	});

	test("refuses a grant presented against another box", async () => {
		const t = testConvex();
		await grantedBox(t);
		const other = await seedBox(t, { user_id: "someone", slug: "theirs" });

		await expect(claim(t, other)).rejects.toThrow(
			"Invalid or expired setup grant."
		);
	});

	test("refuses to set a password on a box that is gone", async () => {
		const t = testConvex();
		const boxId = await grantedBox(t);
		await t.run(async (ctx) => await ctx.db.delete(boxId));

		await expect(claim(t, boxId)).rejects.toThrow("Box not found.");
	});
});

// The whole flow, driven through the three public actions a browser and a box
// actually call. Everything below this point had only ever been tested one
// internal mutation at a time, so the thing none of those could say is whether
// the pieces fit: that the code a browser is handed is the one the box can
// exchange, that what it exchanges for installs a password, and that each step
// refuses what the step before it did not produce.
//
// This is the only way to set a password you cannot already produce, so a gap
// here is a gap in the recovery path for every cloud box.
describe("the authorization flow end to end", () => {
	const HASH = "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA";
	const REDIRECT =
		"https://atlas.composery.cloud/ide/_composery/cloud/callback";

	// The PKCE pair. The browser keeps the verifier and sends only its digest, so
	// a code intercepted on its way back is worth nothing without the verifier.
	const VERIFIER = "v".repeat(43);
	const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

	async function ownedBox(t: Harness) {
		vi.stubEnv("CLOUD_DOMAIN", "composery.cloud");
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas"
		});
		return { boxId, owner };
	}

	async function authorize(
		t: Harness,
		owner: { identity: { subject: string } },
		boxId: Id<"boxes">,
		type: "password" | "session" = "password"
	) {
		return await t
			.withIdentity(owner.identity)
			.action(api.instance.auth.createAuthorizationCode, {
				boxId,
				codeChallenge: CHALLENGE,
				redirectUri: REDIRECT,
				type
			});
	}

	const exchange = (
		t: Harness,
		boxId: Id<"boxes">,
		overrides: Record<string, unknown> = {}
	) =>
		t.action(api.instance.auth.exchangeAuthorizationCode, {
			boxId,
			code: "c".repeat(43),
			codeVerifier: VERIFIER,
			redirectUri: REDIRECT,
			type: "password",
			...overrides
		} as never);

	test("carries an owner's session through to a password on the box", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedBox(t);

		const { code } = await authorize(t, owner, boxId);
		const exchanged = await exchange(t, boxId, { code });
		const installed = await t.action(api.instance.auth.installPassword, {
			boxId,
			grant: exchanged.type === "password" ? exchanged.grant : "",
			runtimeAuthHash: HASH
		});

		expect(installed).toEqual({ accepted: true });
		expect(await readBox(t, boxId)).toMatchObject({
			runtime_auth_hash: HASH,
			password_setup_pending_at: NOW
		});
	});

	// The exchange is what the box does, and it is unauthenticated - holding the
	// code is the whole proof. So the code has to be worth exactly one exchange.
	test("refuses to exchange a code that was already spent", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedBox(t);
		const { code } = await authorize(t, owner, boxId);
		await exchange(t, boxId, { code });

		await expect(exchange(t, boxId, { code })).rejects.toThrow(
			"Invalid or expired authorization code."
		);
	});

	// Without this the code alone would be enough, and PKCE would be decoration.
	test("refuses a code presented without the verifier it was minted for", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedBox(t);
		const { code } = await authorize(t, owner, boxId);

		await expect(
			exchange(t, boxId, { code, codeVerifier: "w".repeat(43) })
		).rejects.toThrow("Invalid or expired authorization code.");
	});

	// A code is minted for one box. Presenting it against another would let the
	// holder of any box's code set a password on a box that is not theirs.
	test("refuses a code presented against a different box", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedBox(t);
		const other = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "borealis"
		});
		const { code } = await authorize(t, owner, boxId);

		await expect(exchange(t, other, { code })).rejects.toThrow(
			"Invalid or expired authorization code."
		);
	});

	// The type is fixed when the code is minted, so a code for a session cannot
	// be turned into one that yields a password grant.
	test("refuses to exchange a session code for a password grant", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedBox(t);
		const { code } = await authorize(t, owner, boxId, "session");

		await expect(exchange(t, boxId, { code })).rejects.toThrow(
			"Invalid or expired authorization code."
		);
	});

	// A session authorization proves who you are and nothing more: it must not
	// hand back a capability that could set a password.
	test("hands back no grant when the code was for a session", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedBox(t);
		const { code } = await authorize(t, owner, boxId, "session");

		expect(await exchange(t, boxId, { code, type: "session" })).toEqual({
			type: "session"
		});
	});

	// Two seconds of validity is the whole point of a code: it is handed across a
	// redirect and spent immediately.
	test("refuses a code presented after its window closed", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedBox(t);
		const { code } = await authorize(t, owner, boxId);

		vi.setSystemTime(NOW + 2 * 60 * 1000 + 1);

		await expect(exchange(t, boxId, { code })).rejects.toThrow(
			"Invalid or expired authorization code."
		);
	});

	// The redirect is part of what was authorized, so a code cannot be replayed
	// towards somewhere else.
	test("refuses a code exchanged against a different redirect", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedBox(t);
		const { code } = await authorize(t, owner, boxId);

		await expect(
			exchange(t, boxId, {
				code,
				redirectUri: "https://elsewhere.example/callback"
			})
		).rejects.toThrow("Invalid or expired authorization code.");
	});

	// Each of these three is a secret this flow mints and validates by shape.
	// Anything of another shape never reached the database before, and must not
	// start to: these are the arguments an unauthenticated caller controls.
	test.each([
		["a code of the wrong shape", { code: "short" }],
		["a verifier of the wrong shape", { codeVerifier: "short" }],
		[
			"a redirect longer than the flow allows",
			{ redirectUri: `https://atlas.composery.cloud/${"x".repeat(512)}` }
		]
	])("refuses an exchange presenting %s", async (_name, overrides) => {
		const t = testConvex();
		const { boxId, owner } = await ownedBox(t);
		const { code } = await authorize(t, owner, boxId);

		await expect(exchange(t, boxId, { code, ...overrides })).rejects.toThrow(
			"Invalid authorization code."
		);
		// Refused on shape alone, before anything was looked up - so the code the
		// owner minted is still theirs to spend.
		const [unspent] = await t.run((ctx) =>
			ctx.db.query("box_auth_codes").collect()
		);
		expect(unspent).not.toHaveProperty("consumed_at");
	});

	test.each([
		["a grant of the wrong shape", { grant: "short" }],
		["a hash that is not argon2id", { runtimeAuthHash: "not-a-hash" }],
		[
			"a hash longer than the flow allows",
			{ runtimeAuthHash: `$argon2id$${"x".repeat(512)}` }
		]
	])("refuses to install a password with %s", async (_name, overrides) => {
		const t = testConvex();
		const { boxId, owner } = await ownedBox(t);
		const { code } = await authorize(t, owner, boxId);
		const exchanged = await exchange(t, boxId, { code });

		await expect(
			t.action(api.instance.auth.installPassword, {
				boxId,
				grant: exchanged.type === "password" ? exchanged.grant : "",
				runtimeAuthHash: HASH,
				...overrides
			})
		).rejects.toThrow("Invalid password hash.");
		expect(await readBox(t, boxId)).not.toHaveProperty("runtime_auth_hash");
	});

	// The grant is a bearer capability, so it must be a fresh secret every time
	// rather than anything derived from the code it came from.
	test("mints a grant that is neither the code nor the last one", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedBox(t);

		const first = await authorize(t, owner, boxId);
		const one = await exchange(t, boxId, { code: first.code });
		const second = await authorize(t, owner, boxId);
		const two = await exchange(t, boxId, { code: second.code });

		const grants = [one, two].map((result) =>
			result.type === "password" ? result.grant : ""
		);
		expect(grants[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(grants[0]).not.toBe(grants[1]);
		expect(grants).not.toContain(first.code);
	});

	// Only the digest is stored, so a leaked row is not a capability.
	test("never stores the grant it handed back", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedBox(t);
		const { code } = await authorize(t, owner, boxId);

		const exchanged = await exchange(t, boxId, { code });

		const [stored] = await t.run((ctx) =>
			ctx.db.query("box_auth_grants").collect()
		);
		expect(stored?.token_hash).not.toBe(
			exchanged.type === "password" ? exchanged.grant : ""
		);
	});

	// The box installs a password and then tells the host about it. That second
	// step is a scheduled reconciliation, and without it the box would keep
	// serving the old password until something else restarted it.
	test("schedules the new password onto the host", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedBox(t);
		const { code } = await authorize(t, owner, boxId);
		const exchanged = await exchange(t, boxId, { code });

		await t.action(api.instance.auth.installPassword, {
			boxId,
			grant: exchanged.type === "password" ? exchanged.grant : "",
			runtimeAuthHash: HASH
		});

		expect(
			await scheduledArgs<{ runtimeAuthHash: string }>(
				t,
				"instance/auth:reconcilePassword"
			)
		).toMatchObject([{ runtimeAuthHash: HASH, attempt: 1 }]);
	});

	// A box that retries the same install - a dropped response, a reload - must
	// get the same answer rather than a refusal, or the owner is left with a
	// password the box thinks it set and Convex does not.
	test("lets a box repeat an install it already made", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedBox(t);
		const { code } = await authorize(t, owner, boxId);
		const exchanged = await exchange(t, boxId, { code });
		const grant = exchanged.type === "password" ? exchanged.grant : "";
		const install = () =>
			t.action(api.instance.auth.installPassword, {
				boxId,
				grant,
				runtimeAuthHash: HASH
			});
		await install();

		await expect(install()).resolves.toEqual({ accepted: true });
	});

	// The other half of that: a spent grant is not a licence to set some other
	// password later.
	test("refuses to reuse a spent grant for a different password", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedBox(t);
		const { code } = await authorize(t, owner, boxId);
		const exchanged = await exchange(t, boxId, { code });
		const grant = exchanged.type === "password" ? exchanged.grant : "";
		await t.action(api.instance.auth.installPassword, {
			boxId,
			grant,
			runtimeAuthHash: HASH
		});

		await expect(
			t.action(api.instance.auth.installPassword, {
				boxId,
				grant,
				runtimeAuthHash: `${HASH}other`
			})
		).rejects.toThrow("Invalid or expired setup grant.");
	});

	test("refuses a grant presented after its window closed", async () => {
		const t = testConvex();
		const { boxId, owner } = await ownedBox(t);
		const { code } = await authorize(t, owner, boxId);
		const exchanged = await exchange(t, boxId, { code });

		vi.setSystemTime(NOW + 10 * 60 * 1000 + 1);

		await expect(
			t.action(api.instance.auth.installPassword, {
				boxId,
				grant: exchanged.type === "password" ? exchanged.grant : "",
				runtimeAuthHash: HASH
			})
		).rejects.toThrow("Invalid or expired setup grant.");
	});
});

// The other way a cloud box's password changes: the owner changed it on the box
// itself, having proved the current one there, and Convex records what they set.
// It needs no website account, which is the whole point - the account is for
// recovering a password you cannot produce, not for holding one you can.
describe("recording a change made on the box itself", () => {
	const CURRENT = "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$Y3VycmVudA";
	const NEXT = "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$bmV4dA";

	async function boxWithPassword(t: Harness) {
		const owner = await seedUser(t);
		return await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas",
			runtime_auth_hash: CURRENT
		});
	}

	const change = (t: Harness, boxId: Id<"boxes">, args: object = {}) =>
		t.action(api.instance.auth.changePassword, {
			boxId,
			currentRuntimeAuthHash: CURRENT,
			runtimeAuthHash: NEXT,
			...args
		});

	test("records the new hash once the current one is proved", async () => {
		const t = testConvex();
		const boxId = await boxWithPassword(t);

		expect(await change(t, boxId)).toEqual({ accepted: true });
		expect(await readBox(t, boxId)).toMatchObject({
			runtime_auth_hash: NEXT
		});
	});

	// Holding the current hash is the entire proof, so a caller who cannot
	// produce it changes nothing - this endpoint takes no session.
	test("refuses a change that could not produce the current hash", async () => {
		const t = testConvex();
		const boxId = await boxWithPassword(t);

		await expect(
			change(t, boxId, { currentRuntimeAuthHash: NEXT })
		).rejects.toThrow("Current password does not match.");
		expect(await readBox(t, boxId)).toMatchObject({
			runtime_auth_hash: CURRENT
		});
	});

	// Both hashes are checked by shape before anything is looked up: these are
	// arguments an unauthenticated caller controls.
	test.each([
		["the current hash is not argon2id", { currentRuntimeAuthHash: "nope" }],
		["the new hash is not argon2id", { runtimeAuthHash: "nope" }],
		[
			"the new hash is longer than the flow allows",
			{ runtimeAuthHash: `$argon2id$${"x".repeat(512)}` }
		]
	])("refuses a change when %s", async (_name, args) => {
		const t = testConvex();
		const boxId = await boxWithPassword(t);

		await expect(change(t, boxId, args)).rejects.toThrow(
			"Invalid password hash."
		);
		expect(await readBox(t, boxId)).toMatchObject({
			runtime_auth_hash: CURRENT
		});
	});

	// The box already serves the new password; the env file we render still
	// holds the old one. Without this the change works until the next restart
	// and then silently reverts.
	test("schedules the change onto the host", async () => {
		const t = testConvex();
		const boxId = await boxWithPassword(t);

		await change(t, boxId);

		expect(
			await scheduledArgs<{ idempotencyKey: string }>(
				t,
				"instance/auth:reconcilePassword"
			)
		).toMatchObject([{ runtimeAuthHash: NEXT, attempt: 1 }]);
	});

	// Two changes are two reconciliations. Keyed by the box alone they would
	// collapse into one, and the second password would never reach the host.
	test("keeps two changes to the same box apart", async () => {
		const t = testConvex();
		const boxId = await boxWithPassword(t);
		const third = "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$dGhpcmQ";

		await change(t, boxId);
		vi.setSystemTime(NOW + 1000);
		await change(t, boxId, {
			currentRuntimeAuthHash: NEXT,
			runtimeAuthHash: third
		});

		const keys = (
			await scheduledArgs<{ idempotencyKey: string }>(
				t,
				"instance/auth:reconcilePassword"
			)
		).map((args) => args.idempotencyKey);
		expect(new Set(keys).size).toBe(2);
		expect(keys.every((key) => key.includes(boxId))).toBe(true);
	});

	// Re-sending the hash the box already holds is not a change, so it must not
	// schedule a reconciliation of something nothing changed.
	test("does nothing when the password is already the one it holds", async () => {
		const t = testConvex();
		const boxId = await boxWithPassword(t);

		expect(await change(t, boxId, { runtimeAuthHash: CURRENT })).toEqual({
			accepted: true
		});
		expect(await scheduledJobs(t, "instance/auth:reconcilePassword")).toEqual(
			[]
		);
	});
});

// The two windows in this flow, at the instant they close. Each is an
// expires_at compared against now, and an off-by-one at the boundary is a
// capability that outlives the window it was granted for.
describe("the instant a window closes", () => {
	const HASH = "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA";

	test("a code is spent, not honoured, at its expiry", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas"
		});
		await t.run(
			async (ctx) =>
				await ctx.db.insert("box_auth_codes", {
					box_id: boxId,
					code_hash: "hash",
					code_challenge: "challenge",
					redirect_uri: "https://atlas.composery.cloud/callback",
					type: "session",
					expires_at: NOW,
					created_at: NOW - 1000
				})
		);

		await expect(
			t.mutation(internal.instance.auth.exchangeCode, {
				boxId,
				codeHash: "hash",
				codeChallenge: "challenge",
				redirectUri: "https://atlas.composery.cloud/callback",
				type: "session"
			})
		).rejects.toThrow("Invalid or expired authorization code.");
	});

	test("a grant is spent, not honoured, at its expiry", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas"
		});
		await t.run(
			async (ctx) =>
				await ctx.db.insert("box_auth_grants", {
					box_id: boxId,
					token_hash: "grant",
					expires_at: NOW,
					created_at: NOW - 1000
				})
		);

		await expect(
			t.mutation(internal.instance.auth.claimGrantForPassword, {
				boxId,
				grantHash: "grant",
				runtimeAuthHash: HASH
			})
		).rejects.toThrow("Invalid or expired setup grant.");
	});

	// When a grant was spent is a record of when the password was set, and a
	// repeat of the same install must not move it.
	test("a repeated install does not move when the grant was spent", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas"
		});
		await t.run(
			async (ctx) =>
				await ctx.db.insert("box_auth_grants", {
					box_id: boxId,
					token_hash: "grant",
					expires_at: NOW + 60_000,
					created_at: NOW - 1000
				})
		);
		const claim = () =>
			t.mutation(internal.instance.auth.claimGrantForPassword, {
				boxId,
				grantHash: "grant",
				runtimeAuthHash: HASH
			});

		await claim();
		vi.setSystemTime(NOW + 5000);
		await claim();

		expect(
			await t.run((ctx) => ctx.db.query("box_auth_grants").collect())
		).toMatchObject([{ consumed_at: NOW }]);
	});
});

// The reconciliation itself: it hands the host the hash Convex now holds, and
// the operation it starts is what carries that hash to the box.
describe("reconciling a password onto a box", () => {
	const HASH = "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA";

	// The hash itself goes to the workflow rather than onto the row, and a
	// workflow body cannot run in this harness (tests/support/convex.ts records
	// why), so what is assertable here is the operation the reconciliation opens
	// and the key it opens it under.
	test("starts an operation to apply it", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas",
			runtime_auth_hash: HASH
		});

		await t.action(internal.instance.auth.reconcilePassword, {
			boxId,
			idempotencyKey: "password:once",
			runtimeAuthHash: HASH,
			attempt: 1
		});

		expect(await boxOperations(t, boxId)).toMatchObject([
			{
				type: "change_password",
				trigger: "owner",
				idempotency_key: "password:once"
			}
		]);
	});
});

// Reconciliation stops rather than fighting a box whose password moved on
// again: the hash it was told to apply is compared with the one Convex now
// holds, and a retry that lost that race must not overwrite the newer one.
describe("a reconciliation that has been overtaken", () => {
	test("gives up when the box's password changed again", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas",
			runtime_auth_hash: "$argon2id$newer"
		});

		await t.action(internal.instance.auth.reconcilePassword, {
			boxId,
			idempotencyKey: "password:stale",
			runtimeAuthHash: "$argon2id$older",
			attempt: 1
		});

		expect(await boxOperations(t, boxId)).toEqual([]);
	});

	test("gives up on a box that is gone", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas",
			runtime_auth_hash: "$argon2id$hash",
			deleted_at: NOW - 1
		});

		await t.action(internal.instance.auth.reconcilePassword, {
			boxId,
			idempotencyKey: "password:gone",
			runtimeAuthHash: "$argon2id$hash",
			attempt: 1
		});

		expect(await boxOperations(t, boxId)).toEqual([]);
	});
});

// Each grant reconciles under its own key. Two boxes set up at once, or one box
// set up twice, would otherwise open one operation between them and leave the
// other password recorded but never carried to the host.
describe("keeping two setups apart", () => {
	const HASH = "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA";

	test("gives each grant its own reconciliation", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, {
			user_id: owner.clerkUserId,
			slug: "atlas"
		});
		for (const token of ["grant-one", "grant-two"]) {
			await t.run(
				async (ctx) =>
					await ctx.db.insert("box_auth_grants", {
						box_id: boxId,
						token_hash: token,
						expires_at: NOW + 60_000,
						created_at: NOW - 1000
					})
			);
			await t.mutation(internal.instance.auth.claimGrantForPassword, {
				boxId,
				grantHash: token,
				runtimeAuthHash: HASH
			});
		}

		const keys = (
			await scheduledArgs<{ idempotencyKey: string }>(
				t,
				"instance/auth:reconcilePassword"
			)
		).map((args) => args.idempotencyKey);
		expect(keys).toHaveLength(2);
		expect(new Set(keys).size).toBe(2);
		expect(keys.every((key) => key.startsWith("password:"))).toBe(true);
	});
});
