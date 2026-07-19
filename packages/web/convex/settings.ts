import { v } from "convex/values";
import {
	internalMutation,
	type DatabaseReader,
	type MutationCtx
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type {
	StoredRuntimeRelease,
	StoredSnapshotPolicy,
	StoredThreshold
} from "./schema";
import {
	thresholdsToStored,
	resolveThresholds,
	type ThresholdSetting
} from "./model/box/metric";
import {
	resolveSnapshotPolicy,
	snapshotPolicyToStored,
	type SnapshotPolicy
} from "./boxes/snapshotPolicy";
import { DEFAULT_MAX_ACTIVE_CHECKOUT_INTENTS_PER_USER } from "./model/settings";
import { staffConsoleUrl } from "./env";
import { raiseAlert } from "./staff/alerts";

// The deployment's one settings row: how it is read, and every way it changes.
//
// The `write*` functions are plain functions rather than internal mutations, because the
// only thing that changes a setting deliberately is a staff mutation in
// `staff/settings.ts` - and a mutation calling a mutation runs in the same
// transaction anyway, so the hop bought nothing but a second copy of every
// argument validator. Two of those validators (thresholds, snapshot policy) were
// literally written out twice, which is exactly the drift a shape declared once
// at the public boundary cannot have.
//
// What survives as a Convex function below is only what an *action* has to
// reach, since an action has no `db`.

// The alert a setting change raises has to reach the mail component, so a
// writer here is the whole mutation ctx rather than just its `db`.
type Writer = MutationCtx;

async function globalSettings(ctx: { db: DatabaseReader }) {
	return await ctx.db.query("settings").first();
}

export async function readGlobalSettings(ctx: { db: DatabaseReader }) {
	const settings = await globalSettings(ctx);

	return {
		checkoutEnabled: settings?.checkout_enabled ?? true,
		hetznerServerLimit: settings?.hetzner_server_limit ?? null,
		hetznerSnapshotLimit: settings?.hetzner_snapshot_limit ?? null,
		certificateWeeklyLimit: settings?.certificate_weekly_limit ?? null,
		autoSuspendEnabled: settings?.auto_suspend_enabled ?? false,
		maxActiveCheckoutIntentsPerUser:
			settings?.max_active_checkout_intents_per_user ??
			DEFAULT_MAX_ACTIVE_CHECKOUT_INTENTS_PER_USER,
		thresholds: resolveThresholds(settings?.thresholds),
		snapshotPolicy: resolveSnapshotPolicy(settings?.snapshot_policy),
		runtimeRelease: settings?.runtime_release ?? null,
		minimumRuntime: resolveMinimumRuntime(settings),
		updatedAt: settings?.updated_at ?? null,
		updatedBy: settings?.updated_by ?? null
	};
}

export type MinimumRuntime = {
	deadline: number | null;
	image: string;
	version: string | null;
};

// The floor, or null when none is set. It only exists once an image is named:
// a deadline with no image would silently apply to nothing, and a version
// string alone is a label, not something a box can be compared against.
function resolveMinimumRuntime(
	settings: Doc<"settings"> | null
): MinimumRuntime | null {
	if (!settings?.minimum_runtime_image) return null;
	return {
		image: settings.minimum_runtime_image,
		version: settings.minimum_runtime_version ?? null,
		deadline: settings.minimum_runtime_deadline ?? null
	};
}

// The audit stamp belongs to the actor, so it is written only when there is one.
//
// `db.patch` deletes a field it is given as `undefined`, so a write that simply
// forwarded an absent actor did not leave the attribution alone - it erased it,
// and reset `updated_at` to the moment of a machine write. The hourly release
// refresh does exactly that kind of write, which left the console's record of
// who last changed the settings permanently blank and never more than an hour
// old. An actor is now either present, and stamped, or absent, and the last
// staff edit is left standing.
async function patchGlobalSettings(
	ctx: Writer,
	patch: {
		auto_suspend_enabled?: boolean;
		checkout_enabled?: boolean;
		hetzner_server_limit?: number;
		hetzner_snapshot_limit?: number;
		certificate_weekly_limit?: number;
		max_active_checkout_intents_per_user?: number;
		thresholds?: StoredThreshold[];
		snapshot_policy?: StoredSnapshotPolicy;
		runtime_release?: StoredRuntimeRelease;
		minimum_runtime_image?: string;
		minimum_runtime_version?: string;
		minimum_runtime_deadline?: number;
	},
	updatedBy?: string
) {
	const now = Date.now();
	const settings = await globalSettings(ctx);

	if (settings) {
		await ctx.db.patch(settings._id, {
			...patch,
			...(updatedBy ? { updated_at: now, updated_by: updatedBy } : {})
		});
		return;
	}

	await ctx.db.insert("settings", {
		...patch,
		checkout_enabled: patch.checkout_enabled ?? true,
		updated_at: now,
		updated_by: updatedBy
	});
}

export async function writeCheckoutEnabled(
	ctx: Writer,
	checkoutEnabled: boolean,
	updatedBy: string
) {
	const previous = await readGlobalSettings(ctx);
	await patchGlobalSettings(
		ctx,
		{ checkout_enabled: checkoutEnabled },
		updatedBy
	);
	if (previous.checkoutEnabled === checkoutEnabled) return;

	const state = checkoutEnabled ? "enabled" : "disabled";
	await raiseAlert(ctx, {
		key: `checkout-${state}:${Date.now()}:${updatedBy}`,
		severity: checkoutEnabled ? "resolved" : "critical",
		subject: `Checkout ${state}`,
		text: `New box checkout was ${state} by ${updatedBy}.\n\nReview capacity and checkout state: ${staffConsoleUrl()}`
	});
}

export async function writeHetznerLimits(
	ctx: Writer,
	limits: { serverLimit: number | null; snapshotLimit: number | null },
	updatedBy: string
) {
	const previous = await readGlobalSettings(ctx);
	await patchGlobalSettings(
		ctx,
		{
			hetzner_server_limit: limits.serverLimit ?? undefined,
			hetzner_snapshot_limit: limits.snapshotLimit ?? undefined
		},
		updatedBy
	);
	const wasConfigured =
		previous.hetznerServerLimit !== null &&
		previous.hetznerSnapshotLimit !== null;
	const configured =
		limits.serverLimit !== null && limits.snapshotLimit !== null;
	if (!wasConfigured || configured) return;

	await raiseAlert(ctx, {
		key: `capacity-admission-disabled:${Date.now()}:${updatedBy}`,
		severity: "critical",
		subject: "Capacity admission disabled",
		text: `Hetzner server and snapshot allocations were removed by ${updatedBy}. New checkout now fails closed until both are configured.\n\nReview the allocation: ${staffConsoleUrl()}`
	});
}

// The apex's weekly Let's Encrypt allowance.
//
// Its own writer rather than a third argument to `writeHetznerLimits`: it is not
// a provider allocation and does not move when that one does. Removing it closes
// checkout for the same reason removing the Hetzner allocations does - capacity
// admission fails closed on a limit it cannot read, because the alternative is
// finding the real ceiling by exhausting it and taking every box's reset with it.
export async function writeCertificateLimit(
	ctx: Writer,
	certificateWeeklyLimit: number | null,
	updatedBy: string
) {
	const previous = await readGlobalSettings(ctx);
	await patchGlobalSettings(
		ctx,
		{ certificate_weekly_limit: certificateWeeklyLimit ?? undefined },
		updatedBy
	);
	if (
		previous.certificateWeeklyLimit === null ||
		certificateWeeklyLimit !== null
	)
		return;

	await raiseAlert(ctx, {
		key: `certificate-budget-removed:${Date.now()}:${updatedBy}`,
		severity: "critical",
		subject: "Certificate budget removed",
		text: `The weekly Let's Encrypt allowance was removed by ${updatedBy}. New checkout now fails closed until it is configured.\n\nReview the allowance: ${staffConsoleUrl()}`
	});
}

export async function writeAutoSuspendEnabled(
	ctx: Writer,
	autoSuspendEnabled: boolean,
	updatedBy: string
) {
	const previous = await readGlobalSettings(ctx);
	await patchGlobalSettings(
		ctx,
		{ auto_suspend_enabled: autoSuspendEnabled },
		updatedBy
	);
	if (previous.autoSuspendEnabled === autoSuspendEnabled) return;

	const state = autoSuspendEnabled ? "enabled" : "disabled";
	await raiseAlert(ctx, {
		key: `auto-suspend-${state}:${Date.now()}:${updatedBy}`,
		severity: autoSuspendEnabled ? "warning" : "critical",
		subject: `Automatic suspension ${state}`,
		text: `Automatic abuse suspension was ${state} by ${updatedBy}.\n\nReview the thresholds and current flags: ${staffConsoleUrl()}`
	});
}

export async function writeMaxActiveCheckoutIntentsPerUser(
	ctx: Writer,
	max: number,
	updatedBy: string
) {
	await patchGlobalSettings(
		ctx,
		{ max_active_checkout_intents_per_user: max },
		updatedBy
	);
}

export async function writeThresholds(
	ctx: Writer,
	thresholds: readonly ThresholdSetting[],
	updatedBy: string
) {
	await patchGlobalSettings(
		ctx,
		{ thresholds: thresholdsToStored(thresholds) },
		updatedBy
	);
}

export async function writeSnapshotPolicy(
	ctx: Writer,
	policy: SnapshotPolicy,
	updatedBy: string
) {
	await patchGlobalSettings(
		ctx,
		{ snapshot_policy: snapshotPolicyToStored(policy) },
		updatedBy
	);
}

// Stop selling boxes, from an action.
//
// Deliberately one-way. The two callers are provider quota failures in
// `boxes/infra/hetznerVps.ts`, and both close checkout; a generic boolean
// reachable from any action could also re-open it, which is a decision that
// belongs to a person looking at the Hetzner allocation. Turning it back on is
// the staff mutation, and only that.
export const closeCheckout = internalMutation({
	args: {
		by: v.string()
	},
	handler: async (ctx, args) => {
		await writeCheckoutEnabled(ctx, false, args.by);
	}
});

export const recordRuntimeRelease = internalMutation({
	args: {
		image: v.string(),
		version: v.union(v.string(), v.null())
	},
	handler: async (ctx, args) => {
		// Written by the schedule, not by a person, so it passes no actor and the
		// audit stamp is left alone - a refresh is not a staff edit of the settings.
		await patchGlobalSettings(ctx, {
			runtime_release: {
				image: args.image,
				version: args.version,
				checked_at: Date.now()
			}
		});
	}
});

// The floor is pinned to a resolved release, which only an action can read, so
// unlike the settings above this one is reached through a mutation.
export const setMinimumRuntime = internalMutation({
	args: {
		deadline: v.optional(v.number()),
		image: v.string(),
		version: v.union(v.string(), v.null()),
		updatedBy: v.string()
	},
	handler: async (ctx, args) => {
		await patchGlobalSettings(
			ctx,
			{
				minimum_runtime_image: args.image,
				minimum_runtime_version: args.version ?? undefined,
				minimum_runtime_deadline: args.deadline
			},
			args.updatedBy
		);

		const deadline = args.deadline
			? new Date(args.deadline).toISOString()
			: "no deadline";
		await raiseAlert(ctx, {
			key: `minimum-runtime-set:${args.image}:${args.deadline ?? "none"}`,
			severity: "warning",
			subject: "Minimum runtime version raised",
			// Raising the floor is what retires a compatibility path, so the alert
			// names the obligation rather than just the value: until every box has
			// crossed it, the control plane still has to read older boxes.
			text: `${args.updatedBy} set the minimum runtime version to ${args.version ?? args.image} (${deadline}).\n\nBoxes below the floor are warned until the deadline and updated automatically after it. Until they have all crossed, the readers in packages/web/convex/boxes/infra/ must keep working with the older version.\n\nReview the fleet: ${staffConsoleUrl()}`
		});
	}
});
