// How an audience reaches a box, and what starting an operation on it records.
//
// The owner surface and the console surface used to be two files of hand-written
// endpoints, one copied from the other. Each endpoint repeated four things - how
// the box is addressed, which authorization to ask for, what idempotency key to
// build, and which trigger to record - and got them right by being copied
// carefully. Two invariant tests existed only to notice when a new endpoint was
// copied wrongly, and their own headers said so: "an endpoint is written by
// copying the one above it", and "the name is exactly what a copied endpoint
// gets wrong".
//
// Here those four things follow from one argument. An endpoint names its
// audience and its operation; it cannot name a trigger, because nothing takes
// one. That is the difference between a rule a test watches for and a rule the
// code cannot break.
//
// The trigger matters more than it looks: automatic repair decides whether a
// person is already working on a box from that field alone. A console action
// recorded as the owner's tells the sweep to keep away from a box nobody is
// holding; an owner action recorded as staff's tells it the opposite.
import { ConvexError } from "convex/values";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../../_generated/server";
import {
	operationAllowsAudience,
	operationLabel,
	type BoxOperationType
} from "../../model/box/operation";
import { sanitizeSlug } from "../../model/box/slug";
import { findOwnedBoxBySlug } from "../queries";
import { startBoxOperation } from "./start";
import {
	requireActiveUser,
	requireActiveUserInAction,
	requireCapability,
	requireCapabilityInAction
} from "../../users";

// The two ways a box is addressed, and the only axis these endpoints vary on.
//
// `box` is deliberately absent from this type even though the operation
// catalogue knows about it: the running instance authenticates with a grant
// rather than a session, so its one operation (`change_password`) comes through
// `convex/instance/auth.ts` and never through here.
export type EndpointAudience = "owner" | "staff";

// The capability the console asks for before touching somebody else's box.
const STAFF_BOX_CAPABILITY = "box_operations";

// Resolve a slug to the caller's own box, or fail without revealing whether the
// slug exists at all.
export async function requireOwnerBox(ctx: MutationCtx, slug: string) {
	const user = await requireActiveUser(ctx);
	const box = await findOwnedBoxBySlug(ctx, user.clerk_user_id, slug);
	if (!box) throw new ConvexError("Box not found.");
	return box;
}

// The same, from an action. Actions have no database handle, so the lookup goes
// through the internal query rather than the helper above - and deliberately
// through the same one, so an owner is told the same story either way.
export async function requireOwnerBoxInAction(
	ctx: ActionCtx,
	slug: string
): Promise<Doc<"boxes">> {
	const user = await requireActiveUserInAction(ctx);
	const box = await ctx.runQuery(internal.boxes.queries.boxByOwnerSlug, {
		slug: sanitizeSlug(slug),
		userId: user.clerk_user_id
	});
	if (!box) throw new ConvexError("Box not found.");
	return box;
}

export async function requireStaffBox(ctx: QueryCtx, boxId: Id<"boxes">) {
	await requireCapability(ctx, STAFF_BOX_CAPABILITY);
	const box = await ctx.db.get(boxId);
	if (!box) throw new ConvexError("Box not found.");
	return box;
}

export async function requireStaffBoxInAction(
	ctx: ActionCtx,
	boxId: Id<"boxes">
): Promise<Doc<"boxes">> {
	await requireCapabilityInAction(ctx, STAFF_BOX_CAPABILITY);
	return await ctx.runQuery(internal.boxes.queries.getBoxLifecycleSnapshot, {
		boxId
	});
}

// What an operation started by this audience is keyed and attributed as.
//
// The two audiences key separately on purpose: a staff update must not be
// deduplicated against an owner's in-flight one and silently reported as
// started. `startOperation` still refuses a second concurrent operation on the
// same box, so the two can never overlap - one of them is told the box is busy.
//
// `extra` is the material that makes two requests genuinely different. A slug
// change keys on the new name so a second name is a new request; a restore keys
// on the snapshot for the same reason. Everything else keys on the box alone, so
// two presses of Repair are one request rather than two.
function idempotencyKey(
	audience: EndpointAudience,
	type: BoxOperationType,
	boxId: Id<"boxes">,
	extra?: string
) {
	const prefix = audience === "staff" ? `staff-${type}` : type;
	return extra ? `${prefix}:${boxId}:${extra}` : `${prefix}:${boxId}`;
}

type StartOptions = {
	// Extra key material - see `idempotencyKey`.
	key?: string;
	metadata?: Record<string, unknown>;
	reservedSlug?: string;
	workflowArgs?: Record<string, unknown>;
};

// Start an operation on a box the caller has already been authorized for.
//
// Returns `null` when an identical request is already in flight. Most callers
// treat that as success - the caller's intent is already being served, and a
// second press of Stop is the same request, not a new one. The two surfaces that
// open a progress dialog use `startForOrFail` instead, because there the caller
// is about to watch for an outcome and needs to know whose operation it is.
export async function startFor(
	ctx: { runMutation: ActionCtx["runMutation"] },
	audience: EndpointAudience,
	box: Pick<Doc<"boxes">, "_id">,
	type: BoxOperationType,
	options: StartOptions = {}
): Promise<Id<"box_operations"> | null> {
	// Not reachable from a correctly written endpoint - the catalogue says which
	// audiences an operation has, and these two surfaces are generated from it.
	// Kept because the alternative, once something moves, is a console quietly
	// starting an operation nobody meant it to have.
	if (!operationAllowsAudience(type, audience)) {
		throw new ConvexError(
			`${operationLabel(type)} is not available to this caller.`
		);
	}

	return await startBoxOperation(ctx, box._id, type, {
		idempotencyKey: idempotencyKey(audience, type, box._id, options.key),
		metadata: options.metadata,
		reservedSlug: options.reservedSlug,
		trigger: audience,
		workflowArgs: options.workflowArgs
	});
}

// The same, for a caller that is about to watch for an outcome.
//
// Reporting "Repair started" over a request that started nothing is the same lie
// as an operation that never reports one: the dialog would wait on an operation
// this call did not open. A retry after a failure reuses the same key once the
// failed operation has settled, so it starts a fresh attempt rather than being
// absorbed by the old one.
//
// The sentence is built from the operation's label, not from its identifier.
// Adding a suffix to the identifier reads as economy and breaks on half the
// operations; identifiers and prose are separate vocabularies, and this is the
// boundary between them.
export async function startForOrFail(
	ctx: { runMutation: ActionCtx["runMutation"] },
	audience: EndpointAudience,
	box: Pick<Doc<"boxes">, "_id">,
	type: BoxOperationType,
	options: StartOptions = {}
): Promise<Id<"box_operations">> {
	const operationId = await startFor(ctx, audience, box, type, options);
	if (!operationId) {
		throw new ConvexError(
			`Another ${operationLabel(type, true)} is already in flight for this box.`
		);
	}
	return operationId;
}
