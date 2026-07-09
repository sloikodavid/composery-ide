import type { BoxPlan } from "./plan";

// Copy and interval shape only. No price lives here: Polar owns it, its product
// can be repriced from the Polar dashboard without touching this repo, and
// `billing/polar.ts#boxPricing` reads whatever the product now says.
export const BOX_BILLING = {
	month: {
		label: "Monthly",
		months: 1
	},
	year: {
		label: "Annual",
		months: 12
	}
} as const;

export type BoxBillingInterval = keyof typeof BOX_BILLING;

// Price per month for each interval a box can be bought on, in the currency the
// Polar product is denominated in - which is Polar's to choose, not ours.
//
// Null is "we have not read it from Polar", never "free" and never a stand-in
// for a remembered figure. A caller renders nothing rather than a number it
// cannot source, the same rule runtimeRelease.ts applies to fleet versions.
export type PlanPricing = {
	month: number | null;
	year: number | null;
};

// One currency for the catalogue, one figure per (plan, interval). Polar
// denominates a product, so a page that showed two currencies would be
// reporting a Polar misconfiguration rather than a price.
export type BoxPricing = {
	currency: string | null;
	plans: Record<BoxPlan, PlanPricing>;
};

// Object.hasOwn, not `in`: the value arrives from the ?billing= query string,
// and `in` walks the prototype chain, so "constructor" would pass.
export function isBoxBillingInterval(
	value: unknown
): value is BoxBillingInterval {
	return typeof value === "string" && Object.hasOwn(BOX_BILLING, value);
}

// Polar charges a whole interval up front, so the annual product's amount is
// spread back over its months to give the "/ month - billed annually" figure.
//
// ponytail: 100 minor units per unit, which is every currency Polar sells in
// bar the zero-decimal ones (JPY, KRW). Take the exponent from Intl's
// resolvedOptions if a box is ever priced in one.
export function monthlyPriceFromMinorUnits(
	billingInterval: BoxBillingInterval,
	minorUnits: number
) {
	return minorUnits / 100 / BOX_BILLING[billingInterval].months;
}

// The discount worth advertising, or null when there is none to advertise.
//
// One function answers both ways that can happen, so no caller re-decides it:
// a price we never read supports no claim at all, and a live Polar catalogue
// priced at parity or worse leaves nothing to boast about - "-0%" reads as a bug
// rather than as parity.
export function annualSavingsPercent(pricing: PlanPricing) {
	if (pricing.month === null || pricing.year === null) return null;
	const percent = Math.round((1 - pricing.year / pricing.month) * 100);
	return percent > 0 ? percent : null;
}

// The one saving the billing toggle can claim for the whole page, or null when
// there isn't one.
//
// Null when the plans disagree, not "whichever is biggest": the toggle sits
// above every card at once, so a figure that only holds for one of them would be
// an advertised discount some visitors do not get. A catalogue priced with one
// consistent annual discount - which is the normal case, and the only one worth
// a badge - still gets its badge.
export function sharedAnnualSavingsPercent(pricing: BoxPricing) {
	const percents = Object.values(pricing.plans).map(annualSavingsPercent);
	if (percents.length === 0 || percents.some((percent) => percent === null)) {
		return null;
	}
	return new Set(percents).size === 1 ? percents[0] : null;
}

// Null for the same reason, so a missing price cannot render as a bare currency
// symbol. Locale is pinned because CI and a developer machine must format
// identically; the currency is not, because it comes from the Polar product.
export function formatPrice(amount: number | null, currency: string | null) {
	if (amount === null || currency === null) return null;
	return new Intl.NumberFormat("en-US", {
		currency: currency.toUpperCase(),
		style: "currency",
		trailingZeroDisplay: "stripIfInteger"
	}).format(amount);
}
