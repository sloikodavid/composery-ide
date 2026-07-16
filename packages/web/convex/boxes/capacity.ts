import type { Doc } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { boxStatusesExcept, type BoxStatus } from "../model/box/status";
import type {
	CapacityBlockReason,
	CapacityLimitBlockReason
} from "../model/box/capacity";
import {
	certificateHeadroom,
	CERTIFICATE_ISSUING_OPERATIONS,
	CERTIFICATE_WEEK_MS
} from "../model/box/certificate";
import { type BoxPlan, BOX_PLANS, BOX_PLAN_ORDER } from "../model/box/plan";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { readGlobalSettings } from "../settings";
import { staffConsoleUrl } from "../env";
import { raiseAlert } from "../staff/alerts";

// Every status but "deleted" holds a Hetzner server, so every one of them counts
// against the allocation.
export const CAPACITY_BOX_STATUSES: readonly BoxStatus[] =
	boxStatusesExcept("deleted");

const SNAPSHOT_COMMITMENT_STATUSES = new Set<Doc<"box_snapshots">["status"]>([
	"pending",
	"creating",
	"complete"
]);

// Re-exported rather than redeclared. The names live in `model/box/capacity.ts`
// because the schema builds the stored column from them and cannot import this
// module without closing a cycle; every reader still gets them from here.
export type {
	CapacityBlockReason,
	CapacityLimitBlockReason
} from "../model/box/capacity";

// The settings capacity is a function of, and only those. It named
// `snapshotPolicy` too, which nothing here ever read - and one caller believed
// that name enough to admit a policy change against a before/after comparison
// that could only ever return the same number. A policy is timing; how many
// snapshots a box commits is its plan's `snapshotCap`.
export type CapacityConfig = {
	checkoutEnabled: boolean;
	hetznerServerLimit: number | null;
	hetznerSnapshotLimit: number | null;
	// The apex's weekly Let's Encrypt allowance. A fleet-wide resource a new box
	// commits, exactly like the two above, which is why it is admitted here
	// rather than by a mechanism of its own - see `model/box/certificate.ts` for
	// why the per-box reissue cap is a *different* limit and stays separate.
	certificateWeeklyLimit: number | null;
};

export type CapacityUsage = {
	activeCheckoutCount: number;
	availableNewBoxes: number;
	blockReason: CapacityBlockReason;
	checkoutAvailable: boolean;
	limitBlockReason: CapacityLimitBlockReason | null;
	liveBoxCount: number;
	serverCommitments: number;
	snapshotCommitments: number;
	snapshotSlotsPerBox: number;
	// This week's certificate position, for the staff console. Both numbers, not
	// just the creation one: the console's job is to show why checkout is closed,
	// and "creation is out but recovery still has room" is the state the reserve
	// exists to produce - a single number would hide the mechanism working.
	certificatesForCreation: number;
	certificatesForRecovery: number;
	issuedCertificatesThisWeek: number;
};

export function capacityBlockMessage(reason: CapacityBlockReason) {
	switch (reason) {
		case "manual_pause":
			return "New box checkout is temporarily paused.";
		case "limits_not_configured":
			return "New box checkout is temporarily unavailable while infrastructure capacity is configured.";
		case "server_limit":
			return "New box checkout is temporarily unavailable because server capacity is fully committed.";
		case "snapshot_limit":
			return "New box checkout is temporarily unavailable because snapshot capacity is fully committed.";
		case "certificate_limit":
			// Deliberately does not say "try again later" with a date. The week is a
			// rolling window over issuances nobody here can see the timestamps of,
			// so naming a moment would be inventing one.
			return "New box checkout is temporarily unavailable because this week's certificate allowance is committed.";
		default:
			return null;
	}
}

// Snapshot slots every box holds outside the allowance its plan sells, because
// the deployment - not the owner - decides when to fill them:
//
//   1. the box's undo point, taken before an operation that cannot be undone;
//   2. its replacement, captured while a restore from the first one is running,
//      which is the one moment both exist at once;
//   3. the copy Duplicate takes, which is held for the life of the new box's
//      checkout and therefore coexists with either of the two above - an owner
//      can press Duplicate and then update the source while that checkout is
//      still open.
//
// They are reserved rather than taken out of the plan's allowance so that an
// owner who has filled every slot they bought still gets an undo point, and so
// that no snapshot they took is ever evicted to make room for one of ours.
//
// Raise this when a feature adds a system-owned snapshot that can coexist with
// these.
export const RESERVED_SNAPSHOT_SLOTS = 3;

// The snapshot entitlement one box of this plan commits, whether or not it has
// used any of it.
//
// The plan's total, not the box's split: moving the slider between automatic and
// manual moves slots from one column to the other and never changes how many the
// box can hold, so the fleet's commitment is unaffected by it. That is the whole
// reason the plan sells a total rather than two separate caps.
//
// The reserved slots are added on top, because capacity admission is the one
// place that decides whether the provider allocation can carry another box - and
// a box this deployment will take snapshots of costs those images whether or not
// they were sold.
export function snapshotSlotsForPlan(plan: BoxPlan) {
	return BOX_PLANS[plan].snapshotCap + RESERVED_SNAPSHOT_SLOTS;
}

// What admitting one more box has to reserve, before anyone has said which plan
// they are buying. The pricing page asks whether checkout is open at all, so the
// answer cannot depend on a choice that has not been made yet - and the safe
// direction is the expensive plan: room for a Pro box is room for an Air box,
// while the reverse is not true.
export function largestSnapshotSlotsPerBox() {
	return Math.max(...BOX_PLAN_ORDER.map(snapshotSlotsForPlan));
}

export function capacityAvailability({
	activeCheckoutCount,
	certificateWeeklyLimit,
	checkoutEnabled,
	hetznerServerLimit,
	hetznerSnapshotLimit,
	issuedCertificatesThisWeek,
	liveBoxCount,
	snapshotCommitments,
	snapshotSlotsPerBox: slotsPerBox
}: {
	activeCheckoutCount: number;
	certificateWeeklyLimit: number | null;
	checkoutEnabled: boolean;
	hetznerServerLimit: number | null;
	hetznerSnapshotLimit: number | null;
	issuedCertificatesThisWeek: number;
	liveBoxCount: number;
	snapshotCommitments: number;
	snapshotSlotsPerBox: number;
}): CapacityUsage {
	const serverCommitments = liveBoxCount + activeCheckoutCount;
	const configured =
		hetznerServerLimit !== null &&
		hetznerSnapshotLimit !== null &&
		certificateWeeklyLimit !== null;
	const serverRemaining = configured
		? Math.max(0, hetznerServerLimit - serverCommitments)
		: 0;
	const snapshotRemaining = configured
		? Math.max(0, hetznerSnapshotLimit - snapshotCommitments)
		: 0;
	// Every active reservation will become a box that asks for a certificate, so
	// they are counted alongside the operations that already have. Without that,
	// twenty simultaneous checkouts would each be admitted against a week that
	// looked empty and would exhaust the apex between them after admission.
	const certificates = certificateHeadroom({
		issuedThisWeek: issuedCertificatesThisWeek + activeCheckoutCount,
		limit: certificateWeeklyLimit
	});

	const availableNewBoxes = configured
		? Math.min(
				serverRemaining,
				Math.floor(snapshotRemaining / slotsPerBox),
				certificates.forCreation
			)
		: 0;

	let limitBlockReason: CapacityLimitBlockReason | null = null;
	if (configured && serverRemaining < 1) limitBlockReason = "server_limit";
	else if (configured && snapshotRemaining < slotsPerBox)
		limitBlockReason = "snapshot_limit";
	// Last of the three, so a deployment that is out of servers says so rather
	// than blaming a certificate ceiling it also happens to be near.
	else if (configured && certificates.forCreation < 1)
		limitBlockReason = "certificate_limit";

	let blockReason: CapacityBlockReason = null;
	if (!checkoutEnabled) blockReason = "manual_pause";
	else if (!configured) blockReason = "limits_not_configured";
	else blockReason = limitBlockReason;

	return {
		activeCheckoutCount,
		availableNewBoxes,
		blockReason,
		checkoutAvailable: blockReason === null,
		limitBlockReason,
		liveBoxCount,
		serverCommitments,
		snapshotCommitments,
		snapshotSlotsPerBox: slotsPerBox,
		certificatesForCreation: certificates.forCreation,
		certificatesForRecovery: certificates.forRecovery,
		issuedCertificatesThisWeek
	};
}

// How many certificates this deployment has caused in the last week, fleet-wide.
//
// Bounded by time, never by a row cap. A `.take(n)` here would be a limit that
// stops being enforced exactly when the fleet is busiest - the same defect
// `autoRepairFacts` records, except this one fails for every box at once rather
// than for one. One query per issuing operation type, each asking the index for
// exactly the rows in the window.
export async function issuedCertificatesThisWeek(
	ctx: { db: DatabaseReader },
	now: number = Date.now()
) {
	let issued = 0;
	for (const type of CERTIFICATE_ISSUING_OPERATIONS) {
		const rows = await ctx.db
			.query("box_operations")
			.withIndex("type_created_at", (query) =>
				query.eq("type", type).gte("created_at", now - CERTIFICATE_WEEK_MS)
			)
			.collect();
		issued += rows.length;
	}
	return issued;
}

export function reservedSnapshotCommitments({
	activeCheckoutPlans,
	liveBoxes,
	snapshotRows
}: {
	activeCheckoutPlans: readonly BoxPlan[];
	liveBoxes: readonly { id: string; plan: BoxPlan }[];
	snapshotRows: readonly {
		boxId: string;
		imageId?: number;
		status: Doc<"box_snapshots">["status"];
	}[];
}) {
	const activeSnapshotsByBox = new Map<string, number>();
	let commitments = 0;
	for (const snapshot of snapshotRows) {
		const active = SNAPSHOT_COMMITMENT_STATUSES.has(snapshot.status);
		if (active) {
			activeSnapshotsByBox.set(
				snapshot.boxId,
				(activeSnapshotsByBox.get(snapshot.boxId) ?? 0) + 1
			);
		}
		if (active || snapshot.imageId !== undefined) commitments += 1;
	}

	// Each live box reserves its own plan's entitlement, counting the slots it has
	// already filled towards it rather than on top of it. A box that has more
	// snapshots than its plan now entitles it to - because it was downgraded while
	// holding manual ones - reserves nothing further; those rows are already
	// counted above, so the arithmetic stays honest without a special case.
	for (const box of liveBoxes) {
		const slots = snapshotSlotsForPlan(box.plan);
		commitments += Math.max(0, slots - (activeSnapshotsByBox.get(box.id) ?? 0));
	}
	for (const plan of activeCheckoutPlans) {
		commitments += snapshotSlotsForPlan(plan);
	}
	return commitments;
}

export async function readCapacityUsage(
	ctx: { db: DatabaseReader },
	config: CapacityConfig
): Promise<CapacityUsage> {
	const liveBoxes: { id: string; plan: BoxPlan }[] = [];
	for (const status of CAPACITY_BOX_STATUSES) {
		const boxes = await ctx.db
			.query("boxes")
			.withIndex("status", (query) => query.eq("status", status))
			.collect();
		for (const box of boxes) liveBoxes.push({ id: box._id, plan: box.plan });
	}

	const activeCheckouts = await ctx.db
		.query("box_checkout_intents")
		.withIndex("status_created_at", (query) => query.eq("status", "active"))
		.collect();
	const activeCheckoutPlans = activeCheckouts
		.filter((intent) => !intent.box_id)
		.map((intent) => intent.plan);

	const slotsPerBox = largestSnapshotSlotsPerBox();
	const snapshots = await ctx.db.query("box_snapshots").collect();
	// Pending captures already promise a future provider image. Failed or
	// deleting rows count only while they still reference an image that exists
	// (or is being removed) at Hetzner.
	const snapshotCommitments = reservedSnapshotCommitments({
		activeCheckoutPlans,
		liveBoxes,
		snapshotRows: snapshots.map((snapshot) => ({
			boxId: snapshot.box_id,
			imageId: snapshot.hetzner_image_id,
			status: snapshot.status
		}))
	});

	return capacityAvailability({
		activeCheckoutCount: activeCheckoutPlans.length,
		certificateWeeklyLimit: config.certificateWeeklyLimit,
		checkoutEnabled: config.checkoutEnabled,
		hetznerServerLimit: config.hetznerServerLimit,
		hetznerSnapshotLimit: config.hetznerSnapshotLimit,
		issuedCertificatesThisWeek: await issuedCertificatesThisWeek(ctx),
		liveBoxCount: liveBoxes.length,
		snapshotCommitments,
		snapshotSlotsPerBox: slotsPerBox
	});
}

type CapacityAlertTransition =
	| { type: "none" }
	| { type: "clear" }
	| { type: "blocked"; reason: CapacityLimitBlockReason }
	| { type: "recovered"; reason: CapacityLimitBlockReason };

export function capacityAlertTransition(
	previous: CapacityLimitBlockReason | null,
	usage: Pick<CapacityUsage, "blockReason" | "limitBlockReason">
): CapacityAlertTransition {
	if (usage.limitBlockReason === previous) return { type: "none" };
	if (usage.limitBlockReason) {
		return { type: "blocked", reason: usage.limitBlockReason };
	}
	// Unreachable, and kept because the type system cannot see that: getting here
	// means `limitBlockReason` is null *and* differs from `previous`, so `previous`
	// is not null. The two returns below need that, and there is no assertion-free
	// way to tell TypeScript. No test can distinguish either branch of it.
	// Stryker disable next-line ConditionalExpression,ObjectLiteral,StringLiteral: unreachable narrowing - the first comparison above already returned for every input that could reach it with a null `previous`.
	if (!previous) return { type: "none" };
	if (usage.blockReason === "limits_not_configured") return { type: "clear" };
	return { type: "recovered", reason: previous };
}

function capacityLabel(reason: CapacityLimitBlockReason) {
	return reason === "server_limit" ? "server" : "snapshot";
}

export async function reconcileCapacityAlert(ctx: MutationCtx) {
	const stored = await ctx.db.query("settings").first();
	const settings = await readGlobalSettings(ctx);
	const usage = await readCapacityUsage(ctx, settings);
	const transition = capacityAlertTransition(
		stored?.capacity_alert_reason ?? null,
		usage
	);
	if (transition.type === "none") return transition;

	// Also unreachable, for the same shape of reason: with no settings row there
	// are no limits, so `readCapacityUsage` reports `limits_not_configured` with
	// no limit block, and `capacityAlertTransition` has already returned "none"
	// above. It stays because `stored` is what the patches below write to.
	// Stryker disable next-line ConditionalExpression: no settings row means no limits, which the "none" return above has already handled.
	if (!stored) return transition;
	if (transition.type === "clear") {
		await ctx.db.patch(stored._id, {
			capacity_alert_reason: undefined,
			capacity_alert_started_at: undefined
		});
		return transition;
	}

	if (transition.type === "blocked") {
		const startedAt = Date.now();
		await ctx.db.patch(stored._id, {
			capacity_alert_reason: transition.reason,
			capacity_alert_started_at: startedAt
		});
		const label = capacityLabel(transition.reason);
		await raiseAlert(ctx, {
			key: `capacity-exhausted:${transition.reason}:${startedAt}`,
			severity: "critical",
			subject: `New box ${label} capacity is exhausted`,
			text: `The configured Hetzner ${label} allocation can no longer fit another complete box package. New checkout is blocked by capacity admission; existing boxes are unaffected.\n\nReview commitments and the provider allocation: ${staffConsoleUrl()}`
		});
		return transition;
	}

	const startedAt = stored.capacity_alert_started_at ?? Date.now();
	await ctx.db.patch(stored._id, {
		capacity_alert_reason: undefined,
		capacity_alert_started_at: undefined
	});
	await raiseAlert(ctx, {
		key: `capacity-recovered:${transition.reason}:${startedAt}`,
		severity: "resolved",
		subject: `New box ${capacityLabel(transition.reason)} capacity recovered`,
		text: `The previous ${capacityLabel(transition.reason)} capacity block has cleared. Checkout is ${usage.checkoutAvailable ? "available" : "still unavailable for another reason"}.\n\nReview the current state: ${staffConsoleUrl()}`
	});
	return transition;
}

export const reconcile = internalMutation({
	args: {},
	handler: async (ctx) => await reconcileCapacityAlert(ctx)
});
