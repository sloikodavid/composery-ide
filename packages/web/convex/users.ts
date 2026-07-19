import { ConvexError, v } from "convex/values";
import type { UserIdentity } from "convex/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
	internalMutation,
	internalQuery,
	type ActionCtx,
	type MutationCtx,
	type QueryCtx
} from "./_generated/server";
import type { UserRole } from "./schema";

// The whole vocabulary of the `users` table: how a Clerk identity becomes a row,
// what that row may do, and the one answer to "may this account act at all".
//
// One file rather than three, because the split between them was arbitrary and
// circular - the capability table could not be read without the row, the row
// helpers reached back into this module's own internal query, and every caller
// had to know which of the three held the piece it wanted.

type ReaderCtx = Pick<QueryCtx, "auth" | "db">;
type WriterCtx = Pick<MutationCtx, "auth" | "db">;
type ActionAuthCtx = Pick<ActionCtx, "auth" | "runQuery">;

const USER_CAPABILITIES = [
	"staff_console",
	"box_operations",
	"user_moderation",
	"settings_management",
	"checkout_management",
	// Minting a free box creates real infrastructure that costs money, so it
	// gates separately from ordinary checkout/box powers - a role can hold those
	// without being able to hand out comps.
	"box_comp",
	"staff_alerts"
] as const;

export type UserCapability = (typeof USER_CAPABILITIES)[number];

// Adding a database role makes this Record fail typechecking until its powers
// are chosen explicitly. A future role can never inherit admin access merely by
// being something other than `user`.
export const ROLE_CAPABILITIES = {
	user: [],
	admin: USER_CAPABILITIES
} as const satisfies Record<UserRole, readonly UserCapability[]>;

export function roleHasCapability(role: UserRole, capability: UserCapability) {
	return (ROLE_CAPABILITIES[role] as readonly UserCapability[]).includes(
		capability
	);
}

export function isInternalRole(role: UserRole) {
	return role !== "user";
}

export function rolesWithCapability(capability: UserCapability): UserRole[] {
	return (Object.keys(ROLE_CAPABILITIES) as UserRole[]).filter((role) =>
		roleHasCapability(role, capability)
	);
}

// Why this account cannot act, in the owner's terms, or null when it can.
//
// One answer for every caller, because the alternative was what this replaced:
// four hand-written spellings of the same two conditions, no two of them
// checking the same pair or saying the same thing. `deletion_pending` was
// checked by exactly one of them, so an account whose deletion was in flight
// could still start, stop, reset and rename the boxes that deletion was trying
// to tear down.
type AccountBlock = {
	kind: "account_unavailable";
	// A heading and a sentence: the boxes page draws them as a card, a toast
	// joins them. Both come from here so neither can invent its own wording.
	title: string;
	detail: string;
};

export function accountBlock(
	user: Pick<
		Doc<"users">,
		| "deletion_finished_at"
		| "deletion_pending"
		| "suspended"
		| "suspended_reason"
	>
): AccountBlock | null {
	if (user.deletion_pending || user.deletion_finished_at) {
		return {
			kind: "account_unavailable",
			title: "This account is being deleted",
			detail:
				"Deleting a Composery account removes every box on it, so nothing on the account can be changed while that finishes."
		};
	}
	if (user.suspended) {
		return {
			kind: "account_unavailable",
			title: "Your account is suspended",
			detail:
				user.suspended_reason?.trim() ||
				"Contact support if you think this is a mistake."
		};
	}
	return null;
}

function assertAccountUsable(user: Doc<"users">) {
	const block = accountBlock(user);
	if (block) throw new ConvexError(block);
}

export function userHasCapability(
	user: Doc<"users"> | null | undefined,
	capability: UserCapability
): user is Doc<"users"> {
	return (
		!!user && !accountBlock(user) && roleHasCapability(user.role, capability)
	);
}

export async function requireIdentity(ctx: Pick<QueryCtx, "auth">) {
	const identity = await ctx.auth.getUserIdentity();

	if (!identity) {
		throw new ConvexError("Authentication required.");
	}

	return identity;
}

export function emailFromIdentity(identity: UserIdentity) {
	if (!identity.email) {
		throw new ConvexError(
			"No email on the authenticated identity. Add an `email` claim to Clerk's session token (Configure -> Sessions -> Customize session token); see docs/developing/web/services/clerk.md."
		);
	}
	return identity.email;
}

export async function findUserByClerkId(ctx: ReaderCtx, clerkUserId: string) {
	return await ctx.db
		.query("users")
		.withIndex("clerk_user_id", (query) =>
			query.eq("clerk_user_id", clerkUserId)
		)
		.first();
}

// Staff look a customer up by the address they were given, which arrives typed
// or pasted. Normalizing here rather than at each call site is what stops one
// lookup finding an account another cannot.
export async function findUserByEmail(ctx: ReaderCtx, email: string) {
	return await ctx.db
		.query("users")
		.withIndex("email", (query) =>
			query.eq("email", email.trim().toLowerCase())
		)
		.first();
}

// Create the user row, or patch its email if Clerk's changed.
async function upsertUser(ctx: WriterCtx, clerkUserId: string, email: string) {
	const now = Date.now();
	const existing = await findUserByClerkId(ctx, clerkUserId);

	if (existing) {
		if (existing.email !== email) {
			await ctx.db.patch(existing._id, { email, updated_at: now });
			return { ...existing, email, updated_at: now };
		}

		return existing;
	}

	const id = await ctx.db.insert("users", {
		clerk_user_id: clerkUserId,
		email,
		role: "user",
		suspended: false,
		created_at: now,
		updated_at: now
	});

	const user = await ctx.db.get(id);
	if (!user) {
		throw new ConvexError("Failed to create user.");
	}

	return user;
}

export async function ensureUserRecord(ctx: WriterCtx) {
	const identity = await requireIdentity(ctx);
	return await upsertUser(ctx, identity.subject, emailFromIdentity(identity));
}

export async function requireActiveUser(ctx: WriterCtx) {
	const user = await ensureUserRecord(ctx);
	assertAccountUsable(user);
	return user;
}

// The read side. A query cannot create the row, so a caller who has never
// written anything gets `null` and is shown an empty account rather than an
// error about a row they were never told existed.
export async function currentUserForRead(ctx: ReaderCtx) {
	const identity = await requireIdentity(ctx);
	const user = await findUserByClerkId(ctx, identity.subject);
	if (user) assertAccountUsable(user);
	return { identity, user };
}

export async function requireCapability(
	ctx: ReaderCtx,
	capability: UserCapability
) {
	const identity = await requireIdentity(ctx);
	const user = await findUserByClerkId(ctx, identity.subject);

	if (!userHasCapability(user, capability)) {
		throw new ConvexError("Staff access required.");
	}

	return user;
}

// Actions have no `db`, so they re-check auth through an internal query. The
// answers are the mutation-side ones above, verbatim - a caller must not be told
// a different story about its own account depending on which kind of function it
// reached.
export async function requireActiveUserInAction(ctx: ActionAuthCtx) {
	const identity = await requireIdentity(ctx);
	const user = await ctx.runQuery(internal.users.userByClerkId, {
		clerkUserId: identity.subject
	});
	if (!user) throw new ConvexError("Account is not initialized.");
	assertAccountUsable(user);
	return user;
}

export async function requireCapabilityInAction(
	ctx: ActionAuthCtx,
	capability: UserCapability
) {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) throw new ConvexError("Staff access required.");

	const user = await ctx.runQuery(internal.users.userByClerkId, {
		clerkUserId: identity.subject
	});
	if (!userHasCapability(user, capability)) {
		throw new ConvexError("Staff access required.");
	}

	return user;
}

export const ensureUserForIdentity = internalMutation({
	args: {
		clerkUserId: v.string(),
		email: v.string()
	},
	handler: async (ctx, args) => {
		return await upsertUser(ctx, args.clerkUserId, args.email);
	}
});

export const userByClerkId = internalQuery({
	args: {
		clerkUserId: v.string()
	},
	handler: async (ctx, args) => await findUserByClerkId(ctx, args.clerkUserId)
});
