// What the pricing page is allowed to ask, and the only thing an anonymous
// visitor can call.
//
// The fourth audience. `owner/` is a signed-in customer, `staff/` is the
// console, `box/` is a running instance with a grant; this one has no identity
// at all, which is exactly why it is worth naming rather than leaving among the
// billing internals. Everything reachable from outside this deployment lives in
// an audience directory, so "what can a stranger call" is a directory listing
// rather than a search.
import { v } from "convex/values";
import { query } from "../_generated/server";
import {
	boxSellablePrice,
	polarServer,
	type BoxSellable
} from "../billing/polar";
import {
	BOX_BILLING,
	monthlyPriceFromMinorUnits,
	type BoxBillingInterval
} from "../model/box/billing";
import { BOX_PLAN_ORDER, type BoxPlan } from "../model/box/plan";

// No price is written down here. Polar owns what a box costs and this reports
// what it says, so repricing needs no deploy - and a plan whose product has not
// been read yet reports null, so the page renders no figure rather than one this
// repository made up.
const vPlanPricing = v.object({
	month: v.union(v.number(), v.null()),
	year: v.union(v.number(), v.null())
});

export const boxPricing = query({
	args: {},
	returns: v.object({
		currency: v.union(v.string(), v.null()),
		// Built from the plan catalogue rather than naming `air` and `pro`. Both
		// the validator and the body used to write them out by hand, so a third
		// plan would have been sold by checkout and missing from the page that
		// advertises it, with nothing failing.
		//
		// `v.object` and not `v.record`: Convex refuses a record with literal keys,
		// and this is the shape `BoxPricing` in the model already describes.
		plans: v.object(
			Object.fromEntries(
				BOX_PLAN_ORDER.map((plan) => [plan, vPlanPricing])
			) as Record<BoxPlan, typeof vPlanPricing>
		)
	}),
	handler: async (ctx) => {
		const products = await polarServer().listProducts(ctx);

		function monthlyPrice(sellable: BoxSellable) {
			const amount = boxSellablePrice(products, sellable)?.priceAmount;
			return typeof amount === "number"
				? monthlyPriceFromMinorUnits(sellable.billingInterval, amount)
				: null;
		}

		// One currency for the whole page: Polar denominates a product, and the
		// first one that has been read speaks for the rest. A catalogue that
		// disagreed with itself would be a Polar misconfiguration, not something
		// the pricing page should try to render.
		const currency =
			BOX_PLAN_ORDER.flatMap((plan) =>
				(Object.keys(BOX_BILLING) as BoxBillingInterval[]).map(
					(billingInterval) =>
						boxSellablePrice(products, { billingInterval, plan })?.priceCurrency
				)
			).find((value) => typeof value === "string") ?? null;

		return {
			currency,
			plans: Object.fromEntries(
				BOX_PLAN_ORDER.map((plan) => [
					plan,
					{
						month: monthlyPrice({ billingInterval: "month", plan }),
						year: monthlyPrice({ billingInterval: "year", plan })
					}
				])
			) as Record<BoxPlan, { month: number | null; year: number | null }>
		};
	}
});
