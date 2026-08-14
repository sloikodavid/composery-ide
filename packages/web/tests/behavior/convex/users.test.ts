import { ConvexError } from "convex/values";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "@/convex/_generated/api";
import {
	ROLE_CAPABILITIES,
	accountBlock,
	emailFromIdentity,
	requireCapability,
	roleHasCapability,
	rolesWithCapability
} from "@/convex/users";

import {
	seedBox,
	seedUser,
	stubDeploymentEnv,
	testConvex,
	type Harness
} from "../../support/convex.ts";

// Every Convex entry point in this deployment starts by turning a Clerk identity
// into a `users` row and asking what that row may do. These run the real
// mutations and queries against the harness, so what is asserted is the answer a
// caller gets - not the shape of a helper.

afterEach(() => {
	vi.unstubAllEnvs();
});

async function readUser(t: ReturnType<typeof testConvex>, clerkUserId: string) {
	return await t.run(
		async (ctx) =>
			await ctx.db
				.query("users")
				.withIndex("clerk_user_id", (query) =>
					query.eq("clerk_user_id", clerkUserId)
				)
				.first()
	);
}

describe("identity to user record", () => {
	test("creates the caller's user row on first contact", async () => {
		const t = testConvex();

		await t
			.withIdentity({ subject: "clerk_1", email: "first@example.com" })
			.mutation(api.owner.account.ensureCurrentUser, {});

		expect(await readUser(t, "clerk_1")).toMatchObject({
			clerk_user_id: "clerk_1",
			email: "first@example.com",
			role: "user",
			suspended: false
		});
	});

	test("gives a brand-new account no role but `user`", async () => {
		const t = testConvex();
		const as = t.withIdentity({
			subject: "clerk_1",
			email: "first@example.com"
		});

		await as.mutation(api.owner.account.ensureCurrentUser, {});

		expect((await readUser(t, "clerk_1"))?.role).toBe("user");
		expect(await as.query(api.owner.account.canAccessStaffConsole, {})).toBe(
			false
		);
	});

	test("reuses the existing row when the same identity calls again", async () => {
		const t = testConvex();
		const as = t.withIdentity({ subject: "clerk_1", email: "a@example.com" });

		await as.mutation(api.owner.account.ensureCurrentUser, {});
		await as.mutation(api.owner.account.ensureCurrentUser, {});

		const rows = await t.run(
			async (ctx) => await ctx.db.query("users").collect()
		);
		expect(rows).toHaveLength(1);
	});

	test("follows an email change made in Clerk", async () => {
		const t = testConvex();

		await t
			.withIdentity({ subject: "clerk_1", email: "old@example.com" })
			.mutation(api.owner.account.ensureCurrentUser, {});
		await t
			.withIdentity({ subject: "clerk_1", email: "new@example.com" })
			.mutation(api.owner.account.ensureCurrentUser, {});

		const rows = await t.run(
			async (ctx) => await ctx.db.query("users").collect()
		);
		expect(rows.map((row) => row.email)).toEqual(["new@example.com"]);
	});

	// The row carries the role, and `ensureCurrentUser` runs on every page load.
	// If it rebuilt the row rather than patching it, every staff member would be
	// demoted by visiting the site.
	test("leaves an existing role alone when the row is refreshed", async () => {
		const t = testConvex();
		const admin = await seedUser(t, {
			clerkUserId: "clerk_admin",
			role: "admin"
		});

		await admin.as.mutation(api.owner.account.ensureCurrentUser, {});

		expect((await readUser(t, "clerk_admin"))?.role).toBe("admin");
	});

	test("refuses an unauthenticated caller", async () => {
		const t = testConvex();

		await expect(
			t.mutation(api.owner.account.ensureCurrentUser, {})
		).rejects.toThrow(/Authentication required/);
	});

	// Clerk only puts `email` in the session token once someone customises it, so
	// this fires on a fresh deployment and the message has to say where to go.
	test("names the Clerk setting when the token carries no email claim", () => {
		expect(() =>
			emailFromIdentity({ subject: "clerk_1" } as never)
		).toThrowError(ConvexError);
		try {
			emailFromIdentity({ subject: "clerk_1" } as never);
		} catch (error) {
			expect(String((error as ConvexError<string>).data)).toContain(
				"Customize session token"
			);
		}
	});
});

// One gate, two conditions, and the same words wherever a caller meets it.
describe("an account that may not act", () => {
	test("says nothing about an ordinary account", () => {
		expect(
			accountBlock({
				deletion_finished_at: undefined,
				deletion_pending: undefined,
				suspended: false,
				suspended_reason: undefined
			})
		).toBeNull();
	});

	test("forwards a suspension reason and falls back to support when there is none", () => {
		const withReason = accountBlock({
			deletion_finished_at: undefined,
			deletion_pending: undefined,
			suspended: true,
			suspended_reason: "abuse"
		});
		expect(withReason).toMatchObject({
			kind: "account_unavailable",
			title: "Your account is suspended",
			detail: "abuse"
		});

		const withoutReason = accountBlock({
			deletion_finished_at: undefined,
			deletion_pending: undefined,
			suspended: true,
			suspended_reason: "   "
		});
		expect(withoutReason?.detail).toContain("Contact support");
	});

	// A deletion outranks a suspension: the account is being torn down, so
	// "contact support to have this reviewed" would be the wrong offer.
	test("reports a pending deletion rather than the suspension it sets", () => {
		expect(
			accountBlock({
				deletion_finished_at: undefined,
				deletion_pending: true,
				suspended: true,
				suspended_reason: "abuse"
			})?.title
		).toBe("This account is being deleted");
	});

	test("refuses a suspended account a write path, and says why", async () => {
		const t = testConvex();
		stubDeploymentEnv();
		const user = await seedUser(t, {
			suspended: true,
			suspendedReason: "abuse"
		});
		await seedBox(t, { user_id: user.clerkUserId, slug: "box" });

		await expect(
			user.as.mutation(api.owner.boxes.stop, { slug: "box" })
		).rejects.toMatchObject({
			data: { kind: "account_unavailable", detail: "abuse" }
		});
	});

	// The gap this closes: `deletion_pending` was checked by checkout alone, so an
	// account whose deletion was in flight could still start, stop, reset and
	// rename the very boxes that deletion was tearing down.
	test("refuses a box action while the account is being deleted", async () => {
		const t = testConvex();
		stubDeploymentEnv();
		const user = await seedUser(t, { deletionPending: true });
		await seedBox(t, { user_id: user.clerkUserId, slug: "box" });

		await expect(
			user.as.mutation(api.owner.boxes.start, { slug: "box" })
		).rejects.toMatchObject({
			data: { title: "This account is being deleted" }
		});
	});

	test("refuses checkout while the account is being deleted", async () => {
		const t = testConvex();
		stubDeploymentEnv();
		const user = await seedUser(t, { deletionPending: true });

		await expect(
			user.as.action(api.owner.checkout.createCheckout, {
				billingInterval: "month",
				plan: "air",
				slug: "another-box"
			})
		).rejects.toMatchObject({
			data: { title: "This account is being deleted" }
		});
	});

	// Reads are gated too, and by the same helper. The configuration page asked
	// only "are you signed in", so a suspended owner still read their box's
	// environment back.
	test("refuses a suspended account every owner-facing read", async () => {
		const t = testConvex();
		stubDeploymentEnv();
		const user = await seedUser(t, { suspended: true });
		await seedBox(t, { user_id: user.clerkUserId, slug: "box" });

		await expect(
			user.as.query(api.owner.boxes.list, {
				paginationOpts: { cursor: null, numItems: 10 }
			})
		).rejects.toThrow(/suspended/i);
		await expect(
			user.as.query(api.owner.boxConfig.get, { slug: "box" })
		).rejects.toThrow(/suspended/i);
	});

	test("shuts a suspended admin out of the console", async () => {
		const t = testConvex();
		const admin = await seedUser(t, { role: "admin", suspended: true });

		expect(
			await admin.as.query(api.owner.account.canAccessStaffConsole, {})
		).toBe(false);
		await expect(admin.as.query(api.staff.boxes.search, {})).rejects.toThrow(
			/Staff access required/
		);
	});

	// The staff powers of an account being deleted go with it, without waiting
	// for the finalizer to demote the row.
	test("shuts an admin being deleted out of the console", async () => {
		const t = testConvex();
		const admin = await seedUser(t, { role: "admin", deletionPending: true });

		expect(
			await admin.as.query(api.owner.account.canAccessStaffConsole, {})
		).toBe(false);
	});

	// `ensureCurrentUser` is the one write path a blocked account still reaches,
	// because it is what the app calls before it knows the account is blocked.
	// It must not clear the flag.
	test("keeps the suspension when a suspended account refreshes its row", async () => {
		const t = testConvex();
		const user = await seedUser(t, {
			suspended: true,
			suspendedReason: "abuse"
		});

		await user.as.mutation(api.owner.account.ensureCurrentUser, {});

		expect(await readUser(t, user.clerkUserId)).toMatchObject({
			suspended: true,
			suspended_reason: "abuse"
		});
	});

	// Actions re-read the account through an internal query rather than `db`, and
	// that second path used to answer with a wording of its own ("Account is
	// suspended or not initialized") that conflated two different facts.
	test("refuses a blocked account through an action, in the same words", async () => {
		const t = testConvex();
		stubDeploymentEnv();
		const user = await seedUser(t, {
			suspended: true,
			suspendedReason: "abuse"
		});
		const boxId = await seedBox(t, { user_id: user.clerkUserId });

		await expect(
			user.as.action(api.instance.auth.createAuthorizationCode, {
				boxId,
				codeChallenge: "a".repeat(43),
				redirectUri: "https://box.dev.composery.cloud/ide/",
				type: "password"
			})
		).rejects.toMatchObject({
			data: { kind: "account_unavailable", detail: "abuse" }
		});
	});

	test("tells an action caller with no row that the account is not set up", async () => {
		const t = testConvex();
		stubDeploymentEnv();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, { user_id: owner.clerkUserId });

		await expect(
			t
				.withIdentity({ subject: "ghost", email: "ghost@example.com" })
				.action(api.instance.auth.createAuthorizationCode, {
					boxId,
					codeChallenge: "a".repeat(43),
					redirectUri: "https://box.dev.composery.cloud/ide/",
					type: "password"
				})
		).rejects.toThrow(/not initialized/);
	});

	test("hands the action side the same row a query would read", async () => {
		const t = testConvex();
		const user = await seedUser(t, { suspended: true });

		expect(
			await t.query(internal.users.userByClerkId, {
				clerkUserId: user.clerkUserId
			})
		).toMatchObject({ suspended: true });
	});
});

describe("role capabilities", () => {
	test("gives customers no staff powers", () => {
		expect(ROLE_CAPABILITIES.user).toEqual([]);
		expect(roleHasCapability("user", "staff_console")).toBe(false);
	});

	test("makes the current admin role explicitly fully privileged", () => {
		expect(roleHasCapability("admin", "staff_console")).toBe(true);
		expect(roleHasCapability("admin", "box_operations")).toBe(true);
		expect(roleHasCapability("admin", "user_moderation")).toBe(true);
		expect(roleHasCapability("admin", "settings_management")).toBe(true);
		expect(roleHasCapability("admin", "checkout_management")).toBe(true);
		expect(roleHasCapability("admin", "staff_alerts")).toBe(true);
	});

	test("derives alert recipients from explicit role capabilities", () => {
		expect(rolesWithCapability("staff_alerts")).toEqual(["admin"]);
	});

	test("refuses a customer a staff-gated query", async () => {
		const t = testConvex();
		const user = await seedUser(t);

		await expect(user.as.query(api.staff.boxes.search, {})).rejects.toThrow(
			/Staff access required/
		);
	});

	test("admits an admin to the same query", async () => {
		const t = testConvex();
		const admin = await seedUser(t, { role: "admin" });

		expect(await admin.as.query(api.staff.boxes.search, {})).toEqual([]);
	});

	test("refuses an authenticated caller with no user row at all", async () => {
		const t = testConvex();

		await expect(
			t
				.withIdentity({ subject: "ghost", email: "ghost@example.com" })
				.query(api.staff.boxes.search, {})
		).rejects.toThrow(/Staff access required/);
	});

	// Capabilities are per-power, not one staff bit: a query gated on
	// `staff_console` and a mutation gated on `box_operations` are separate asks,
	// and `requireCapability` has to check the one it was given.
	test("checks the capability it was asked about, not staff membership", async () => {
		const t = testConvex();
		const user = await seedUser(t);

		const denied = await t.run(async (ctx) => {
			try {
				await requireCapability(
					{ auth: fakeAuth(user.clerkUserId), db: ctx.db },
					"box_comp"
				);
				return false;
			} catch {
				return true;
			}
		});
		expect(denied).toBe(true);
	});

	test("refuses a staff-gated action to a customer", async () => {
		const t = testConvex();
		const user = await seedUser(t);
		const boxId = await seedBox(t, { user_id: user.clerkUserId });

		await expect(
			user.as.action(api.staff.boxes.repair, { boxId })
		).rejects.toThrow(/Staff access required/);
	});

	test("refuses a staff-gated action to an anonymous caller", async () => {
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, { user_id: owner.clerkUserId });

		await expect(t.action(api.staff.boxes.repair, { boxId })).rejects.toThrow(
			/Staff access required/
		);
	});
});

// `t.run` gives a mutation ctx with no identity attached, which is exactly what
// these two helpers need supplied - they take `{ auth, db }` rather than a whole
// ctx precisely so a caller can be named.
function fakeAuth(subject: string) {
	return {
		getUserIdentity: async () => ({
			subject,
			issuer: "https://clerk.test",
			tokenIdentifier: `https://clerk.test|${subject}`
		})
	} as never;
}

// An address that changed at Clerk.
//
// Clerk owns the address; this row is a copy kept so the backend can send mail
// and so staff can find an account by what a customer quotes. A copy that stops
// following its source is the worst kind: every page still renders, and the only
// symptom is receipts going to an address the customer no longer reads.
describe("following an account's address when it changes", () => {
	const sync = (t: Harness, clerkUserId: string, email: string) =>
		t.mutation(internal.users.ensureUserForIdentity, { clerkUserId, email });

	test("moves the address on the same row", async () => {
		const t = testConvex();
		await sync(t, "clerk_1", "old@example.com");

		await sync(t, "clerk_1", "new@example.com");

		const rows = await t.run(
			async (ctx) => await ctx.db.query("users").collect()
		);
		expect(rows).toMatchObject([{ email: "new@example.com" }]);
	});

	// The row is the account, so nothing else about it may move with the address
	// - least of all the role or a suspension somebody set deliberately.
	test("keeps the role and the suspension the row already had", async () => {
		const t = testConvex();
		await sync(t, "clerk_1", "old@example.com");
		await t.run(async (ctx) => {
			const row = await ctx.db.query("users").first();
			await ctx.db.patch(row!._id, {
				role: "admin",
				suspended: true,
				suspended_reason: "abuse"
			});
		});

		await sync(t, "clerk_1", "new@example.com");

		expect(await readUser(t, "clerk_1")).toMatchObject({
			email: "new@example.com",
			role: "admin",
			suspended: true,
			suspended_reason: "abuse"
		});
	});

	// Staff search by address, so the new one has to be findable and the old one
	// must not still answer - support acting on a stale hit would be looking at
	// somebody else's account.
	test("makes the new address the one that finds the account", async () => {
		const t = testConvex();
		await sync(t, "clerk_1", "old@example.com");

		await sync(t, "clerk_1", "new@example.com");

		const byOld = await t.run(
			async (ctx) =>
				await ctx.db
					.query("users")
					.withIndex("email", (query) => query.eq("email", "old@example.com"))
					.first()
		);
		expect(byOld).toBeNull();
	});

	test("leaves the row alone when the address has not changed", async () => {
		const t = testConvex();
		await sync(t, "clerk_1", "same@example.com");
		const before = await readUser(t, "clerk_1");

		await sync(t, "clerk_1", "same@example.com");

		expect(await readUser(t, "clerk_1")).toEqual(before);
	});

	// Two accounts are two rows even when one takes an address the other used to
	// hold - which is what happens when somebody moves an address between their
	// own accounts.
	test("gives a second account its own row", async () => {
		const t = testConvex();
		await sync(t, "clerk_1", "shared@example.com");
		await sync(t, "clerk_1", "moved@example.com");

		await sync(t, "clerk_2", "shared@example.com");

		const rows = await t.run(
			async (ctx) => await ctx.db.query("users").collect()
		);
		expect(rows).toHaveLength(2);
		expect(await readUser(t, "clerk_2")).toMatchObject({
			email: "shared@example.com"
		});
	});
});

// Whether the console is offered at all.
//
// This is the only question the nav link and the page's server guard ask, and it
// answers `false` rather than throwing because "you are an ordinary customer" is
// the ordinary case here. Every endpoint behind the console still checks the
// capability it needs, so a wrong answer here shows a link that leads to
// refusals - but a wrong answer the other way hides the console from the people
// who run the deployment.
describe("whether to offer the console", () => {
	test("says no to nobody at all", async () => {
		const t = testConvex();

		expect(await t.query(api.owner.account.canAccessStaffConsole, {})).toBe(
			false
		);
	});

	// Signed in with no row yet: the first page load can race the mutation that
	// creates it, and the answer has to be "no" rather than a crash.
	test("says no to an identity with no account row", async () => {
		const t = testConvex();

		expect(
			await t
				.withIdentity({ subject: "clerk_unknown" })
				.query(api.owner.account.canAccessStaffConsole, {})
		).toBe(false);
	});

	// Asked of every role there is, against that role's own capability list.
	//
	// Today the two roles hold everything and nothing, so this cannot tell
	// "console access" apart from "any staff power at all" - and it is written
	// against the capability rather than the role name so that it starts telling
	// them apart by itself on the day a role holds some powers but not this one.
	test.each(
		Object.keys(ROLE_CAPABILITIES) as (keyof typeof ROLE_CAPABILITIES)[]
	)("answers a %s by that role's own capabilities", async (role) => {
		const t = testConvex();
		await t.run(
			async (ctx) =>
				await ctx.db.insert("users", {
					clerk_user_id: "clerk_1",
					email: "person@example.com",
					role,
					suspended: false,
					created_at: 1,
					updated_at: 1
				})
		);

		expect(
			await t
				.withIdentity({ subject: "clerk_1" })
				.query(api.owner.account.canAccessStaffConsole, {})
		).toBe(
			(ROLE_CAPABILITIES[role] as readonly string[]).includes("staff_console")
		);
	});
});

// What an account is told when it is on its way out.
//
// The block is returned instead of every ordinary answer, so its words are the
// entire explanation somebody gets for a page that has stopped working. "Being
// deleted" and "suspended" are different situations with different remedies, and
// telling one as the other sends the reader to support for something they cannot
// be helped with.
describe("telling an account why it cannot act", () => {
	const block = (over: Record<string, unknown>) =>
		accountBlock({
			deletion_pending: false,
			deletion_finished_at: undefined,
			suspended: false,
			suspended_reason: undefined,
			...over
		} as Parameters<typeof accountBlock>[0]);

	test("says nothing about an ordinary account", () => {
		expect(block({})).toBeNull();
	});

	// Both halves of a deletion block: the moment it is asked for, and after it
	// has finished. The second matters because the row outlives the boxes.
	test.each([
		["asked for", { deletion_pending: true }],
		["already finished", { deletion_finished_at: 1 }]
	])("explains a deletion %s", (_name, over) => {
		const answer = block(over);

		expect(answer).toMatchObject({
			kind: "account_unavailable",
			title: "This account is being deleted"
		});
		// Names the consequence, because "account unavailable" alone reads as a
		// fault the reader should report rather than something they asked for.
		expect(answer?.detail).toContain("removes every box");
	});

	// A deletion in flight outranks a suspension: it is the one that is about to
	// destroy data, and it is the one the reader can no longer undo.
	test("reports a deletion ahead of a suspension", () => {
		expect(block({ deletion_pending: true, suspended: true })).toMatchObject({
			kind: "account_unavailable"
		});
	});
});
