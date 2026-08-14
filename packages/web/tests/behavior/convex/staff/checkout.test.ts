import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";

import {
	seedUser,
	stubDeploymentEnv,
	testConvex,
	type Harness
} from "../../../support/convex.ts";

// These list reservations by recency, so the clock is pinned.
const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	stubDeploymentEnv();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

// Support is given an email address, never a Clerk id, so the one search that
// has to work is the one that starts from an address - and it only works because
// the intent's owner is resolved back to a `users` row on the way.

async function seedIntent(
	t: Harness,
	seed: Partial<Doc<"box_checkout_intents">> & { user_id: string }
) {
	return await t.run(
		async (ctx) =>
			await ctx.db.insert("box_checkout_intents", {
				slug: "reserved",
				plan: "air",
				status: "active",
				created_at: 1,
				updated_at: 1,
				...seed
			})
	);
}

describe("finding an open checkout reservation", () => {
	test("lists every active reservation when nothing is searched for", async () => {
		const t = testConvex();
		const admin = await seedUser(t, { clerkUserId: "admin", role: "admin" });
		await seedIntent(t, { user_id: "someone", slug: "one" });
		await seedIntent(t, {
			user_id: "someone",
			slug: "two",
			status: "released"
		});

		const found = await admin.as.query(
			api.staff.checkout.activeCheckoutIntents,
			{
				query: ""
			}
		);

		expect(found.map((intent) => intent.slug)).toEqual(["one"]);
	});

	// Support is given an address, not a Clerk id, so the reservation has to be
	// findable by the one thing they hold. It is the owner's `users` row that
	// carries the address; the reservation itself only names the Clerk id.
	test("finds a reservation by its owner's email", async () => {
		const t = testConvex();
		const admin = await seedUser(t, { clerkUserId: "admin", role: "admin" });
		const owner = await seedUser(t, {
			clerkUserId: "owner",
			email: "person@example.com"
		});
		await seedIntent(t, { user_id: owner.clerkUserId, slug: "theirs" });

		const found = await admin.as.query(
			api.staff.checkout.activeCheckoutIntents,
			{ query: "  Person@Example.COM " }
		);

		expect(found.map((intent) => intent.slug)).toEqual(["theirs"]);
		expect(found[0].userEmail).toBe("person@example.com");
	});

	test("refuses a customer", async () => {
		const t = testConvex();
		const customer = await seedUser(t);

		await expect(
			customer.as.query(api.staff.checkout.activeCheckoutIntents, {})
		).rejects.toThrow(/Staff access required/);
	});
});

// Finding somebody's stuck checkout, by whatever they can quote.
//
// A customer contacting support has one of four things to hand: the name they
// typed, their email, their account id, or the Polar checkout id off a payment
// page. Each has to find the reservation, because the next thing staff do is
// release it - and a reservation nobody can find is a slug and a fleet slot held
// until it expires on its own.
describe("finding a reservation by what a customer can quote", () => {
	async function cast(t: Harness) {
		const admin = await seedUser(t, {
			clerkUserId: "admin",
			email: "admin@example.com",
			role: "admin"
		});
		const buyer = await seedUser(t, {
			clerkUserId: "buyer",
			email: "buyer@example.com"
		});
		return { admin, buyer };
	}

	async function reservation(t: Harness, over: Record<string, unknown> = {}) {
		return await t.run(
			async (ctx) =>
				await ctx.db.insert("box_checkout_intents", {
					user_id: "buyer",
					slug: "wanted",
					plan: "air",
					status: "active",
					polar_checkout_id: "polar_abc123",
					created_at: NOW - 1000,
					updated_at: NOW - 1000,
					...over
				})
		);
	}

	const search = (
		admin: Awaited<ReturnType<typeof cast>>["admin"],
		query?: string
	) =>
		admin.as.query(
			api.staff.checkout.activeCheckoutIntents,
			query === undefined ? {} : { query }
		);

	test.each([
		["the slug they typed", "wanted"],
		["their email address", "buyer@example.com"],
		["their account id", "buyer"],
		["the Polar checkout id", "polar_abc123"]
	])("finds a reservation by %s", async (_name, query) => {
		const t = testConvex();
		const { admin } = await cast(t);
		const intentId = await reservation(t);

		expect((await search(admin, query)).map((row) => row.id)).toContain(
			intentId
		);
	});

	// A customer will not match the case of what they typed.
	test.each(["WANTED", "  wanted  ", "BUYER@EXAMPLE.COM"])(
		"finds it when quoted as %p",
		async (query) => {
			const t = testConvex();
			const { admin } = await cast(t);
			const intentId = await reservation(t);

			expect((await search(admin, query)).map((row) => row.id)).toContain(
				intentId
			);
		}
	);

	// With nothing typed, the console lists what is open right now, newest
	// first - that is the queue staff work down.
	test("lists open reservations newest first when nothing was typed", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		const older = await reservation(t, {
			slug: "older",
			created_at: NOW - 5000
		});
		const newer = await reservation(t, {
			slug: "newer",
			created_at: NOW - 100
		});

		expect((await search(admin)).map((row) => row.id)).toEqual([newer, older]);
	});

	// Only live holds. One already released holds nothing, and showing it would
	// have staff releasing a reservation twice.
	test.each(["released", "expired", "converted"] as const)(
		"leaves a %s reservation out",
		async (status) => {
			const t = testConvex();
			const { admin } = await cast(t);
			await reservation(t, { status });

			expect(await search(admin)).toEqual([]);
			expect(await search(admin, "wanted")).toEqual([]);
		}
	);

	// The row carries what staff need to act: who it belongs to and where the
	// customer's checkout page is.
	test("carries the owner's email and the checkout link", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		await reservation(t, {
			polar_checkout_url: "https://polar.test/checkout/abc"
		});

		expect(await search(admin)).toMatchObject([
			{
				userId: "buyer",
				userEmail: "buyer@example.com",
				slug: "wanted",
				polarCheckoutUrl: "https://polar.test/checkout/abc"
			}
		]);
	});

	// A reservation whose account row is gone still has to be listed - it is
	// still holding a slug, and staff still need to release it.
	test("lists a reservation whose account row is gone", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		await reservation(t, { user_id: "vanished" });

		expect(await search(admin)).toMatchObject([{ userEmail: "" }]);
	});

	test("finds nothing for a term that matches nothing", async () => {
		const t = testConvex();
		const { admin } = await cast(t);
		await reservation(t);

		expect(await search(admin, "nothing-like-this")).toEqual([]);
	});

	test("refuses the list to somebody who is not staff", async () => {
		const t = testConvex();
		const { buyer } = await cast(t);

		await expect(
			buyer.as.query(api.staff.checkout.activeCheckoutIntents, {})
		).rejects.toThrow("Staff access required.");
	});

	// Releasing is the point of finding it: the slug and the fleet slot come
	// back, and the reason is kept because a released purchase is a thing a
	// customer may ask about later.
	describe("releasing one by hand", () => {
		test("frees the reservation and keeps the reason", async () => {
			const t = testConvex();
			const { admin } = await cast(t);
			const intentId = await reservation(t);

			await admin.as.mutation(api.staff.checkout.releaseCheckoutIntent, {
				intentId,
				reason: "customer asked"
			});

			expect(await t.run((ctx) => ctx.db.get(intentId))).toMatchObject({
				status: "released"
			});
			expect(await search(admin)).toEqual([]);
		});

		// Releasing needs checkout powers, which the console at large does not
		// carry - it moves somebody's purchase.
		test("refuses a caller without checkout powers", async () => {
			const t = testConvex();
			const { buyer } = await cast(t);
			const intentId = await reservation(t);

			await expect(
				buyer.as.mutation(api.staff.checkout.releaseCheckoutIntent, {
					intentId,
					reason: "because"
				})
			).rejects.toThrow("Staff access required.");
			expect(await t.run((ctx) => ctx.db.get(intentId))).toMatchObject({
				status: "active"
			});
		});
	});
});
