"use client";

import {
	AngryIcon,
	ArrowUpDownIcon,
	ContainerIcon,
	CpuIcon,
	EarthLockIcon,
	FileSearchCornerIcon,
	HistoryIcon,
	type LucideIcon,
	MonitorCogIcon,
	BookOpenIcon,
	ShieldCheckIcon,
	WalletIcon
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { AnimatedIconButton } from "@/components/animated-icon";
import { buttonVariants } from "@/components/base/button";
import { Card } from "@/components/base/card";
import { Faq } from "./faq";
import { GitHubLogo } from "@/components/icons/github-logo";
import { PageTemplate } from "@/components/page-template";
import { SlugDialog } from "./slug-dialog";
import {
	BOX_BILLING,
	type BoxBillingInterval,
	type BoxPricing,
	formatPrice,
	sharedAnnualSavingsPercent
} from "@/convex/model/box/billing";
import {
	BOX_PLANS,
	BOX_PLAN_ORDER,
	boxPlanSpecification,
	type BoxPlan
} from "@/convex/model/box/plan";
import { boxPlanTrafficLabel } from "@/convex/model/box/usage";
import { GITHUB_REPO_URL } from "@/convex/model/links";
import { cn } from "@/lib/utils";

type Feature = { icon: LucideIcon; text: string };

// What every hosted box gets, whichever plan bought it. The machine and the
// snapshot line are per plan and are derived below, so this list is only the
// part that genuinely does not vary.
const HOSTED_FEATURES: Feature[] = [
	{ icon: ShieldCheckIcon, text: "Securely hosted in Europe" },
	{ icon: EarthLockIcon, text: "Sub-domain, DNS, and HTTPS" }
];

const SELF_HOSTED_FEATURES: Feature[] = [
	{ icon: ContainerIcon, text: "Runs anywhere, just like n8n" },
	{ icon: FileSearchCornerIcon, text: "Fully open-source, no lock-in" },
	{ icon: BookOpenIcon, text: "Documentation available" },
	{ icon: MonitorCogIcon, text: "Platform templates available" },
	{ icon: AngryIcon, text: "You might get a headache" }
];

// Read off the plan table rather than written out per card, so a plan whose
// machine or snapshot capability changes cannot keep advertising the old one.
function planFeatures(plan: BoxPlan): Feature[] {
	return [
		{ icon: CpuIcon, text: boxPlanSpecification(plan) },
		// The allowance a buyer is committing to, on the card that sells it. It was
		// nowhere before: an owner found out what a box may send only by exceeding
		// it, which is the one moment it is too late to have been told.
		{ icon: ArrowUpDownIcon, text: boxPlanTrafficLabel(plan) },
		...HOSTED_FEATURES,
		{
			icon: HistoryIcon,
			// Derived so a plan's allowance is stated once. The wording follows the
			// capability rather than the number alone: a plan without on-demand
			// captures gets all of them taken for it.
			text: BOX_PLANS[plan].manualSnapshots
				? `${BOX_PLANS[plan].snapshotCap} daily + manual snapshots`
				: `${BOX_PLANS[plan].snapshotCap} daily snapshots`
		}
	];
}

function BillingSelector({
	billingInterval,
	onChange,
	savingsPercent
}: {
	billingInterval: BoxBillingInterval;
	onChange: (billingInterval: BoxBillingInterval) => void;
	savingsPercent: number | null;
}) {
	return (
		<div
			aria-label="Billing frequency"
			className="flex flex-wrap items-center gap-1.5 text-base font-medium"
			role="group"
		>
			{(["month", "year"] as const).map((interval, index) => {
				const selected = interval === billingInterval;

				return (
					<span className="contents" key={interval}>
						{index > 0 ? (
							<span aria-hidden="true" className="text-muted-foreground">
								/
							</span>
						) : null}
						<button
							aria-pressed={selected}
							className={cn(
								"transition-colors outline-none focus-visible:text-foreground",
								selected
									? "text-foreground"
									: "text-muted-foreground hover:text-foreground"
							)}
							onClick={() => onChange(interval)}
							type="button"
						>
							{BOX_BILLING[interval].label}
							{interval === "year" && savingsPercent !== null ? (
								<span className="text-success"> -{savingsPercent}%</span>
							) : null}
						</button>
					</span>
				);
			})}
		</div>
	);
}

function FeatureList({ features }: { features: Feature[] }) {
	return (
		<ul className="space-y-3.5">
			{features.map(({ icon: Icon, text }) => (
				<li className="flex items-center gap-3 text-sm" key={text}>
					<Icon className="size-4 shrink-0 text-muted-foreground" />
					<span className="text-foreground">{text}</span>
				</li>
			))}
		</ul>
	);
}

function PlanCard({
	children,
	descriptor,
	features,
	name,
	period,
	price
}: {
	children: ReactNode;
	descriptor: string;
	features: Feature[];
	name: string;
	period?: string;
	// Null when Polar has not been read: the card keeps its button, and the
	// visitor gets the real figure in checkout, rather than one invented here.
	price: string | null;
}) {
	return (
		<Card className="p-7 sm:p-8">
			{/* The name and its descriptor are one block: the card's own gap would
			    otherwise sit between them, and a title and its subtitle belong
			    together. */}
			<div className="space-y-1">
				<h3 className="font-heading text-2xl font-medium tracking-tight text-foreground">
					{name}
				</h3>
				<p className="text-sm text-muted-foreground">{descriptor}</p>
			</div>

			{price ? (
				<div className="flex items-baseline gap-1.5">
					<span className="font-heading text-5xl font-medium tracking-tight text-foreground tabular-nums">
						{price}
					</span>
					{period ? (
						<span className="text-sm text-muted-foreground">{period}</span>
					) : null}
				</div>
			) : null}

			<div>{children}</div>

			<div>
				<FeatureList features={features} />
			</div>
		</Card>
	);
}

export function Pricing({
	initialBillingInterval,
	initialPlan,
	initialSlug,
	pricing
}: {
	initialBillingInterval: BoxBillingInterval;
	initialPlan: BoxPlan | null;
	initialSlug: string;
	pricing: BoxPricing;
}) {
	const [billingInterval, setBillingInterval] = useState(
		initialBillingInterval
	);
	// The plan whose button was pressed, and the dialog's own open state.
	// Reopened straight away when the visitor is arriving back from sign-in having
	// already chosen one.
	const [checkoutPlan, setCheckoutPlan] = useState<BoxPlan | null>(initialPlan);

	return (
		<PageTemplate
			actions={
				<BillingSelector
					billingInterval={billingInterval}
					onChange={setBillingInterval}
					savingsPercent={sharedAnnualSavingsPercent(pricing)}
				/>
			}
			breadcrumbs={[{ icon: WalletIcon, label: "Pricing" }]}
		>
			<div className="space-y-8">
				<div className="grid gap-5 md:grid-cols-3">
					{BOX_PLAN_ORDER.map((plan) => (
						<PlanCard
							descriptor={BOX_PLANS[plan].descriptor}
							features={planFeatures(plan)}
							key={plan}
							name={BOX_PLANS[plan].label}
							period={
								billingInterval === "year"
									? `/ month - billed annually.`
									: "/ month."
							}
							price={formatPrice(
								pricing.plans[plan][billingInterval],
								pricing.currency
							)}
						>
							<AnimatedIconButton
								className="w-full"
								icon="arrow-right"
								onClick={() => setCheckoutPlan(plan)}
								size="lg"
								variant={plan === "pro" ? undefined : "outline"}
							>
								Buy
							</AnimatedIconButton>
						</PlanCard>
					))}

					<PlanCard
						descriptor="Manage your own Composery."
						features={SELF_HOSTED_FEATURES}
						name="Self-hosted"
						price="Free"
					>
						<a
							className={cn(
								"w-full gap-2",
								buttonVariants({ size: "lg", variant: "outline" })
							)}
							href={GITHUB_REPO_URL}
							rel="noreferrer"
							target="_blank"
						>
							<GitHubLogo className="size-4" />
							Go to repo
						</a>
					</PlanCard>
				</div>

				<Faq />
			</div>

			<SlugDialog
				billingInterval={billingInterval}
				initialSlug={initialSlug}
				onOpenChange={(open) => {
					if (!open) setCheckoutPlan(null);
				}}
				plan={checkoutPlan}
			/>
		</PageTemplate>
	);
}
