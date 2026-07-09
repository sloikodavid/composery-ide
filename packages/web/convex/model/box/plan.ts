// The catalogue of sellable boxes. One row per plan, and every surface reads it:
// the Polar products a checkout may sell, the Hetzner machine the box runs on,
// the specification the pricing page prints, and the snapshot allowance the box
// gets. Nothing restates any of it - not the pricing page, not the docs, not the
// console - so a plan is changed here and everywhere follows.
//
// No price lives here for the same reason none lives in `box-billing.ts`: Polar
// owns it, and it can be repriced without touching this repo.
//
// A box's plan is fixed when it is bought. Nothing moves a box between plans
// afterwards, so nothing here has to describe a transition, be reachable from
// another plan, or hold in both directions - which is why each row can simply be
// the machine that plan sells.
// The Hetzner machines a plan may sell. Declared here rather than in the schema
// because a plan is what decides one: `convex/schema.ts` builds `vServerType`
// from this list, so a machine nothing sells cannot be stored on a box.
export const SERVER_TYPES = ["cx23", "cx43"] as const;

export type ServerType = (typeof SERVER_TYPES)[number];

type PlanDefinition = {
	descriptor: string;
	diskGb: number;
	label: string;
	// Whether any of this plan's snapshot allowance may be spent on snapshots the
	// owner takes themselves. A plan without it gets the whole allowance as the
	// automatic daily ones - which are disaster recovery, not a feature.
	manualSnapshots: boolean;
	ramGb: number;
	serverType: ServerType;
	// Snapshots this plan includes in total, however they are split. One number
	// rather than two, because the total is what a box costs the fleet's snapshot
	// quota, and the split is the owner's to move.
	snapshotCap: number;
	// How many of that allowance a new box reserves for manual snapshots. Ignored,
	// and pinned to zero, on a plan without them.
	snapshotManualDefault: number;
	// Outbound traffic the plan includes each month, in decimal terabytes - the
	// unit the provider bills in. It is the only allowance on a box that is not a
	// property of the machine, so it is stated per plan rather than derived from
	// the server type: what a box may send is what Composery sells, and the
	// provider's own included amount is the floor under it rather than the promise.
	// `boxes/usage.ts` alerts staff if the provider ever reports less than this.
	trafficTb: number;
	vcpu: number;
};

export const BOX_PLANS = {
	air: {
		descriptor: "..with a secure + always-on Composery.",
		diskGb: 40,
		label: "Box Air",
		manualSnapshots: false,
		ramGb: 4,
		serverType: "cx23",
		snapshotCap: 3,
		snapshotManualDefault: 0,
		trafficTb: 20,
		vcpu: 2
	},
	pro: {
		descriptor: "..with room to actually build on.",
		diskGb: 160,
		label: "Box Pro",
		manualSnapshots: true,
		ramGb: 16,
		serverType: "cx43",
		snapshotCap: 5,
		snapshotManualDefault: 2,
		trafficTb: 20,
		vcpu: 8
	}
} as const satisfies Record<string, PlanDefinition>;

export type BoxPlan = keyof typeof BOX_PLANS;

// Cheapest first. The pricing page lays its cards out in this order and the
// console lists them in it, so "which way is up" is stated once - and it is the
// declaration order above rather than a second list, which is what stops a plan
// from existing in one and not the other.
export const BOX_PLAN_ORDER = Object.keys(BOX_PLANS) as BoxPlan[];

// Object.hasOwn, not `in`: values arrive from the ?plan= query string and from
// Polar webhook metadata, and `in` walks the prototype chain, so "constructor"
// would pass.
export function isBoxPlan(value: unknown): value is BoxPlan {
	return typeof value === "string" && Object.hasOwn(BOX_PLANS, value);
}

export function boxPlanServerType(plan: BoxPlan): ServerType {
	return BOX_PLANS[plan].serverType;
}

export function planAllowsManualSnapshots(plan: BoxPlan) {
	return BOX_PLANS[plan].manualSnapshots;
}

// "X vCPU, X GB RAM, X GB NVMe" - the one place that sentence is built, so a
// plan whose machine changes cannot keep advertising the old one.
export function boxPlanSpecification(plan: BoxPlan) {
	const { diskGb, ramGb, vcpu } = BOX_PLANS[plan];
	return `${vcpu} vCPU, ${ramGb} GB RAM, ${diskGb} GB NVMe`;
}

export type SnapshotSplit = {
	automatic: number;
	manual: number;
};

// How a box's snapshot allowance is divided, from the one number stored on it.
//
// Only the manual half is stored and the automatic half is the remainder, so the
// two can never disagree and their sum can never exceed what the plan sells - the
// invariant is arithmetic rather than a validation someone has to remember. Every
// reader goes through here, including the capacity accounting, so a stored value
// that is out of range (a plan's allowance lowered under a box that had already
// spent it, a hand-edited row) resolves to something coherent instead of leaking
// a negative into the fleet's quota.
export function resolveSnapshotSplit(
	plan: BoxPlan,
	storedManualCap: number
): SnapshotSplit {
	const { manualSnapshots, snapshotCap } = BOX_PLANS[plan];
	if (!manualSnapshots) return { automatic: snapshotCap, manual: 0 };

	const manual = Number.isInteger(storedManualCap)
		? Math.min(Math.max(storedManualCap, 0), snapshotCap)
		: BOX_PLANS[plan].snapshotManualDefault;
	return { automatic: snapshotCap - manual, manual };
}

// What a box of this plan is created with. A plan without manual snapshots is
// pinned to zero here rather than trusting a caller to pass it.
export function defaultManualSnapshotCap(plan: BoxPlan) {
	return resolveSnapshotSplit(plan, BOX_PLANS[plan].snapshotManualDefault)
		.manual;
}

// Whether an owner may set this many of their allowance aside for manual
// snapshots. The whole range is offered deliberately, including both ends: a box
// with every slot automatic and none manual is a legitimate choice, and so is the
// reverse. The interface says what each end means rather than a rule here
// forbidding one of them.
export function isValidManualSnapshotCap(plan: BoxPlan, manualCap: number) {
	if (!Number.isInteger(manualCap) || manualCap < 0) return false;
	if (!BOX_PLANS[plan].manualSnapshots) return manualCap === 0;
	return manualCap <= BOX_PLANS[plan].snapshotCap;
}
