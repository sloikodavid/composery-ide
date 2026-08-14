import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Polar is the one thing here that cannot be exercised: `createCheckout` opens a
// real hosted checkout session. Stubbing the module rather than `fetch` keeps the
// test about what this action decides - which plan and interval it sells, what it
// reserves, what it carries into the order - instead of about Polar's wire
// format, which is Polar's to change.
//
// The stub keeps the two Polar rules this action is built around, because a stub
// without them cannot fail for the reason production did. `selectPolarCheckoutProduct`
// used to be a bare `vi.fn()`, which accepted every product and made "reopen the
// same slug on the other plan" pass here while answering 422 to customers:
//
//   - `PATCH /v1/checkouts/{id}` refuses a `product_id` that is not already in
//     that session's product list.
//   - a session's product list is fixed at creation - `CheckoutUpdate` carries no
//     `products` field - so nothing can widen it afterwards.
const { polar } = vi.hoisted(() => ({
	polar: {
		nextId: 0,
		sessions: new Map<string, { productIds: string[]; selected: string }>()
	}
}));

const createCheckoutSession = vi.fn();
const selectPolarCheckoutProduct = vi.fn();

function openSession(_ctx: unknown, args: { productIds: string[] }) {
	polar.nextId += 1;
	const id = `checkout_${polar.nextId}`;
	polar.sessions.set(id, {
		productIds: [...args.productIds],
		selected: args.productIds[0] ?? ""
	});
	return Promise.resolve({
		customerId: "cus_1",
		expiresAt: new Date(NOW + 60_000),
		id,
		status: "open",
		url: `https://polar.test/${id}`
	});
}

function selectProduct(checkoutId: string, productId: string) {
	const session = polar.sessions.get(checkoutId);
	if (!session) {
		throw new Error(
			`Polar API PATCH /v1/checkouts/${checkoutId} failed: 404 {"error":"ResourceNotFound"}`
		);
	}
	if (!session.productIds.includes(productId)) {
		throw new Error(
			`Polar API PATCH /v1/checkouts/${checkoutId} failed: 422 {"error":"PolarRequestValidationError","detail":[{"msg":"Product is not available in this checkout."}]}`
		);
	}
	session.selected = productId;
	return Promise.resolve();
}

vi.mock("@/convex/billing/polar", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/convex/billing/polar")>();
	return {
		...actual,
		polarServer: () => ({ createCheckoutSession }),
		selectPolarCheckoutProduct
	};
});

import type { Caller } from "../../../support/convex.ts";

const { api } = await import("@/convex/_generated/api");
const { seedBox, seedSettings, seedUser, stubDeploymentEnv, testConvex } =
	await import("../../../support/convex.ts");
type Harness = ReturnType<typeof testConvex>;

const NOW = Date.UTC(2026, 6, 28, 10, 0, 0);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	stubDeploymentEnv();
	polar.nextId = 0;
	polar.sessions.clear();
	createCheckoutSession.mockReset();
	createCheckoutSession.mockImplementation(openSession);
	selectPolarCheckoutProduct.mockReset();
	selectPolarCheckoutProduct.mockImplementation(selectProduct);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("opening a checkout", () => {
	test("reserves the slug for the plan being bought", async () => {
		const t = testConvex();
		await seedSettings(t);
		const user = await seedUser(t);

		const result = await user.as.action(api.owner.checkout.createCheckout, {
			billingInterval: "year",
			plan: "pro",
			slug: "my-box"
		});

		expect(result).toMatchObject({ slug: "my-box" });
		const intent = await t.run(
			async (ctx) => await ctx.db.query("box_checkout_intents").first()
		);
		expect(intent).toMatchObject({
			plan: "pro",
			slug: "my-box",
			status: "active",
			polar_checkout_id: "checkout_1"
		});
	});

	// Every product this deployment sells reaches Polar, the chosen one first.
	// Polar fixes this list for the life of the session, and one reservation is
	// held per slug across both pricing cards, so a narrower list is a decision
	// that can never be revised for a reservation that outlives it.
	test("offers every product it sells, the chosen one first", async () => {
		const t = testConvex();
		await seedSettings(t);
		const user = await seedUser(t);

		await user.as.action(api.owner.checkout.createCheckout, {
			billingInterval: "month",
			plan: "air",
			slug: "my-box"
		});

		const { productIds } = createCheckoutSession.mock.calls[0]?.[1] as {
			productIds: string[];
		};
		expect(productIds[0]).toBe("air-monthly");
		expect([...productIds].sort()).toEqual([
			"air-annual",
			"air-monthly",
			"pro-annual",
			"pro-monthly"
		]);
	});

	test("refuses a slug that is not available", async () => {
		const t = testConvex();
		await seedSettings(t);
		const owner = await seedUser(t);
		const other = await seedUser(t, {
			clerkUserId: "other",
			email: "other@example.com"
		});
		await t.run(async (ctx) => {
			await ctx.db.insert("boxes", {
				user_id: other.clerkUserId,
				slug: "my-box",
				plan: "air",
				manual_snapshot_cap: 0,
				status: "running",
				created_at: NOW - 1000,
				updated_at: NOW - 1000
			});
		});

		await expect(
			owner.as.action(api.owner.checkout.createCheckout, {
				billingInterval: "month",
				plan: "air",
				slug: "my-box"
			})
		).rejects.toThrow(/unavailable/i);
		expect(createCheckoutSession).not.toHaveBeenCalled();
	});

	// The reservation is the customer's own, so it can never read as "taken" to
	// them. A row left behind by an action that died between reserving and
	// attaching is invisible to every "do I have a live checkout" question, and
	// used to make the owner's next attempt fail on their own slug until the
	// grace expired - with the availability query still calling it available.
	test("resumes a reservation whose Polar session was never attached", async () => {
		const t = testConvex();
		await seedSettings(t);
		const user = await seedUser(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("box_checkout_intents", {
				user_id: user.clerkUserId,
				slug: "my-box",
				plan: "air",
				status: "active",
				created_at: NOW - 1000,
				updated_at: NOW - 1000
			});
		});

		const result = await user.as.action(api.owner.checkout.createCheckout, {
			billingInterval: "month",
			plan: "air",
			slug: "my-box"
		});

		expect(result).toMatchObject({
			checkoutUrl: "https://polar.test/checkout_1"
		});
		const intents = await t.run(
			async (ctx) => await ctx.db.query("box_checkout_intents").collect()
		);
		expect(intents).toHaveLength(1);
		expect(intents[0]).toMatchObject({
			status: "active",
			polar_checkout_id: "checkout_1"
		});
	});

	// The same reservation, reopened from the other pricing card. The row's plan
	// has to follow, because it is what capacity admission reserved against.
	//
	// This is the case that answered 422 to customers: one reservation is held per
	// slug, so reopening it on the other plan repointed a session that had only
	// ever been offered the first plan's products. The same slug worked on the
	// plan it was opened with, and any other slug worked on any plan, which is
	// what made it read as a slug problem.
	test("moves an existing reservation onto the plan being reopened", async () => {
		const t = testConvex();
		await seedSettings(t);
		const user = await seedUser(t);

		await user.as.action(api.owner.checkout.createCheckout, {
			billingInterval: "month",
			plan: "air",
			slug: "my-box"
		});
		await user.as.action(api.owner.checkout.createCheckout, {
			billingInterval: "year",
			plan: "pro",
			slug: "my-box"
		});

		const intents = await t.run(
			async (ctx) => await ctx.db.query("box_checkout_intents").collect()
		);
		expect(intents).toHaveLength(1);
		expect(intents[0]).toMatchObject({ plan: "pro", status: "active" });
		// One Polar session, repointed rather than replaced, and now selling the
		// plan that was reopened.
		expect(createCheckoutSession).toHaveBeenCalledTimes(1);
		expect(polar.sessions.get("checkout_1")?.selected).toBe("pro-annual");
	});

	// Both axes, in both directions, on one reservation. A session outlives every
	// selection made against it, so no order of switching may leave one unsellable.
	test.each([
		[{ billingInterval: "year", plan: "air" }, "air-annual"],
		[{ billingInterval: "month", plan: "pro" }, "pro-monthly"],
		[{ billingInterval: "year", plan: "pro" }, "pro-annual"],
		[{ billingInterval: "month", plan: "air" }, "air-monthly"]
	] as const)("reopens a reservation as %o", async (sellable, productId) => {
		const t = testConvex();
		await seedSettings(t);
		const user = await seedUser(t);

		await user.as.action(api.owner.checkout.createCheckout, {
			billingInterval: "month",
			plan: "air",
			slug: "my-box"
		});
		const result = await user.as.action(api.owner.checkout.createCheckout, {
			...sellable,
			slug: "my-box"
		});

		expect(result.checkoutUrl).toBe("https://polar.test/checkout_1");
		expect(polar.sessions.get("checkout_1")?.selected).toBe(productId);
		const intent = await t.run(
			async (ctx) => await ctx.db.query("box_checkout_intents").first()
		);
		expect(intent).toMatchObject({ plan: sellable.plan, status: "active" });
	});

	// A Polar session past its expiry cannot be updated and cannot be paid, so
	// resuming it would send the customer to a dead page. The reservation keeps
	// its slug and gets a session that works.
	//
	// The instant of expiry counts as expired, which is the same boundary the
	// sweep reads (`lte`) - a reservation must not be resumable here and expired
	// there.
	test.each([NOW - 1, NOW])(
		"replaces a reservation's Polar session expiring at %i",
		async (expiresAt) => {
			const t = testConvex();
			await seedSettings(t);
			const user = await seedUser(t);
			await t.run(async (ctx) => {
				await ctx.db.insert("box_checkout_intents", {
					user_id: user.clerkUserId,
					slug: "my-box",
					plan: "air",
					status: "active",
					polar_checkout_id: "checkout_gone",
					polar_checkout_url: "https://polar.test/checkout_gone",
					polar_checkout_expires_at: expiresAt,
					created_at: NOW - 1000,
					updated_at: NOW - 1000
				});
			});

			const result = await user.as.action(api.owner.checkout.createCheckout, {
				billingInterval: "month",
				plan: "pro",
				slug: "my-box"
			});

			expect(result.checkoutUrl).toBe("https://polar.test/checkout_1");
			expect(selectPolarCheckoutProduct).not.toHaveBeenCalled();
			const intents = await t.run(
				async (ctx) => await ctx.db.query("box_checkout_intents").collect()
			);
			expect(intents).toHaveLength(1);
			expect(intents[0]).toMatchObject({
				plan: "pro",
				polar_checkout_id: "checkout_1",
				status: "active"
			});
		}
	);

	// The customer has already been charged and the order webhook is on its way.
	// A second session against the same reservation is a second charge for one
	// slug, so this is the one resumption that is refused.
	test("refuses to reopen a reservation that has already been paid", async () => {
		const t = testConvex();
		await seedSettings(t);
		const user = await seedUser(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("box_checkout_intents", {
				user_id: user.clerkUserId,
				slug: "my-box",
				plan: "air",
				status: "active",
				polar_checkout_id: "checkout_paid",
				polar_checkout_url: "https://polar.test/checkout_paid",
				polar_checkout_expires_at: NOW + 60_000,
				polar_initial_order_id: "order_1",
				created_at: NOW - 1000,
				updated_at: NOW - 1000
			});
		});

		await expect(
			user.as.action(api.owner.checkout.createCheckout, {
				billingInterval: "month",
				plan: "pro",
				slug: "my-box"
			})
		).rejects.toThrow(/already paid/i);
		expect(createCheckoutSession).not.toHaveBeenCalled();
	});

	// The reservation's plan is what capacity admission counts snapshot slots
	// against, so it may only move once Polar holds the matching selection. It
	// used to be written first, which left the row naming a plan its live session
	// could not sell and no rollback on the resume path to undo it.
	test("leaves the reservation's plan alone when Polar refuses the selection", async () => {
		const t = testConvex();
		await seedSettings(t);
		const user = await seedUser(t);
		await user.as.action(api.owner.checkout.createCheckout, {
			billingInterval: "month",
			plan: "air",
			slug: "my-box"
		});
		selectPolarCheckoutProduct.mockRejectedValue(new Error("Polar is down"));

		await expect(
			user.as.action(api.owner.checkout.createCheckout, {
				billingInterval: "year",
				plan: "pro",
				slug: "my-box"
			})
		).rejects.toThrow(/could not be reopened/i);

		const intent = await t.run(
			async (ctx) => await ctx.db.query("box_checkout_intents").first()
		);
		// Still holding its slug against a session that is still payable.
		expect(intent).toMatchObject({
			plan: "air",
			polar_checkout_id: "checkout_1",
			status: "active"
		});
	});

	// A reservation that could not be paired with a Polar session must not keep
	// holding the slug and a capacity slot for an hour.
	test("releases the reservation when Polar cannot open a session", async () => {
		const t = testConvex();
		await seedSettings(t);
		const user = await seedUser(t);
		createCheckoutSession.mockRejectedValue(new Error("Polar is down"));

		await expect(
			user.as.action(api.owner.checkout.createCheckout, {
				billingInterval: "month",
				plan: "air",
				slug: "my-box"
			})
		).rejects.toThrow("Polar is down");

		const intent = await t.run(
			async (ctx) => await ctx.db.query("box_checkout_intents").first()
		);
		expect(intent).toMatchObject({
			status: "released",
			release_reason: "polar_checkout_creation_failed"
		});
	});
});

// The page a customer lands on coming back from Polar reads this, and it is the
// only thing that can tell them a completed payment was handed back.
describe("reporting a finished checkout to its customer", () => {
	async function outcomeFor(
		t: ReturnType<typeof testConvex>,
		user: Awaited<ReturnType<typeof seedUser>>,
		intent: Record<string, unknown>
	) {
		await t.run(async (ctx) => {
			await ctx.db.insert("box_checkout_intents", {
				user_id: user.clerkUserId,
				slug: "my-box",
				plan: "air",
				status: "active",
				polar_checkout_id: "checkout_1",
				created_at: NOW - 1000,
				updated_at: NOW - 1000,
				...intent
			});
		});
		return await user.as.query(api.owner.checkout.completedCheckout, {
			checkoutId: "checkout_1"
		});
	}

	test("reports a checkout still being paid as pending", async () => {
		const t = testConvex();
		const user = await seedUser(t);

		expect(await outcomeFor(t, user, {})).toMatchObject({
			boxId: null,
			outcome: "pending"
		});
	});

	// Paid - Polar gave us the order id - and released without a box. The
	// customer's money is on its way back and nothing else on the page says so.
	test("reports a paid checkout that fulfillment refused as refunded", async () => {
		const t = testConvex();
		const user = await seedUser(t);

		expect(
			await outcomeFor(t, user, {
				polar_initial_order_id: "order_1",
				release_reason: "slug_conflict",
				status: "released"
			})
		).toMatchObject({ boxId: null, outcome: "refunded" });
	});

	// An unpaid reservation that simply lapsed took no money, so it is not a
	// refund and must not be announced as one.
	test("reports an unpaid reservation that lapsed as pending", async () => {
		const t = testConvex();
		const user = await seedUser(t);

		expect(
			await outcomeFor(t, user, {
				release_reason: "checkout_expired",
				status: "expired"
			})
		).toMatchObject({ outcome: "pending" });
	});

	// One customer's checkout is not another's to read.
	test("tells a different user nothing about it", async () => {
		const t = testConvex();
		const user = await seedUser(t);
		await outcomeFor(t, user, {});
		const other = await seedUser(t, {
			clerkUserId: "other",
			email: "other@example.com"
		});

		expect(
			await other.as.query(api.owner.checkout.completedCheckout, {
				checkoutId: "checkout_1"
			})
		).toBeNull();
	});
});

// Whether a name is free, asked before anybody pays for it.
//
// This is the only thing standing between two customers buying the same name,
// and it is asked from the pricing page while somebody is typing. Both answers
// are load-bearing in different directions: a false "taken" loses a sale, and a
// false "available" takes money for a name that cannot be delivered - which then
// has to be refunded.
describe("telling a customer whether a name is free", () => {
	const availability = (as: Caller, slug: string) =>
		as.query(api.owner.checkout.slugAvailability, { slug });

	async function buyer(t: Harness) {
		return await seedUser(t, { clerkUserId: "buyer" });
	}

	test("says a name nobody holds is free", async () => {
		const t = testConvex();
		const me = await buyer(t);

		expect(await availability(me.as, "wanted")).toMatchObject({
			available: true,
			resumable: false,
			slug: "wanted"
		});
	});

	// The answer carries the normalised name, so the client reserves and buys the
	// same string it was told about rather than what was typed.
	test.each([
		["WANTED", "wanted"],
		["  wanted  ", "wanted"]
	])("normalises %p to %p in its answer", async (typed, slug) => {
		const t = testConvex();
		const me = await buyer(t);

		expect(await availability(me.as, typed)).toMatchObject({ slug });
	});

	test("says a name an existing box holds is taken", async () => {
		const t = testConvex();
		const me = await buyer(t);
		await seedBox(t, { user_id: me.clerkUserId, slug: "wanted" });

		expect(await availability(me.as, "wanted")).toMatchObject({
			available: false
		});
	});

	// Somebody else mid-checkout holds the name for the length of their session.
	test("says a name another customer is buying is taken", async () => {
		const t = testConvex();
		const me = await buyer(t);
		await seedUser(t, { clerkUserId: "other", email: "other@example.com" });
		await t.run(
			async (ctx) =>
				await ctx.db.insert("box_checkout_intents", {
					user_id: "other",
					slug: "wanted",
					plan: "air",
					status: "active",
					created_at: 1,
					updated_at: 1
				})
		);

		expect(await availability(me.as, "wanted")).toMatchObject({
			available: false
		});
	});

	// The caller's own reservation is not "taken" from their point of view -
	// otherwise pressing Continue would flip the name to unavailable underneath
	// them, and a returning customer could never resume.
	test("does not call a customer's own reservation taken", async () => {
		const t = testConvex();
		const me = await buyer(t);
		await t.run(
			async (ctx) =>
				await ctx.db.insert("box_checkout_intents", {
					user_id: me.clerkUserId,
					slug: "wanted",
					plan: "air",
					status: "active",
					created_at: 1,
					updated_at: 1
				})
		);

		expect(await availability(me.as, "wanted")).toMatchObject({
			available: true
		});
	});

	// Resumable is what puts "continue where you left off" on the page, and it
	// needs a checkout URL to send them to - a reservation without one is not
	// something to resume.
	test("offers to resume only once there is a checkout to return to", async () => {
		const t = testConvex();
		const me = await buyer(t);
		const intentId = await t.run(
			async (ctx) =>
				await ctx.db.insert("box_checkout_intents", {
					user_id: me.clerkUserId,
					slug: "wanted",
					plan: "air",
					status: "active",
					created_at: 1,
					updated_at: 1
				})
		);

		expect(await availability(me.as, "wanted")).toMatchObject({
			resumable: false
		});

		await t.run(
			async (ctx) =>
				await ctx.db.patch(intentId, {
					polar_checkout_url: "https://polar.test/checkout/abc"
				})
		);

		expect(await availability(me.as, "wanted")).toMatchObject({
			resumable: true
		});
	});

	// A reservation that already ended holds nothing, so the name is free again.
	test.each(["released", "expired"] as const)(
		"frees a name whose reservation %s",
		async (status) => {
			const t = testConvex();
			const me = await buyer(t);
			await t.run(
				async (ctx) =>
					await ctx.db.insert("box_checkout_intents", {
						user_id: "other",
						slug: "wanted",
						plan: "air",
						status,
						created_at: 1,
						updated_at: 1
					})
			);

			expect(await availability(me.as, "wanted")).toMatchObject({
				available: true
			});
		}
	);

	// The page asks this before anyone signs in, so it has to answer without an
	// identity - and cannot offer to resume a checkout it has no way to attribute.
	test("answers a signed-out visitor without offering a resume", async () => {
		const t = testConvex();
		await seedUser(t, { clerkUserId: "other", email: "other@example.com" });
		await t.run(
			async (ctx) =>
				await ctx.db.insert("box_checkout_intents", {
					user_id: "other",
					slug: "taken",
					plan: "air",
					status: "active",
					created_at: 1,
					updated_at: 1
				})
		);

		expect(
			await t.query(api.owner.checkout.slugAvailability, { slug: "free" })
		).toMatchObject({ available: true, resumable: false });
		expect(
			await t.query(api.owner.checkout.slugAvailability, { slug: "taken" })
		).toMatchObject({ available: false, resumable: false });
	});

	// A name that is not a name at all is not available - answering otherwise
	// would let the client offer a checkout the reservation would then refuse.
	test.each(["", "  ", "!!", "-nope-"])(
		"says %p is not available",
		async (slug) => {
			const t = testConvex();
			const me = await buyer(t);

			expect(await availability(me.as, slug)).toMatchObject({
				available: false
			});
		}
	);
});
