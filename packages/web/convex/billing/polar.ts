import { Polar } from "@convex-dev/polar";
import { v } from "convex/values";
import { components } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { optionalEnv, requiredEnv, type ConvexEnvName } from "../env";
import { BOX_BILLING, type BoxBillingInterval } from "../model/box/billing";
import { BOX_PLAN_ORDER, type BoxPlan } from "../model/box/plan";

const POLAR_API_HOSTS = {
	production: "https://api.polar.sh",
	sandbox: "https://sandbox-api.polar.sh"
} as const;

type PolarOrder = {
	refundable_amount: number;
};

type PolarRefundStatus = "pending" | "succeeded" | "failed" | "canceled";

type PolarRefund = {
	amount: number;
	metadata: Record<string, unknown>;
	status: PolarRefundStatus;
};

const REFUND_IDEMPOTENCY_METADATA_KEY = "composery_refund_key";

// Polar fixes the billing interval on a product, so a plan sold on two intervals
// is two products - one Polar product per (plan, interval) pair. This grid is
// the only place that correspondence is written down; the names are typed
// against `CONVEX_ENV_NAMES`, so the deployment checklist covers them whether
// they are read from here or anywhere else.
const BOX_PRODUCT_ENV = {
	air: {
		month: "POLAR_BOX_AIR_MONTHLY_PRODUCT_ID",
		year: "POLAR_BOX_AIR_ANNUAL_PRODUCT_ID"
	},
	pro: {
		month: "POLAR_BOX_PRO_MONTHLY_PRODUCT_ID",
		year: "POLAR_BOX_PRO_ANNUAL_PRODUCT_ID"
	}
} as const satisfies Record<BoxPlan, Record<BoxBillingInterval, ConvexEnvName>>;

// The configured id, or undefined where this deployment has not been given one.
// Tolerant on purpose, unlike `boxProductId`: the hourly sweep across every box
// must not abandon itself - and the deletions it also carries - because one
// product id is missing, and the checkout component is constructed while Convex
// analyses modules with no deployment environment at all.
function configuredProductId(sellable: BoxSellable) {
	return optionalEnv(BOX_PRODUCT_ENV[sellable.plan][sellable.billingInterval]);
}

// A sellable box: which plan, billed how often. Checkout picks one, a
// subscription carries one, and `boxSellableForProductId` reads one back out of
// Polar - so switching plan and switching billing cycle are the same move on
// two axes rather than two features.
export type BoxSellable = {
	billingInterval: BoxBillingInterval;
	plan: BoxPlan;
};

export function boxProductId({ billingInterval, plan }: BoxSellable) {
	return requiredEnv(BOX_PRODUCT_ENV[plan][billingInterval]);
}

// The products a checkout session may sell, the chosen one first.
//
// Every sellable, not just the chosen plan's two intervals. Polar fixes a
// checkout's product list at creation - `CheckoutUpdate` has no `products`
// field - and offers no way to void a checkout, so a list narrower than the
// catalogue is a decision that can never be revised for the life of that
// session. One reservation is held per slug and a visitor may reopen it from
// either pricing card, so a narrower list makes reselecting the other plan
// impossible: Polar refuses a `product_id` outside the list, which is the 422
// this shape removes rather than guards against.
//
// Nothing is lost by widening it, because no local copy of "which plan this
// sells" is what decides the sale: the box is born from the product the order
// was paid against (`boxSellableForProductId` in webhooks.ts), and the
// reservation's own plan follows the checkout's selection through
// `checkout.updated`. What a session sells is Polar's fact, read back, rather
// than ours imposed on it.
//
// Unconfigured extras are dropped rather than demanded. The selected one still
// goes through `boxProductId`, so a sale can never be opened against a product
// this deployment has not been given an id for.
export function boxProductIds(sellable: BoxSellable) {
	const selected = boxProductId(sellable);
	const offered = [selected];
	for (const plan of BOX_PLAN_ORDER) {
		for (const billingInterval of Object.keys(
			BOX_BILLING
		) as BoxBillingInterval[]) {
			const productId = configuredProductId({ billingInterval, plan });
			if (productId && !offered.includes(productId)) offered.push(productId);
		}
	}
	return offered;
}

// Which sellable a Polar product id is, or null when it is not one of ours.
//
// This is the inverse the plan-change path rests on: the customer changes what
// they pay for in Polar's portal, the subscription arrives naming a product id,
// and the box has to work out what it is now supposed to be. One reader for both
// axes means a plan switch and an interval switch cannot be recognised by
// different code that disagrees.
export function boxSellableForProductId(
	productId: string | null | undefined
): BoxSellable | null {
	if (!productId) return null;
	for (const plan of Object.keys(BOX_PRODUCT_ENV) as BoxPlan[]) {
		for (const billingInterval of Object.keys(
			BOX_PRODUCT_ENV[plan]
		) as BoxBillingInterval[]) {
			const sellable = { billingInterval, plan };
			// An unset variable simply matches nothing, and the caller reports the
			// product as unrecognised, which is exactly what it is. Selling, by
			// contrast, still fails closed: `boxProductId` demands the variable, so a
			// sale can never be made against a product that is not configured.
			if (configuredProductId(sellable) === productId) return sellable;
		}
	}
	return null;
}

// The live price of one sellable, read from the Polar product that will actually
// charge the visitor, or undefined where this deployment has not read that
// product yet. Archived products and archived prices are skipped: Polar keeps
// both after a price change, and taking the first match would quote a price
// nothing sells.
//
// Reads what the component keeps in sync locally - the product.created and
// product.updated webhooks registered in webhooks.ts, plus the hourly cron
// below that covers a deployment those webhooks have not fired for yet.
//
// Exported for `convex/site/pricing.ts`, which is the only surface that renders
// a figure. What a box *costs* is Polar's; what a box *is* is `model/box/plan`.
export function boxSellablePrice(
	products: Awaited<ReturnType<ReturnType<typeof polarServer>["listProducts"]>>,
	sellable: BoxSellable
) {
	const productId = configuredProductId(sellable);
	const product = productId
		? products.find(
				(candidate) => candidate.id === productId && !candidate.isArchived
			)
		: undefined;
	return product?.prices.find(
		(price) => !price.isArchived && typeof price.priceAmount === "number"
	);
}

// Pull the product catalogue from Polar into the component's tables. The
// webhooks only fire on a change, so without this a deployment that has never
// seen one has no catalogue at all and the pricing page has no price to show.
export const syncBoxProducts = internalAction({
	args: {},
	handler: async (ctx) => {
		await polarServer().syncProducts(ctx);
	}
});

export async function selectPolarCheckoutProduct(
	checkoutId: string,
	productId: string
) {
	await polarApi(`/v1/checkouts/${encodeURIComponent(checkoutId)}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ product_id: productId })
	});
}

function polarEnvironment() {
	const environment = optionalEnv("POLAR_ENVIRONMENT") ?? "sandbox";
	if (environment !== "sandbox" && environment !== "production") {
		throw new Error("POLAR_ENVIRONMENT must be sandbox or production.");
	}
	return environment;
}

// The calls the component does not make for us: refunds, order reads, immediate
// revocation, and repointing a live checkout at another product. One authorized
// request builder, so the host and the token are chosen in a single place and a
// caller can only get them both or neither.
function polarRequest(path: string, init: RequestInit = {}) {
	return fetch(`${POLAR_API_HOSTS[polarEnvironment()]}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${requiredEnv("POLAR_ORGANIZATION_TOKEN")}`,
			...init.headers
		}
	});
}

async function polarApi(path: string, init: RequestInit = {}) {
	const response = await polarRequest(path, init);
	if (response.ok) return response;

	const body = await response.text().catch(() => "");
	throw new Error(
		`Polar API ${init.method ?? "GET"} ${path} failed: ${response.status} ${body}`
	);
}

// Ends the subscription immediately. Idempotent: a subscription already gone
// (404) or already revoked answers success, so retrying callers never block -
// which is why this one reads the response itself instead of going through
// `polarApi`.
export async function revokePolarSubscription(subscriptionId: string) {
	const response = await polarRequest(
		`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
		{ method: "DELETE" }
	);

	if (response.ok || response.status === 404) return;

	const body = await response.text().catch(() => "");
	if (body.includes("AlreadyCanceledSubscription")) return;

	throw new Error(
		`Polar subscription revoke failed for ${subscriptionId}: ${response.status} ${body}`
	);
}

export async function getPolarOrder(orderId: string): Promise<PolarOrder> {
	const response = await polarApi(`/v1/orders/${encodeURIComponent(orderId)}`);
	const order = (await response.json()) as Partial<PolarOrder>;
	if (
		typeof order.refundable_amount !== "number" ||
		!Number.isInteger(order.refundable_amount) ||
		order.refundable_amount < 0
	) {
		throw new Error(`Polar order ${orderId} has an invalid refundable amount.`);
	}
	return { refundable_amount: order.refundable_amount };
}

export async function refundPolarOrder({
	amount,
	comment,
	idempotencyKey,
	orderId,
	reason
}: {
	amount: number;
	comment: string;
	idempotencyKey: string;
	orderId: string;
	reason: "customer_request" | "other" | "service_disruption";
}) {
	if (!Number.isInteger(amount) || amount < 1) {
		throw new Error("Polar refunds must be a positive whole number of cents.");
	}

	const listResponse = await polarApi(
		`/v1/refunds/?order_id=${encodeURIComponent(orderId)}&limit=100&sorting=-created_at`
	);
	const list = (await listResponse.json()) as {
		items?: Partial<PolarRefund>[];
	};
	const existing = list.items?.find(
		(refund) =>
			refund.metadata?.[REFUND_IDEMPOTENCY_METADATA_KEY] === idempotencyKey &&
			(refund.status === "pending" || refund.status === "succeeded")
	);
	if (existing?.status) return existing.status;

	const response = await polarApi("/v1/refunds/", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			amount,
			comment,
			metadata: { [REFUND_IDEMPOTENCY_METADATA_KEY]: idempotencyKey },
			order_id: orderId,
			reason
		})
	});
	const refund = (await response.json()) as Partial<PolarRefund>;
	if (
		refund.status !== "pending" &&
		refund.status !== "succeeded" &&
		refund.status !== "failed" &&
		refund.status !== "canceled"
	) {
		throw new Error(`Polar refund for order ${orderId} has no valid status.`);
	}
	return refund.status;
}

// A paid subscription and its order are separate Polar resources: revoking
// stops access but does not refund, while refunding does not stop access. Always
// do both for a sale Composery cannot fulfill. Retrying is safe because revoke
// is idempotent and refundPolarOrder recognizes the stable metadata key.
export async function revokeAndRefundPolarOrder({
	comment,
	idempotencyKey,
	orderId,
	reason = "service_disruption",
	subscriptionId
}: {
	comment: string;
	idempotencyKey: string;
	orderId: string;
	reason?: "other" | "service_disruption";
	subscriptionId: string;
}) {
	await revokePolarSubscription(subscriptionId);

	const order = await getPolarOrder(orderId);
	if (order.refundable_amount === 0) return;

	const status = await refundPolarOrder({
		amount: order.refundable_amount,
		comment,
		idempotencyKey,
		orderId,
		reason
	});
	if (status !== "succeeded") {
		throw new Error(`Polar refund for order ${orderId} is ${status}.`);
	}
}

export const revokeAndRefundOrder = internalAction({
	args: {
		comment: v.string(),
		idempotencyKey: v.string(),
		orderId: v.string(),
		reason: v.optional(
			v.union(v.literal("other"), v.literal("service_disruption"))
		),
		subscriptionId: v.string()
	},
	handler: async (_ctx, args) => {
		await revokeAndRefundPolarOrder(args);
	}
});

// http.ts constructs the client at module top-level to register the webhook
// route, and Convex analyzes modules during push with no deployment env vars,
// so requiredEnv would break the deploy. These tolerant reads are safe by
// design: an empty token fails the Polar API call (401), an empty webhook
// secret makes signature verification fail closed, and "sandbox" is the
// fail-safe default (a missing config can never charge a real card).
//
// The four product keys are Polar's own names, so they are written out; the
// variable behind each is still read through the grid above.
export function polarServer() {
	return new Polar(components.polar, {
		products: {
			boxAirMonthly:
				configuredProductId({ billingInterval: "month", plan: "air" }) ?? "",
			boxAirAnnual:
				configuredProductId({ billingInterval: "year", plan: "air" }) ?? "",
			boxProMonthly:
				configuredProductId({ billingInterval: "month", plan: "pro" }) ?? "",
			boxProAnnual:
				configuredProductId({ billingInterval: "year", plan: "pro" }) ?? ""
		},
		organizationToken: optionalEnv("POLAR_ORGANIZATION_TOKEN") ?? "",
		webhookSecret: optionalEnv("POLAR_WEBHOOK_SECRET") ?? "",
		server: polarEnvironment(),
		getUserInfo: async () => {
			throw new Error("Use explicit Composery Cloud Polar calls.");
		}
	});
}
