import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { action, mutation, query } from "../_generated/server";
import {
	readGlobalSettings,
	writeAutoSuspendEnabled,
	writeCertificateLimit,
	writeCheckoutEnabled,
	writeHetznerLimits,
	writeMaxActiveCheckoutIntentsPerUser,
	writeSnapshotPolicy,
	writeThresholds
} from "../settings";
import { MAX_ACTIVE_CHECKOUT_INTENTS_PER_USER } from "../model/settings";
import { requireCapability, requireCapabilityInAction } from "../users";
import { validateThresholds } from "../model/box/metric";
import { validateSnapshotPolicy } from "../boxes/snapshotPolicy";
import { readCapacityUsage } from "../boxes/capacity";
import { reconcileCapacityAlert } from "../boxes/capacity";

// The staff console's half of the settings row: who may change a setting, and
// what a valid value is. The row itself, and the alert a change raises, are
// `convex/settings.ts`.
//
// Every argument shape a setting accepts is declared here and nowhere else -
// this is the boundary untrusted input crosses, so it is the only place a
// validator earns its keep.

const vThresholds = v.array(
	v.object({
		signal: v.union(v.literal("egress_bandwidth"), v.literal("egress_pps")),
		value: v.number(),
		sustainedSamples: v.number()
	})
);

const vSnapshotPolicy = v.object({
	manualMinIntervalMinutes: v.number(),
	automaticRetentionDays: v.number()
});

// The validators below throw plain `Error`s, because they are also reached from
// paths with no caller to tell. A staff member typing into a form is the one
// caller who can act on the message, so it becomes a ConvexError here.
function reject(error: unknown, fallback: string): never {
	throw new ConvexError(error instanceof Error ? error.message : fallback);
}

export const get = query({
	args: {},
	handler: async (ctx) => {
		await requireCapability(ctx, "staff_console");
		const settings = await readGlobalSettings(ctx);
		return {
			...settings,
			capacity: await readCapacityUsage(ctx, settings)
		};
	}
});

export const setCheckoutEnabled = mutation({
	args: {
		enabled: v.boolean()
	},
	handler: async (ctx, args) => {
		const staffUser = await requireCapability(ctx, "settings_management");
		await writeCheckoutEnabled(ctx, args.enabled, staffUser.clerk_user_id);
	}
});

export const setAutoSuspendEnabled = mutation({
	args: {
		enabled: v.boolean()
	},
	handler: async (ctx, args) => {
		const staffUser = await requireCapability(ctx, "settings_management");
		await writeAutoSuspendEnabled(ctx, args.enabled, staffUser.clerk_user_id);
	}
});

// Pin the fleet's floor to whatever the channel currently resolves to.
//
// The floor is always set from the *resolved* release rather than a value typed
// into the console: a floor is a digest a box is compared against, and a
// hand-entered tag or version string would either not match any box or, worse,
// match by name while the box runs a different build. Staff choose the deadline;
// the image is whatever the deployment is already shipping.
//
// Omitting the deadline announces the floor without enforcing it - the interface
// tells owners they are behind and nothing updates itself.
export const setMinimumRuntimeToCurrent = action({
	args: {
		deadline: v.optional(v.number())
	},
	handler: async (ctx, args): Promise<void> => {
		const staffUser = await requireCapabilityInAction(
			ctx,
			"settings_management"
		);
		if (args.deadline !== undefined && args.deadline <= Date.now()) {
			throw new ConvexError(
				"A floor deadline must be in the future, or it updates every box below it on the next run."
			);
		}

		const release = await ctx.runAction(
			internal.boxes.infra.image.resolveConfiguredRuntimeRelease,
			{}
		);
		await ctx.runMutation(internal.settings.setMinimumRuntime, {
			deadline: args.deadline,
			image: release.image,
			version: release.version,
			updatedBy: staffUser.clerk_user_id
		});
	}
});

export const setHetznerLimits = mutation({
	args: {
		serverLimit: v.union(v.number(), v.null()),
		snapshotLimit: v.union(v.number(), v.null())
	},
	handler: async (ctx, args) => {
		const staffUser = await requireCapability(ctx, "settings_management");
		if ((args.serverLimit === null) !== (args.snapshotLimit === null)) {
			throw new ConvexError(
				"Set both Hetzner limits, or clear both to disable capacity admission."
			);
		}
		for (const [label, value] of [
			["Server limit", args.serverLimit],
			["Snapshot limit", args.snapshotLimit]
		] as const) {
			if (
				value !== null &&
				(!Number.isInteger(value) || value < 1 || value > 100_000)
			) {
				throw new ConvexError(
					`${label} must be a whole number between 1 and 100000.`
				);
			}
		}
		await writeHetznerLimits(ctx, args, staffUser.clerk_user_id);
		await reconcileCapacityAlert(ctx);
	}
});

// The apex's weekly Let's Encrypt allowance.
//
// Its own mutation rather than a third field on `setHetznerLimits`, because it
// is not a provider allocation: it changes when Let's Encrypt grants this
// deployment a rate limit adjustment, which has nothing to do with how many
// servers the provider will sell. Clearing it is allowed and closes checkout -
// capacity admission fails closed on an allowance it cannot read, for the same
// reason it does on a missing provider allocation.
export const setCertificateLimit = mutation({
	args: {
		weeklyLimit: v.union(v.number(), v.null())
	},
	handler: async (ctx, args) => {
		const staffUser = await requireCapability(ctx, "settings_management");
		if (
			args.weeklyLimit !== null &&
			(!Number.isInteger(args.weeklyLimit) ||
				args.weeklyLimit < 1 ||
				args.weeklyLimit > 100_000)
		) {
			throw new ConvexError(
				"Certificate limit must be a whole number between 1 and 100000."
			);
		}
		await writeCertificateLimit(ctx, args.weeklyLimit, staffUser.clerk_user_id);
		await reconcileCapacityAlert(ctx);
	}
});

export const setMaxActiveCheckoutIntentsPerUser = mutation({
	args: {
		max: v.number()
	},
	handler: async (ctx, args) => {
		const staffUser = await requireCapability(ctx, "settings_management");
		if (
			!Number.isInteger(args.max) ||
			args.max < 1 ||
			args.max > MAX_ACTIVE_CHECKOUT_INTENTS_PER_USER
		) {
			throw new ConvexError(
				`Limit must be a whole number between 1 and ${MAX_ACTIVE_CHECKOUT_INTENTS_PER_USER}.`
			);
		}
		await writeMaxActiveCheckoutIntentsPerUser(
			ctx,
			args.max,
			staffUser.clerk_user_id
		);
	}
});

export const setThresholds = mutation({
	args: {
		thresholds: vThresholds
	},
	handler: async (ctx, args) => {
		const staffUser = await requireCapability(ctx, "settings_management");

		try {
			validateThresholds(args.thresholds);
		} catch (error) {
			reject(error, "Invalid thresholds.");
		}

		await writeThresholds(ctx, args.thresholds, staffUser.clerk_user_id);
	}
});

export const setSnapshotPolicy = mutation({
	args: {
		policy: vSnapshotPolicy
	},
	handler: async (ctx, args) => {
		const staffUser = await requireCapability(ctx, "settings_management");

		try {
			validateSnapshotPolicy(args.policy);
		} catch (error) {
			reject(error, "Invalid snapshot policy.");
		}

		// No capacity check, and that is a fact about the policy rather than an
		// omission: a snapshot policy is timing only. How many snapshots a box may
		// hold is its plan's `snapshotCap`, and `reservedSnapshotCommitments` reads
		// that and the rows already taken - neither of which retention days or a
		// manual interval can move. This used to admit the policy against capacity
		// by comparing `readCapacityUsage` before and after; that function never
		// read the policy, so the comparison was of a value with itself and the
		// guard could not refuse anything.
		await writeSnapshotPolicy(ctx, args.policy, staffUser.clerk_user_id);
		await reconcileCapacityAlert(ctx);
	}
});
