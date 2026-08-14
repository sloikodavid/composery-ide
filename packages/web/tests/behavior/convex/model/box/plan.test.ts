import { describe, expect, test } from "vitest";
import {
	BOX_PLANS,
	BOX_PLAN_ORDER,
	boxPlanServerType,
	boxPlanSpecification,
	defaultManualSnapshotCap,
	isBoxPlan,
	isValidManualSnapshotCap,
	planAllowsManualSnapshots,
	resolveSnapshotSplit
} from "@/convex/model/box/plan";

// Figures are read from the table rather than written down here. A test that
// restated them would be a second copy of the catalogue, to be edited every time
// a plan is repriced or re-specced - exactly the duplication the table removes.
//
// There is deliberately no test that the table matches the schema's plan union.
// It used to be one, pinning `BOX_PLANS` against a separate list of plan names in
// the schema. The union is now `keyof typeof BOX_PLANS` and the order is
// `Object.keys` of it, so a plan cannot exist in one and not the other - the
// check could no longer fail, and a check that cannot fail is worse than none.
describe("box plans", () => {
	test("accepts only stored plan names", () => {
		expect(isBoxPlan("air")).toBe(true);
		expect(isBoxPlan("plus")).toBe(false);
		// The value arrives from a query string and from webhook metadata, so the
		// prototype chain must not answer for it.
		expect(isBoxPlan("constructor")).toBe(false);
		expect(isBoxPlan(undefined)).toBe(false);
	});

	test("gives each plan its own machine", () => {
		const types = BOX_PLAN_ORDER.map(boxPlanServerType);
		expect(new Set(types).size).toBe(types.length);
	});

	test("builds every specification from the machine it provisions", () => {
		for (const plan of BOX_PLAN_ORDER) {
			const { diskGb, ramGb, vcpu } = BOX_PLANS[plan];
			expect(boxPlanSpecification(plan)).toBe(
				`${vcpu} vCPU, ${ramGb} GB RAM, ${diskGb} GB NVMe`
			);
		}
	});
});

// The allowance is one number the plan sells; the split is one number the owner
// moves. Everything else is derived, which makes "the two halves sum to more
// than the plan allows" unrepresentable rather than merely validated.
describe("snapshot allowance", () => {
	test("splits a plan's allowance without ever exceeding it", () => {
		for (const plan of BOX_PLAN_ORDER) {
			for (let manual = 0; manual <= BOX_PLANS[plan].snapshotCap; manual += 1) {
				const split = resolveSnapshotSplit(plan, manual);
				expect(split.automatic + split.manual).toBe(
					BOX_PLANS[plan].snapshotCap
				);
				expect(split.automatic).toBeGreaterThanOrEqual(0);
				expect(split.manual).toBeGreaterThanOrEqual(0);
			}
		}
	});

	// A plan without manual snapshots gets its whole allowance as automatic ones
	// whatever is stored against it, so a hand-edited row cannot hand it a
	// capability it does not sell.
	test("gives a plan without manual snapshots its whole allowance automatically", () => {
		expect(planAllowsManualSnapshots("air")).toBe(false);
		for (const stored of [0, 2, 99, -1]) {
			expect(resolveSnapshotSplit("air", stored)).toEqual({
				automatic: BOX_PLANS.air.snapshotCap,
				manual: 0
			});
		}
	});

	// The failure direction that matters: the capacity accounting reads this, and
	// a negative would quietly under-reserve the fleet's provider quota.
	test("clamps a stored split that is out of range", () => {
		const cap = BOX_PLANS.pro.snapshotCap;
		expect(resolveSnapshotSplit("pro", cap + 10)).toEqual({
			automatic: 0,
			manual: cap
		});
		expect(resolveSnapshotSplit("pro", -5)).toEqual({
			automatic: cap,
			manual: 0
		});
	});

	test("falls back to the plan's default for a value that is not a whole number", () => {
		expect(resolveSnapshotSplit("pro", Number.NaN).manual).toBe(
			BOX_PLANS.pro.snapshotManualDefault
		);
		expect(resolveSnapshotSplit("pro", 1.5).manual).toBe(
			BOX_PLANS.pro.snapshotManualDefault
		);
	});

	test("creates a box on its plan's default split", () => {
		for (const plan of BOX_PLAN_ORDER) {
			expect(defaultManualSnapshotCap(plan)).toBe(
				planAllowsManualSnapshots(plan)
					? BOX_PLANS[plan].snapshotManualDefault
					: 0
			);
		}
	});

	// Both ends of the range are offered deliberately. All-automatic and
	// all-manual are both legitimate choices about one's own box, and one absolute
	// rule beats a rule plus a remembered exception.
	test("offers the whole range on a plan with manual snapshots", () => {
		const cap = BOX_PLANS.pro.snapshotCap;
		for (let manual = 0; manual <= cap; manual += 1) {
			expect(isValidManualSnapshotCap("pro", manual)).toBe(true);
		}
		expect(isValidManualSnapshotCap("pro", cap + 1)).toBe(false);
		expect(isValidManualSnapshotCap("pro", -1)).toBe(false);
		expect(isValidManualSnapshotCap("pro", 1.5)).toBe(false);
	});

	test("offers no split at all on a plan without manual snapshots", () => {
		expect(isValidManualSnapshotCap("air", 0)).toBe(true);
		expect(isValidManualSnapshotCap("air", 1)).toBe(false);
	});

	// Not an arbitrary preference: the automatic snapshots are the disaster
	// recovery every box is sold with, so a plan whose default left none of them
	// would ship boxes with no safety net unless their owner noticed.
	test("leaves every plan with automatic snapshots by default", () => {
		for (const plan of BOX_PLAN_ORDER) {
			expect(
				resolveSnapshotSplit(plan, defaultManualSnapshotCap(plan)).automatic
			).toBeGreaterThan(0);
		}
	});
});
