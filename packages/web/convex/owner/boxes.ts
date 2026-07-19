import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { components, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { action, mutation, query, type QueryCtx } from "../_generated/server";
import {
	currentUserForRead,
	requireActiveUser,
	requireActiveUserInAction
} from "../users";
import { fetchRuntimeLogsSafely } from "../boxes/logs";
import { vRecoveryStatus, type RecoveryStatus } from "../model/box/recovery";
import { boxMetricsSamples, vMetricsRange } from "../boxes/metrics";
import { boxUsage } from "../boxes/usage";
import {
	requireOwnerBox,
	requireOwnerBoxInAction,
	startFor,
	startForOrFail
} from "../boxes/operation/endpoint";
import {
	currentSuspensionReason,
	findOwnedBoxBySlug,
	requireOwnedSnapshot
} from "../boxes/queries";
import { normalizeDomain, requiredEnv, runtimeDomain } from "../env";
import {
	isValidCustomDomain,
	normalizeCustomDomain
} from "../model/box/domain";
import { sshSetupPrompt } from "shared";
import { vSshCertificate, type SshCertificate } from "../model/box/ssh";
// Port 22 on a box is the instance's own sshd: its container shares the host's
// network stack, and cloud-init moved the host's sshd aside so this could be true.
const INSTANCE_SSH_PORT = 22;
import {
	boxRuntimeStanding,
	latestFailure,
	latestRepair,
	latestUpdate,
	safeBox
} from "../boxes/views";
import { ownerCanReadBox } from "../boxes/queries";
import {
	assertSnapshotDeletable,
	markSnapshotDeleting,
	snapshotView,
	startManualSnapshot
} from "../boxes/snapshots";
import { websiteOrigin } from "../env";
import { polarServer } from "../billing/polar";
import { boxPath } from "../model/box/path";
import {
	BOX_PLANS,
	isValidManualSnapshotCap,
	planAllowsManualSnapshots
} from "../model/box/plan";
import { isValidSlug, sanitizeSlug } from "../model/box/slug";
import { readCapacityUsage } from "../boxes/capacity";
import { readGlobalSettings } from "../settings";
import { DAY_MS } from "../time";

const CUSTOMER_PORTAL_BLOCKED_STATUSES = ["deleting", "deleted"] as const;
const BOX_LIST_MAXIMUM_ROWS_READ = 200;

// Two different Let's Encrypt limits bind a Composery deployment, and this
// enforces one of them. `model/box/certificate.ts` states the pair and why they
// must never be merged into one counter; the short version:
//
//   - THIS ONE is the **duplicate-certificate** limit: roughly five a week for
//     one identical set of names. It is a fact about a single box, so it is
//     counted per box, here, at the operations that reissue one.
//   - The **certificates-per-registered-domain** limit - roughly fifty a week
//     for the whole apex - is a fleet fact and is enforced by capacity
//     admission (`boxes/capacity.ts`), beside the other fleet-wide allowances.
//
// A box that has reset five times this week has exhausted this cap while the
// apex may be almost untouched; an apex that has issued fifty has exhausted that
// one while every individual box is well inside this cap. Merging them would
// quietly enforce the smaller number everywhere and stop enforcing the other.
// The staff console bypasses this on purpose.
//
// Restore is in the list because a restored disk carries the certificate that
// was on it when the snapshot was taken: restore one older than the renewal
// window and the box asks for a new certificate the moment it boots. That was
// always true and nothing ever counted it, and removing the expiry on manual
// snapshots makes restoring an old one an ordinary thing to do rather than a
// rare one.
const REPEATED_CERTIFICATE_OPERATION_TYPES = [
	"reset",
	"change_slug",
	"restore"
] as const;
const REPEATED_CERTIFICATE_WEEK_MS = 7 * DAY_MS;
const REPEATED_CERTIFICATE_CAP_PER_WEEK = 5;

// The per-box duplicate-certificate cap, and the fleet's apex allowance, in that
// order.
//
// Both are asked, because either can be the binding one and they fail for
// different reasons the owner needs told apart: "you have reset this box too
// often" is something they can wait out on their own box, while "the deployment
// has no certificate budget left this week" is not about their box at all.
//
// The fleet side reads `forRecovery`, never `forCreation` - these are the
// operations the reserve exists to protect, so a week whose creation budget is
// gone must still let an owner recover a box they already own.
async function assertCertificateBudget(ctx: QueryCtx, boxId: Id<"boxes">) {
	const since = Date.now() - REPEATED_CERTIFICATE_WEEK_MS;
	let count = 0;
	for (const type of REPEATED_CERTIFICATE_OPERATION_TYPES) {
		const rows = await ctx.db
			.query("box_operations")
			.withIndex("box_id_type_created_at", (builder) =>
				builder.eq("box_id", boxId).eq("type", type).gte("created_at", since)
			)
			.take(REPEATED_CERTIFICATE_CAP_PER_WEEK);
		count += rows.length;
	}

	if (count >= REPEATED_CERTIFICATE_CAP_PER_WEEK) {
		throw new ConvexError(
			"This box has changed its address or been reset too often this week. Try again later or contact support."
		);
	}

	// The fleet's apex allowance, and the one place this deliberately does NOT
	// fail closed.
	//
	// An unconfigured allowance closes *checkout*, because selling a box this
	// deployment may not be able to certify is a promise it cannot keep. It must
	// not close *recovery*. Refusing a reset or a restore because an operator has
	// not filled in a number protects nobody - the Let's Encrypt ceiling is
	// external and unaffected by whether we let this owner fix their box - while
	// creating exactly the outage the owner is trying to escape. Recovery stays
	// bounded by the per-box cap above, which needs no setting to work.
	//
	// So: block recovery only when the allowance is known *and* spent.
	const settings = await readGlobalSettings(ctx);
	if (settings.certificateWeeklyLimit === null) return;

	const capacity = await readCapacityUsage(ctx, settings);
	if (capacity.certificatesForRecovery < 1) {
		throw new ConvexError(
			"Composery has used this week's certificate allowance. This box is unchanged - try again in a few days or contact support."
		);
	}
}

// Resolve a slug to the caller's box or fail without revealing whether the slug
// exists.
async function requireOwnedBox(ctx: QueryCtx, userId: string, slug: string) {
	const box = await findOwnedBoxBySlug(ctx, userId, slug);
	if (!box) throw new ConvexError("Box not found.");
	return box;
}

function assertPortalAllowed(box: Doc<"boxes">) {
	if (
		CUSTOMER_PORTAL_BLOCKED_STATUSES.includes(
			box.status as (typeof CUSTOMER_PORTAL_BLOCKED_STATUSES)[number]
		)
	) {
		throw new ConvexError(
			"Subscription management is unavailable for this box."
		);
	}
}

export const list = query({
	args: {
		paginationOpts: paginationOptsValidator
	},
	handler: async (ctx, args) => {
		const { identity, user } = await currentUserForRead(ctx);
		if (!user) {
			return {
				continueCursor: "",
				isDone: true,
				page: []
			};
		}

		const page = await ctx.db
			.query("boxes")
			.withIndex("user_id_created_at", (builder) =>
				builder.eq("user_id", identity.subject)
			)
			.order("desc")
			.filter((builder) => builder.neq(builder.field("status"), "deleted"))
			.paginate({
				...args.paginationOpts,
				maximumRowsRead: BOX_LIST_MAXIMUM_ROWS_READ
			});

		return { ...page, page: page.page.map(safeBox) };
	}
});

export const getById = query({
	args: {
		boxId: v.string()
	},
	handler: async (ctx, args) => {
		const { identity } = await currentUserForRead(ctx);
		const boxId = ctx.db.normalizeId("boxes", args.boxId);
		const box = boxId ? await ctx.db.get(boxId) : null;

		if (!ownerCanReadBox(box, identity.subject)) {
			return null;
		}

		const subscription = box.polar_subscription_id
			? await ctx.runQuery(components.polar.lib.getSubscription, {
					id: box.polar_subscription_id
				})
			: null;

		const suspendedReason = await currentSuspensionReason(ctx, box);

		return {
			box: safeBox(box),
			subscription,
			suspendedReason,
			failure: await latestFailure(ctx.db, box._id),
			repair: await latestRepair(ctx.db, box._id),
			update: await latestUpdate(ctx.db, box._id),
			runtime: await boxRuntimeStanding(ctx.db, box),
			usage: await boxUsage(ctx.db, box._id)
		};
	}
});

// The owner's view of the same Hetzner-side samples staff see.
export const metricsSeries = query({
	args: {
		slug: v.string(),
		range: v.optional(vMetricsRange)
	},
	handler: async (ctx, args) => {
		const { identity } = await currentUserForRead(ctx);
		const box = await findOwnedBoxBySlug(ctx, identity.subject, args.slug);
		if (!box) return [];

		return [
			{
				slug: box.slug,
				samples: await boxMetricsSamples(ctx, box._id, args.range ?? "24h")
			}
		];
	}
});

export const customerPortalUrl = action({
	args: {
		slug: v.string()
	},
	returns: v.object({
		url: v.string()
	}),
	handler: async (ctx, args): Promise<{ url: string }> => {
		const user = await requireActiveUserInAction(ctx);

		const box: Doc<"boxes"> | null = await ctx.runQuery(
			internal.boxes.queries.boxByOwnerSlug,
			{
				userId: user.clerk_user_id,
				slug: sanitizeSlug(args.slug)
			}
		);
		if (!box) throw new ConvexError("Box not found.");
		assertPortalAllowed(box);

		const origin = websiteOrigin();

		const polar = polarServer();
		const polarCtx = ctx as unknown as Parameters<
			typeof polar.createCustomerPortalSession
		>[0];

		return await polar.createCustomerPortalSession(polarCtx, {
			userId: user.clerk_user_id,
			returnUrl: `${origin}${boxPath(box._id)}`
		});
	}
});

export const runtimeLogs = action({
	args: {
		slug: v.string()
	},
	returns: v.object({
		logs: v.union(v.string(), v.null())
	}),
	handler: async (ctx, args): Promise<{ logs: string | null }> => {
		const box = await requireOwnerBoxInAction(ctx, args.slug);
		if (box.status !== "running") return { logs: null };

		return await fetchRuntimeLogsSafely(ctx, box._id);
	}
});

// The setup prompt an owner copies to connect a device or an AI agent.
//
// The website originates the token by asking the box for one, and renders the
// prompt from `shared` - the same module the editor's own command uses, so the
// two surfaces cannot drift into producing different instructions.
//
// What it deliberately does not do is list or revoke certificates. Those live on
// the instance; a copy here would be a second list nobody could keep true. See
// `docs/ssh.md`.
export const sshSetup = action({
	args: { slug: v.string(), name: v.string() },
	returns: v.object({
		expiresAt: v.number(),
		host: v.string(),
		prompt: v.string()
	}),
	handler: async (
		ctx,
		args
	): Promise<{ expiresAt: number; host: string; prompt: string }> => {
		const box = await requireOwnerBoxInAction(ctx, args.slug);
		if (box.status !== "running") {
			throw new ConvexError("This box must be running to connect over SSH.");
		}
		const name = args.name.trim();
		if (!name || name.length > 64) {
			throw new ConvexError(
				"Give this connection a name of 1 to 64 characters."
			);
		}

		const { token, expiresAt } = await ctx.runAction(
			internal.boxes.infra.host.mintSshEnrollment,
			{ boxId: box._id, name }
		);
		const host = runtimeDomain(box.slug);
		return {
			expiresAt,
			host,
			prompt: sshSetupPrompt({
				alias: `composery-${box.slug}`,
				enrollUrl: `https://${host}/_composery/ssh/enroll`,
				host,
				port: INSTANCE_SSH_PORT,
				token,
				user: "user"
			})
		};
	}
});

// What can currently reach this box, read live from the box rather than stored
// here. Reading through is not the same as mirroring: nothing on this side is
// kept, so there is no second answer to go stale.
export const sshDevices = action({
	args: { slug: v.string() },
	returns: v.array(vSshCertificate),
	handler: async (ctx, args): Promise<SshCertificate[]> => {
		const box = await requireOwnerBoxInAction(ctx, args.slug);
		if (box.status !== "running") return [];

		return await ctx.runAction(internal.boxes.infra.host.listSshCertificates, {
			boxId: box._id
		});
	}
});

export const revokeSshDevice = action({
	args: { slug: v.string(), serial: v.number() },
	returns: v.null(),
	handler: async (ctx, args): Promise<null> => {
		const box = await requireOwnerBoxInAction(ctx, args.slug);
		if (box.status !== "running") {
			throw new ConvexError("This box must be running to revoke SSH access.");
		}
		const revoked: boolean = await ctx.runAction(
			internal.boxes.infra.host.revokeSshCertificate,
			{ boxId: box._id, serial: args.serial }
		);
		if (!revoked) {
			throw new ConvexError("That access was already revoked, or is unknown.");
		}
		return null;
	}
});

// Point your own domain at this box, or take it off again.
//
// The name is only stored once it is observed to resolve to this box. Caddy asks
// a certificate authority for a certificate the moment a name enters its config,
// and a name that points elsewhere fails that challenge on a schedule until the
// authority rate-limits the box - which costs the managed name its certificate
// too. Refusing here turns a fleet-visible outage into a sentence.
export const setCustomDomain = action({
	args: { slug: v.string(), domain: v.union(v.string(), v.null()) },
	returns: v.null(),
	handler: async (ctx, args): Promise<null> => {
		const box = await requireOwnerBoxInAction(ctx, args.slug);
		if (box.status !== "running") {
			throw new ConvexError("This box must be running to change its domain.");
		}

		if (args.domain === null) {
			await ctx.runMutation(internal.boxes.operation.record.setCustomDomain, {
				boxId: box._id,
				domain: null
			});
			await ctx.runAction(internal.boxes.infra.host.reloadCustomDomain, {
				boxId: box._id
			});
			return null;
		}

		const domain = normalizeCustomDomain(args.domain);
		if (!isValidCustomDomain(domain)) {
			throw new ConvexError("That is not a domain name.");
		}
		if (domain.endsWith(`.${normalizeDomain(requiredEnv("CLOUD_DOMAIN"))}`)) {
			throw new ConvexError(
				"That domain is managed by Composery and is already pointing here."
			);
		}

		const resolves: boolean = await ctx.runAction(
			internal.boxes.infra.host.checkCustomDomain,
			{ boxId: box._id, domain }
		);
		if (!resolves) {
			throw new ConvexError(
				`${domain} does not point at this box yet. Add an A record for ${box.hetzner_ipv4 ?? "this box's address"} and try again once it has propagated.`
			);
		}

		await ctx.runMutation(internal.boxes.operation.record.setCustomDomain, {
			boxId: box._id,
			domain
		});
		await ctx.runAction(internal.boxes.infra.host.reloadCustomDomain, {
			boxId: box._id
		});
		return null;
	}
});

export const recoveryStatus = action({
	args: { slug: v.string() },
	returns: vRecoveryStatus,
	handler: async (ctx, args): Promise<RecoveryStatus> => {
		const box = await requireOwnerBoxInAction(ctx, args.slug);
		return await ctx.runAction(internal.boxes.health.recoveryStatus, {
			boxId: box._id
		});
	}
});

export const repair = action({
	args: { slug: v.string() },
	handler: async (ctx, args): Promise<void> => {
		const box = await requireOwnerBoxInAction(ctx, args.slug);
		await startForOrFail(ctx, "owner", box, "repair");
	}
});

export const update = action({
	args: { slug: v.string() },
	handler: async (ctx, args): Promise<void> => {
		const box = await requireOwnerBoxInAction(ctx, args.slug);
		await startForOrFail(ctx, "owner", box, "update");
	}
});

export const retryCreate = mutation({
	args: {
		slug: v.string()
	},
	handler: async (ctx, args) => {
		await startFor(
			ctx,
			"owner",
			await requireOwnerBox(ctx, args.slug),
			"create"
		);
	}
});

export const stop = mutation({
	args: {
		slug: v.string()
	},
	handler: async (ctx, args) => {
		await startFor(ctx, "owner", await requireOwnerBox(ctx, args.slug), "stop");
	}
});

export const start = mutation({
	args: {
		slug: v.string()
	},
	handler: async (ctx, args) => {
		await startFor(
			ctx,
			"owner",
			await requireOwnerBox(ctx, args.slug),
			"start"
		);
	}
});

export const reset = mutation({
	args: {
		confirmation: v.string(),
		slug: v.string()
	},
	handler: async (ctx, args) => {
		const box = await requireOwnerBox(ctx, args.slug);
		if (args.confirmation !== box.slug) {
			throw new ConvexError("Type the box slug to reset.");
		}
		await assertCertificateBudget(ctx, box._id);

		await startFor(ctx, "owner", box, "reset");
	}
});

export const changeSlug = mutation({
	args: {
		newSlug: v.string(),
		slug: v.string()
	},
	handler: async (ctx, args) => {
		const newSlug = sanitizeSlug(args.newSlug);
		if (!isValidSlug(newSlug)) throw new ConvexError("Slug is unavailable.");

		const box = await requireOwnerBox(ctx, args.slug);
		await assertCertificateBudget(ctx, box._id);

		// Keyed on the new name as well as the box, so asking for a second name is
		// a new request rather than one absorbed by the first.
		await startFor(ctx, "owner", box, "change_slug", {
			key: newSlug,
			metadata: { oldSlug: box.slug, newSlug },
			reservedSlug: newSlug,
			workflowArgs: { newSlug }
		});

		return { slug: newSlug };
	}
});

// How the box's snapshot allowance is divided between the daily automatic ones
// and the ones its owner takes themselves.
//
// It moves slots between two columns and never changes how many there are, so it
// costs the fleet nothing, touches no infrastructure, and is not a box operation
// - a box mid-repair can still be re-split. Nothing is deleted either: lowering a
// side below what is already held simply stops new ones being taken on that side
// until the existing ones expire or the owner removes them, which is the same
// rule a full manual allowance has always followed.
export const setSnapshotSplit = mutation({
	args: {
		manualCap: v.number(),
		slug: v.string()
	},
	handler: async (ctx, args) => {
		const user = await requireActiveUser(ctx);
		const box = await requireOwnedBox(ctx, user.clerk_user_id, args.slug);

		if (!isValidManualSnapshotCap(box.plan, args.manualCap)) {
			throw new ConvexError(
				planAllowsManualSnapshots(box.plan)
					? `${BOX_PLANS[box.plan].label} includes ${BOX_PLANS[box.plan].snapshotCap} snapshots, so between 0 and ${BOX_PLANS[box.plan].snapshotCap} of them can be yours to take.`
					: `${BOX_PLANS[box.plan].label} takes its snapshots automatically, so there is no split to set.`
			);
		}

		await ctx.db.patch(box._id, {
			manual_snapshot_cap: args.manualCap,
			updated_at: Date.now()
		});
	}
});

export const snapshots = query({
	args: {
		slug: v.string()
	},
	handler: async (ctx, args) => {
		const { identity } = await currentUserForRead(ctx);
		const box = await findOwnedBoxBySlug(ctx, identity.subject, args.slug);
		if (!box) return [];

		const rows = await ctx.db
			.query("box_snapshots")
			.withIndex("box_id_created_at", (builder) =>
				builder.eq("box_id", box._id)
			)
			.order("desc")
			.take(100);

		return rows.map(snapshotView);
	}
});

export const createSnapshot = mutation({
	args: {
		slug: v.string()
	},
	handler: async (ctx, args) => {
		const box = await requireOwnerBox(ctx, args.slug);
		await startManualSnapshot(ctx, box, "snapshot", "owner");
	}
});

export const restoreSnapshot = mutation({
	args: {
		snapshotId: v.id("box_snapshots")
	},
	handler: async (ctx, args) => {
		const user = await requireActiveUser(ctx);
		const { box, snapshot } = await requireOwnedSnapshot(
			ctx,
			user.clerk_user_id,
			args.snapshotId
		);
		if (snapshot.status !== "complete") {
			throw new ConvexError("Only a finished snapshot can be restored.");
		}
		await assertCertificateBudget(ctx, box._id);
		// Keyed on the snapshot too: restoring a different one is a different
		// request, not a repeat of this one.
		await startForOrFail(ctx, "owner", box, "restore", {
			key: args.snapshotId,
			workflowArgs: { snapshotRowId: args.snapshotId }
		});
	}
});

export const deleteSnapshot = mutation({
	args: {
		snapshotId: v.id("box_snapshots")
	},
	handler: async (ctx, args) => {
		const user = await requireActiveUser(ctx);
		const { snapshot } = await requireOwnedSnapshot(
			ctx,
			user.clerk_user_id,
			args.snapshotId
		);
		assertSnapshotDeletable(snapshot);
		await markSnapshotDeleting(ctx, args.snapshotId);
		await ctx.scheduler.runAfter(0, internal.boxes.snapshots.runDelete, {
			snapshotRowId: args.snapshotId
		});
	}
});
