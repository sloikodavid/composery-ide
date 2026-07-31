import type { Metadata } from "next";
import { fetchQuery } from "convex/nextjs";
import { Pricing } from "./_components/pricing";
import { api } from "@/convex/_generated/api";
import {
	isBoxBillingInterval,
	type BoxBillingInterval
} from "@/convex/model/box/billing";
import { isBoxPlan } from "@/convex/model/box/plan";
import { sanitizeSlug } from "@/convex/model/box/slug";

export const metadata: Metadata = {
	title: "Pricing"
};

export default async function PricingPage({
	searchParams
}: {
	searchParams: Promise<{ billing?: string; plan?: string; slug?: string }>;
}) {
	const { billing, plan, slug } = await searchParams;
	const initialBillingInterval: BoxBillingInterval = isBoxBillingInterval(
		billing
	)
		? billing
		: "year";
	// Read on the server so the price is in the delivered HTML: it is the one
	// number a visitor and a crawler come to this page for.
	const pricing = await fetchQuery(api.site.pricing.boxPricing, {});

	return (
		<Pricing
			initialBillingInterval={initialBillingInterval}
			// Only ever set by the round trip through sign-in, which puts back
			// exactly what the visitor had chosen. A fresh visit has no plan, so the
			// dialog stays shut and the cards are the first thing asked.
			initialPlan={isBoxPlan(plan) ? plan : null}
			initialSlug={sanitizeSlug(slug ?? "")}
			pricing={pricing}
		/>
	);
}
