import { afterEach, describe, expect, test, vi } from "vitest";
import {
	boxProductIds,
	boxSellableForProductId,
	getPolarOrder,
	refundPolarOrder,
	revokeAndRefundPolarOrder,
	revokePolarSubscription,
	selectPolarCheckoutProduct
} from "@/convex/billing/polar";
import { api } from "@/convex/_generated/api";

import { testConvex } from "../../../support/convex.ts";

// The catalogue Polar is holding, swapped in at the SDK rather than at our own
// module: `boxPricing` is the subject here, and only its dependency is replaced.
// Nothing else in this file touches the SDK - the refund and order calls go
// straight to `fetch` - so the swap is invisible to them.
const { catalogue } = vi.hoisted(() => ({
	catalogue: { products: [] as unknown[] }
}));

vi.mock("@convex-dev/polar", () => ({
	Polar: class {
		async listProducts() {
			return catalogue.products;
		}
	}
}));

function stubBoxProducts() {
	vi.stubEnv("POLAR_BOX_AIR_MONTHLY_PRODUCT_ID", "air-monthly");
	vi.stubEnv("POLAR_BOX_AIR_ANNUAL_PRODUCT_ID", "air-annual");
	vi.stubEnv("POLAR_BOX_PRO_MONTHLY_PRODUCT_ID", "pro-monthly");
	vi.stubEnv("POLAR_BOX_PRO_ANNUAL_PRODUCT_ID", "pro-annual");
}

afterEach(() => {
	catalogue.products = [];
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("box products", () => {
	// Polar fixes a session's product list at creation and offers no way to widen
	// it or to void the session, so a list narrower than the catalogue is a
	// decision that outlives the reservation it was made for. One reservation is
	// held per slug across both pricing cards, so anything it cannot sell is a
	// checkout the customer can never reopen.
	test("offers every product it sells, the chosen one first", () => {
		stubBoxProducts();

		expect(boxProductIds({ billingInterval: "year", plan: "air" })).toEqual([
			"air-annual",
			"air-monthly",
			"pro-monthly",
			"pro-annual"
		]);
		expect(boxProductIds({ billingInterval: "month", plan: "pro" })).toEqual([
			"pro-monthly",
			"air-monthly",
			"air-annual",
			"pro-annual"
		]);
	});

	// Selling still fails closed on the product being sold, while a product this
	// deployment has no id for simply is not offered - it could not be fulfilled
	// anyway, so it must stop its own sale and no other.
	test("drops an unconfigured extra but demands the one being sold", () => {
		stubBoxProducts();
		vi.stubEnv("POLAR_BOX_PRO_ANNUAL_PRODUCT_ID", "");

		expect(boxProductIds({ billingInterval: "month", plan: "air" })).toEqual([
			"air-monthly",
			"air-annual",
			"pro-monthly"
		]);
		expect(() =>
			boxProductIds({ billingInterval: "year", plan: "pro" })
		).toThrow(/POLAR_BOX_PRO_ANNUAL_PRODUCT_ID/);
	});

	test("reads a product id back to the plan and interval it sells", () => {
		stubBoxProducts();

		expect(boxSellableForProductId("pro-annual")).toEqual({
			billingInterval: "year",
			plan: "pro"
		});
		expect(boxSellableForProductId("air-monthly")).toEqual({
			billingInterval: "month",
			plan: "air"
		});
		expect(boxSellableForProductId("another-product")).toBeNull();
		expect(boxSellableForProductId(null)).toBeNull();
	});

	// The sweep that reads this runs across every box, so an unconfigured product
	// must degrade to "not one of ours" rather than throw and abandon the pass.
	test("treats an unconfigured product id as not ours instead of throwing", () => {
		vi.stubEnv("POLAR_BOX_AIR_MONTHLY_PRODUCT_ID", "");
		vi.stubEnv("POLAR_BOX_AIR_ANNUAL_PRODUCT_ID", "");
		vi.stubEnv("POLAR_BOX_PRO_MONTHLY_PRODUCT_ID", "");
		vi.stubEnv("POLAR_BOX_PRO_ANNUAL_PRODUCT_ID", "");

		expect(boxSellableForProductId("air-monthly")).toBeNull();
	});

	test("updates a resumable checkout to the selected product", async () => {
		vi.stubEnv("POLAR_ENVIRONMENT", "sandbox");
		vi.stubEnv("POLAR_ORGANIZATION_TOKEN", "polar-token");
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetch);

		await selectPolarCheckoutProduct("checkout-id", "annual-product");

		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch.mock.calls[0]?.[0]).toContain("/v1/checkouts/checkout-id");
		expect(fetch.mock.calls[0]?.[1]).toMatchObject({
			method: "PATCH",
			body: JSON.stringify({ product_id: "annual-product" })
		});
	});
});

describe("revokeAndRefundPolarOrder", () => {
	test("revokes first and refunds the order's full remaining amount", async () => {
		vi.stubEnv("POLAR_ENVIRONMENT", "sandbox");
		vi.stubEnv("POLAR_ORGANIZATION_TOKEN", "polar-token");
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValueOnce(
				Response.json({ refundable_amount: 2500, refunded_amount: 0 })
			)
			.mockResolvedValueOnce(Response.json({ items: [] }))
			.mockResolvedValueOnce(Response.json({ status: "succeeded" }));
		vi.stubGlobal("fetch", fetch);

		await revokeAndRefundPolarOrder({
			comment: "Initial delivery failed.",
			idempotencyKey: "fulfillment-failure:box-id",
			orderId: "order-id",
			subscriptionId: "subscription-id"
		});

		expect(fetch).toHaveBeenCalledTimes(4);
		expect(fetch.mock.calls[0]?.[0]).toContain(
			"/v1/subscriptions/subscription-id"
		);
		expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "DELETE" });
		expect(fetch.mock.calls[3]?.[0]).toContain("/v1/refunds/");
		expect(JSON.parse(String(fetch.mock.calls[3]?.[1]?.body))).toEqual({
			amount: 2500,
			comment: "Initial delivery failed.",
			metadata: {
				composery_refund_key: "fulfillment-failure:box-id"
			},
			order_id: "order-id",
			reason: "service_disruption"
		});
	});

	test("does not create another refund when nothing remains refundable", async () => {
		vi.stubEnv("POLAR_ENVIRONMENT", "sandbox");
		vi.stubEnv("POLAR_ORGANIZATION_TOKEN", "polar-token");
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValueOnce(Response.json({ refundable_amount: 0 }));
		vi.stubGlobal("fetch", fetch);

		await revokeAndRefundPolarOrder({
			comment: "Already refunded.",
			idempotencyKey: "same-operation",
			orderId: "order-id",
			subscriptionId: "subscription-id"
		});

		expect(fetch).toHaveBeenCalledTimes(2);
	});

	test("waits for an existing idempotent refund instead of duplicating it", async () => {
		vi.stubEnv("POLAR_ENVIRONMENT", "sandbox");
		vi.stubEnv("POLAR_ORGANIZATION_TOKEN", "polar-token");
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValueOnce(Response.json({ refundable_amount: 2500 }))
			.mockResolvedValueOnce(
				Response.json({
					items: [
						{
							metadata: { composery_refund_key: "same-operation" },
							status: "pending"
						}
					]
				})
			);
		vi.stubGlobal("fetch", fetch);

		await expect(
			revokeAndRefundPolarOrder({
				comment: "Still processing.",
				idempotencyKey: "same-operation",
				orderId: "order-id",
				subscriptionId: "subscription-id"
			})
		).rejects.toThrow("is pending");
		expect(fetch).toHaveBeenCalledTimes(3);
	});
});

// Ending a subscription. It is called from a teardown that is re-driven, so
// "already gone" has to be success: a revoke that threw on a subscription Polar
// no longer has would strand the box in `delete_failed` and keep its server
// billing, which is the opposite of what the call was for.
describe("revoking a subscription", () => {
	function stubPolar(status: number, body = "") {
		const asked: { method: string; url: string }[] = [];
		vi.stubEnv("POLAR_ORGANIZATION_TOKEN", "polar-token");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: URL | string, init?: RequestInit) => {
				asked.push({ method: init?.method ?? "GET", url: String(input) });
				return {
					ok: status >= 200 && status < 300,
					status,
					text: async () => body
				} as unknown as Response;
			})
		);
		return asked;
	}

	test("asks Polar to end the subscription", async () => {
		const asked = stubPolar(200);

		await revokePolarSubscription("sub_123");

		expect(asked).toMatchObject([{ method: "DELETE" }]);
		expect(asked[0]?.url).toContain("sub_123");
	});

	// Already gone is the state the caller wanted.
	test("treats a subscription Polar no longer has as revoked", async () => {
		stubPolar(404, "not found");

		await expect(revokePolarSubscription("sub_123")).resolves.not.toThrow();
	});

	// Polar answers 4xx for a second revoke with its own code, and a teardown
	// that is retried hits this every time after the first.
	test("treats one already cancelled as revoked", async () => {
		stubPolar(403, '{"error":"AlreadyCanceledSubscription"}');

		await expect(revokePolarSubscription("sub_123")).resolves.not.toThrow();
	});

	// Anything else is a real refusal and has to surface: silently continuing
	// would delete the box while its subscription kept charging.
	test("fails loudly on a refusal it does not recognise", async () => {
		stubPolar(500, "upstream exploded");

		await expect(revokePolarSubscription("sub_123")).rejects.toThrow(
			/sub_123: 500/
		);
	});

	// The id is interpolated into a URL path, so it is encoded rather than
	// trusted - a stored id with a slash would otherwise address another route.
	test("encodes the id into the path", async () => {
		const asked = stubPolar(200);

		await revokePolarSubscription("sub/../organizations");

		expect(asked[0]?.url).toContain("sub%2F..%2Forganizations");
	});
});

// What a Polar failure is called. Every call but the revoke goes through one
// wrapper, and the message it builds is what a staff alert quotes when a refund
// or an order lookup fails - so it has to name the call, not just the status.
describe("reporting a Polar API failure", () => {
	function stubPolar(status: number, body: string) {
		vi.stubEnv("POLAR_ORGANIZATION_TOKEN", "polar-token");
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					({
						ok: status >= 200 && status < 300,
						status,
						text: async () => body,
						json: async () => JSON.parse(body || "{}")
					}) as unknown as Response
			)
		);
	}

	test("names the method, the path, the status and what Polar said", async () => {
		stubPolar(422, '{"detail":"order not refundable"}');

		await expect(getPolarOrder("order_abc")).rejects.toThrow(
			/GET \/v1\/orders\/order_abc failed: 422 .*not refundable/
		);
	});

	// A gateway that answers with nothing still has to produce a message with the
	// status in it, rather than a blank one nobody can act on.
	test("still names the call when Polar sends no body", async () => {
		stubPolar(502, "");

		await expect(getPolarOrder("order_abc")).rejects.toThrow("failed: 502");
	});

	// The id goes into a URL path, so it is encoded rather than trusted.
	test("encodes the order id into the path", async () => {
		stubPolar(404, "gone");

		await expect(getPolarOrder("order/../refunds")).rejects.toThrow(
			"order%2F..%2Frefunds"
		);
	});
});

// Refunding is the one call here that moves a customer's money, and it is
// reached from retried paths - a failed fulfilment, an account deletion, a
// workflow that came back. Every property below is one that, if wrong, either
// refunds twice or does not refund at all, and neither is visible from inside
// Composery afterwards.
describe("refunding an order without refunding it twice", () => {
	function stubPolar(...responses: Response[]) {
		vi.stubEnv("POLAR_ENVIRONMENT", "sandbox");
		vi.stubEnv("POLAR_ORGANIZATION_TOKEN", "polar-token");
		const fetch = vi.fn<typeof globalThis.fetch>();
		for (const response of responses) fetch.mockResolvedValueOnce(response);
		vi.stubGlobal("fetch", fetch);
		return fetch;
	}

	const refund = (over: Record<string, unknown> = {}) =>
		refundPolarOrder({
			amount: 2500,
			comment: "Initial delivery failed.",
			idempotencyKey: "fulfillment-failure:box-id",
			orderId: "order-id",
			reason: "service_disruption",
			...over
		} as Parameters<typeof refundPolarOrder>[0]);

	// The whole of the double-refund guard: a refund already carrying this key
	// is this refund, and its status is the answer. Polar has no idempotency
	// header for refunds, so the metadata key is the only thing standing between
	// a retry and paying the customer twice.
	test.each(["pending", "succeeded"] as const)(
		"returns the %s refund it already made rather than making another",
		async (status) => {
			const fetch = stubPolar(
				Response.json({
					items: [
						{
							status,
							metadata: {
								composery_refund_key: "fulfillment-failure:box-id"
							}
						}
					]
				})
			);

			expect(await refund()).toBe(status);
			// The list, and nothing else - no POST.
			expect(fetch).toHaveBeenCalledTimes(1);
		}
	);

	// A refund that failed or was cancelled is not one that happened, so the
	// retry has to make a real one.
	test.each(["failed", "canceled"] as const)(
		"makes a new refund when the previous one %s",
		async (status) => {
			const fetch = stubPolar(
				Response.json({
					items: [
						{
							status,
							metadata: {
								composery_refund_key: "fulfillment-failure:box-id"
							}
						}
					]
				}),
				Response.json({ status: "succeeded" })
			);

			expect(await refund()).toBe("succeeded");
			expect(fetch).toHaveBeenCalledTimes(2);
			expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
		}
	);

	// Somebody else's refund on the same order - a manual one from the Polar
	// dashboard - is not ours and must not be mistaken for it.
	test("ignores a refund on the same order that is not this one", async () => {
		const fetch = stubPolar(
			Response.json({
				items: [
					{ status: "succeeded", metadata: { composery_refund_key: "other" } },
					{ status: "succeeded" }
				]
			}),
			Response.json({ status: "succeeded" })
		);

		await refund();

		expect(fetch).toHaveBeenCalledTimes(2);
	});

	test("makes a refund when the order has none at all", async () => {
		const fetch = stubPolar(
			Response.json({}),
			Response.json({ status: "succeeded" })
		);

		expect(await refund()).toBe("succeeded");
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	// The lookup has to be scoped to this order, or a busy organisation's
	// refunds would be searched for a key that lives on another order.
	test("looks the existing refund up on this order alone", async () => {
		const fetch = stubPolar(
			Response.json({ items: [] }),
			Response.json({ status: "succeeded" })
		);

		await refund({ orderId: "order/with spaces" });

		expect(String(fetch.mock.calls[0]?.[0])).toContain(
			`order_id=${encodeURIComponent("order/with spaces")}`
		);
	});

	// Polar takes whole cents. A fraction, a zero or a negative is a bug
	// upstream, and sending it would either fail opaquely or refund the wrong
	// amount - so it stops here, before any money moves.
	test.each([
		["a fraction of a cent", 25.5],
		["nothing", 0],
		["a negative amount", -2500],
		["not a number at all", Number.NaN]
	])("refuses to refund %s", async (_name, amount) => {
		const fetch = stubPolar();

		await expect(refund({ amount })).rejects.toThrow(
			"Polar refunds must be a positive whole number of cents."
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	// A status Polar has not told us about is not success. Returning it would
	// let `revokeAndRefundPolarOrder` treat an unknown outcome as settled.
	test.each([
		["a status we do not know", { status: "processing" }],
		["no status at all", {}]
	])("refuses a refund answered with %s", async (_name, body) => {
		stubPolar(Response.json({ items: [] }), Response.json(body));

		await expect(refund()).rejects.toThrow(
			"Polar refund for order order-id has no valid status."
		);
	});

	// The caller only treats "succeeded" as done; anything else has to surface
	// rather than leave a customer unpaid while the box is gone.
	test("refuses to call an unsettled refund done", async () => {
		stubPolar(
			new Response(null, { status: 204 }),
			Response.json({ refundable_amount: 2500 }),
			Response.json({ items: [] }),
			Response.json({ status: "pending" })
		);

		await expect(
			revokeAndRefundPolarOrder({
				comment: "Initial delivery failed.",
				idempotencyKey: "fulfillment-failure:box-id",
				orderId: "order-id",
				subscriptionId: "subscription-id"
			})
		).rejects.toThrow("Polar refund for order order-id is pending.");
	});
});

// What Polar says an order still owes. Every refund amount is taken from this
// number, so a value we cannot read has to stop the refund rather than become
// `NaN` cents.
describe("reading what an order can still refund", () => {
	function stubOrder(body: unknown) {
		vi.stubEnv("POLAR_ENVIRONMENT", "sandbox");
		vi.stubEnv("POLAR_ORGANIZATION_TOKEN", "polar-token");
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(body))
		);
	}

	test("reads a whole number of cents", async () => {
		stubOrder({ refundable_amount: 2500 });

		expect(await getPolarOrder("order-id")).toEqual({
			refundable_amount: 2500
		});
	});

	test("reads a fully refunded order as nothing left", async () => {
		stubOrder({ refundable_amount: 0 });

		expect(await getPolarOrder("order-id")).toEqual({ refundable_amount: 0 });
	});

	test.each([
		["a missing amount", {}],
		["an amount that is not a number", { refundable_amount: "2500" }],
		["a fraction of a cent", { refundable_amount: 25.5 }],
		["a negative amount", { refundable_amount: -1 }]
	])("refuses an order reporting %s", async (_name, body) => {
		stubOrder(body);

		await expect(getPolarOrder("order-id")).rejects.toThrow(
			"Polar order order-id has an invalid refundable amount."
		);
	});
});

// Which Polar the deployment talks to. This is the one setting where a wrong
// value is not a failed request but a successful one against the wrong world -
// a production deployment quietly refunding sandbox orders, or worse.
describe("choosing which Polar to talk to", () => {
	function stubEnvironment(environment: string | undefined) {
		if (environment === undefined) vi.stubEnv("POLAR_ENVIRONMENT", "");
		else vi.stubEnv("POLAR_ENVIRONMENT", environment);
		vi.stubEnv("POLAR_ORGANIZATION_TOKEN", "polar-token");
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(Response.json({ refundable_amount: 0 }));
		vi.stubGlobal("fetch", fetch);
		return fetch;
	}

	test.each([
		["sandbox", "sandbox-api.polar.sh"],
		["production", "api.polar.sh"]
	])("sends %s traffic to its own host", async (environment, host) => {
		const fetch = stubEnvironment(environment);

		await getPolarOrder("order-id");

		expect(String(fetch.mock.calls[0]?.[0])).toContain(host);
	});

	// Unset is sandbox, which is the only safe default: a deployment that forgot
	// to configure this can never charge or refund a real card.
	test("falls back to sandbox when nothing is configured", async () => {
		const fetch = stubEnvironment(undefined);

		await getPolarOrder("order-id");

		expect(String(fetch.mock.calls[0]?.[0])).toContain("sandbox-api.polar.sh");
	});

	// A typo must not silently become one of the two. Choosing either would be
	// a deployment talking to a world its operator did not pick.
	test.each(["prod", "Sandbox", "live", "production;"])(
		"refuses the unrecognised environment %s",
		async (environment) => {
			stubEnvironment(environment);

			await expect(getPolarOrder("order-id")).rejects.toThrow(
				"POLAR_ENVIRONMENT must be sandbox or production."
			);
		}
	);

	// A value pasted with surrounding whitespace is the same value. Every env
	// read here trims, so a deployment is not broken by an invisible character.
	test("tolerates whitespace around a valid environment", async () => {
		const fetch = stubEnvironment("  production  ");

		await getPolarOrder("order-id");

		expect(String(fetch.mock.calls[0]?.[0])).toContain("api.polar.sh");
	});

	test("authenticates every call with the organisation token", async () => {
		const fetch = stubEnvironment("sandbox");

		await getPolarOrder("order-id");

		expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
			Authorization: "Bearer polar-token"
		});
	});
});

// What the pricing page is allowed to say.
//
// Every number here is read by a customer before they pay, and every one is
// derived: Polar denominates in minor units per billing period, and the page
// shows a monthly figure. None of that derivation had been executed, so the page
// could have shown an annual total as a monthly price and nothing would have
// minded. The other half is that a catalogue we cannot read shows nothing rather
// than a wrong price or a zero - zero reads as free.
describe("the prices the pricing page may show", () => {
	const price = (over: Record<string, unknown> = {}) => ({
		isArchived: false,
		priceAmount: 1200,
		priceCurrency: "usd",
		...over
	});

	const product = (id: string, over: Record<string, unknown> = {}) => ({
		id,
		isArchived: false,
		prices: [price()],
		...over
	});

	function stubProducts(products: unknown[]) {
		catalogue.products = products;
		stubBoxProducts();
		vi.stubEnv("POLAR_ENVIRONMENT", "sandbox");
	}

	const pricing = () => testConvex().query(api.site.pricing.boxPricing, {});

	// Minor units to a monthly figure: a monthly product divides by one, an
	// annual one by twelve. Showing an annual total as a monthly price is the
	// mistake this exists to prevent.
	test("shows a monthly price monthly and an annual price per month", async () => {
		stubProducts([
			product("air-monthly", { prices: [price({ priceAmount: 1200 })] }),
			product("air-annual", { prices: [price({ priceAmount: 12000 })] })
		]);

		expect((await pricing()).plans.air).toEqual({ month: 12, year: 10 });
	});

	// Both plans derive the same way; the more expensive one is where a wrong
	// divisor would be most visible on the bill.
	test("derives the other plan's annual price per month too", async () => {
		stubProducts([
			product("pro-monthly", { prices: [price({ priceAmount: 4800 })] }),
			product("pro-annual", { prices: [price({ priceAmount: 48000 })] })
		]);

		expect((await pricing()).plans.pro).toEqual({ month: 48, year: 40 });
	});

	test("reads the currency the catalogue is denominated in", async () => {
		stubProducts([
			product("air-monthly", { prices: [price({ priceCurrency: "eur" })] })
		]);

		expect((await pricing()).currency).toBe("eur");
	});

	// A price nobody can read is shown as nothing.
	test.each([
		["a plan with no product in the catalogue", [] as unknown[]],
		["a product the catalogue does not hold", [product("something-else")]],
		[
			"a product that has been archived",
			[product("air-monthly", { isArchived: true })]
		],
		[
			"a product whose only price is archived",
			[product("air-monthly", { prices: [price({ isArchived: true })] })]
		],
		[
			"a product with no prices at all",
			[product("air-monthly", { prices: [] })]
		],
		[
			"a price with no readable amount",
			[product("air-monthly", { prices: [price({ priceAmount: null })] })]
		]
	])("shows nothing for %s", async (_name, products) => {
		stubProducts(products);

		expect((await pricing()).plans.air.month).toBeNull();
	});

	// An archived price beside a live one is a product Polar has re-priced; the
	// live one is what a customer would be charged.
	test("skips an archived price to reach the live one", async () => {
		stubProducts([
			product("air-monthly", {
				prices: [
					price({ isArchived: true, priceAmount: 9900 }),
					price({ priceAmount: 1200 })
				]
			})
		]);

		expect((await pricing()).plans.air.month).toBe(12);
	});

	// A deployment that has never synced its catalogue has no prices, and the
	// page has to render rather than throw.
	test("answers an empty catalogue with nothing at all", async () => {
		stubProducts([]);

		expect(await pricing()).toEqual({
			currency: null,
			plans: {
				air: { month: null, year: null },
				pro: { month: null, year: null }
			}
		});
	});

	// The plans are read independently: one being unconfigured must not blank
	// the other.
	test("prices one plan even when the other is missing", async () => {
		stubProducts([
			product("pro-monthly", { prices: [price({ priceAmount: 4800 })] })
		]);

		const result = await pricing();
		expect(result.plans.pro.month).toBe(48);
		expect(result.plans.air.month).toBeNull();
	});
});

// The last few edges on the money path: what an unreadable failure says, what a
// refund POST declares, and the annual side of the more expensive plan.
describe("the edges of talking to Polar", () => {
	// A gateway can fail the request and then fail the body too. The error still
	// has to name the call and the status, because that string is what an
	// operator reads when a refund did not happen.
	test("still reports a failure whose body cannot be read", async () => {
		vi.stubEnv("POLAR_ENVIRONMENT", "sandbox");
		vi.stubEnv("POLAR_ORGANIZATION_TOKEN", "polar-token");
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof globalThis.fetch>().mockResolvedValue({
				ok: false,
				status: 502,
				text: async () => {
					throw new Error("socket hang up");
				}
			} as unknown as Response)
		);

		await expect(getPolarOrder("order-id")).rejects.toThrow(
			"Polar API GET /v1/orders/order-id failed: 502"
		);
	});

	// Same for a revoke, which reads its own response rather than going through
	// the shared helper.
	test("still reports a revoke failure whose body cannot be read", async () => {
		vi.stubEnv("POLAR_ENVIRONMENT", "sandbox");
		vi.stubEnv("POLAR_ORGANIZATION_TOKEN", "polar-token");
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof globalThis.fetch>().mockResolvedValue({
				ok: false,
				status: 500,
				text: async () => {
					throw new Error("socket hang up");
				}
			} as unknown as Response)
		);

		await expect(revokePolarSubscription("subscription-id")).rejects.toThrow(
			"Polar subscription revoke failed for subscription-id: 500"
		);
	});

	// Polar reads the refund body as JSON, so the request has to say so.
	test("declares JSON on the refund it posts", async () => {
		vi.stubEnv("POLAR_ENVIRONMENT", "sandbox");
		vi.stubEnv("POLAR_ORGANIZATION_TOKEN", "polar-token");
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(Response.json({ items: [] }))
			.mockResolvedValueOnce(Response.json({ status: "succeeded" }));
		vi.stubGlobal("fetch", fetch);

		await refundPolarOrder({
			amount: 2500,
			comment: "Initial delivery failed.",
			idempotencyKey: "fulfillment-failure:box-id",
			orderId: "order-id",
			reason: "service_disruption"
		});

		expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({
			"Content-Type": "application/json"
		});
	});

	// A product id nothing is configured for is nobody's plan, and neither is a
	// missing one - reading either as a plan would sell the wrong thing.
	test.each([
		["nothing at all", null],
		["an empty id", ""],
		["an id we do not sell", "some-other-product"]
	])("recognises %s as no plan of ours", (_name, productId) => {
		stubBoxProducts();

		expect(boxSellableForProductId(productId)).toBeNull();
	});
});
