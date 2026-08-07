import { BOX_PLANS, type BoxPlan } from "@/convex/model/box/plan";
import { formatDate } from "@/lib/datetime";

// The subscription behind a box, as far as its label is concerned. A comped box
// has none.
type Subscription = {
	cancelAtPeriodEnd?: boolean;
	currentPeriodEnd?: number | string | null;
} | null;

// What a box's billing action is called: the plan the box is on, and the next
// thing that plan will do. The box page puts this on a button and the box list
// puts it in a menu, so the wording lives here once.
//
// A comped box names its plan and stops there. There is no subscription behind it
// to renew or cancel, and the control carrying this label is disabled - saying
// "Billing date unavailable" about a box nobody is billed for would be a fault
// report about a box that is working exactly as intended.
export function billingLabel(
	box: { comp: boolean; plan: BoxPlan },
	subscription: Subscription | undefined
): string {
	const plan = BOX_PLANS[box.plan].label;
	if (box.comp) return `Comped - ${plan}`;

	// Empty for a date we do not have. A day nobody told us is not a report about
	// this box, so the label says what it knows instead.
	const periodEnd = formatDate(subscription?.currentPeriodEnd);
	if (subscription?.cancelAtPeriodEnd) {
		return `${plan} - ${periodEnd ? `Cancels ${periodEnd}` : "Cancellation scheduled"}`;
	}
	return `${plan} - ${periodEnd ? `Renews ${periodEnd}` : "Billing date unavailable"}`;
}
