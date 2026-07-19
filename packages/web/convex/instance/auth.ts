import { ConvexError, v } from "convex/values";
import { IDE_PATH } from "shared";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
	action,
	internalAction,
	internalMutation,
	internalQuery
} from "../_generated/server";
import { requireActiveUserInAction } from "../users";
import { cloudUrl } from "../env";
import { vBoxAuthorizationType } from "../schema";
import { isFlowSecret, isPasswordHash, isRedirectUri } from "../model/box/auth";
import { startBoxOperation } from "../boxes/operation/start";
import { MINUTE_MS } from "../time";

const AUTHORIZATION_CODE_TTL_MS = 2 * MINUTE_MS;
const SETUP_GRANT_TTL_MS = 10 * MINUTE_MS;
const PASSWORD_RECONCILE_DELAY_MS = 5_000;
const PASSWORD_RECONCILE_RETRY_MS = MINUTE_MS;
const PASSWORD_RECONCILE_MAX_ATTEMPTS = 20;

function bytes(length: number) {
	const value = new Uint8Array(length);
	crypto.getRandomValues(value);
	return value;
}

function base64url(value: Uint8Array) {
	let binary = "";
	for (const byte of value) binary += String.fromCharCode(byte);
	const padded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_");
	// Every value rendered here is exactly 32 bytes - 32 random bytes, or a
	// SHA-256 digest - so base64 pads it with exactly one trailing "=". The
	// pattern is written for any length anyway, which is why it strips a run.
	// Stryker disable next-line Regex: with a single "=" to remove, stripping one and stripping a run are the same edit.
	return padded.replace(/=+$/g, "");
}

async function sha256(value: string) {
	return base64url(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
		)
	);
}

export function isBoxIdeRedirect(
	box: Pick<Doc<"boxes">, "slug">,
	value: string
) {
	try {
		const redirect = new URL(value);
		return (
			redirect.origin === new URL(cloudUrl(box.slug)).origin &&
			redirect.pathname.startsWith(IDE_PATH) &&
			!redirect.username &&
			!redirect.password &&
			!redirect.search &&
			!redirect.hash
		);
	} catch {
		return false;
	}
}

export const createAuthorizationCode = action({
	args: {
		boxId: v.id("boxes"),
		codeChallenge: v.string(),
		redirectUri: v.string(),
		type: vBoxAuthorizationType
	},
	returns: v.object({ code: v.string(), redirectUri: v.string() }),
	handler: async (ctx, args) => {
		const user = await requireActiveUserInAction(ctx);
		if (!isFlowSecret(args.codeChallenge)) {
			throw new ConvexError("Invalid authorization request.");
		}

		const box = await ctx.runQuery(internal.instance.auth.boxForAuthorization, {
			boxId: args.boxId
		});
		if (!box || box.user_id !== user.clerk_user_id || box.deleted_at) {
			throw new ConvexError("Box not found.");
		}
		if (!isBoxIdeRedirect(box, args.redirectUri)) {
			throw new ConvexError("Invalid authorization request.");
		}

		// A configured password does not block authorization: the owner proved
		// ownership right here, so re-running the flow is how password recovery
		// and changes work on cloud boxes.
		const code = base64url(bytes(32));
		await ctx.runMutation(internal.instance.auth.storeAuthorizationCode, {
			boxId: box._id,
			codeHash: await sha256(code),
			codeChallenge: args.codeChallenge,
			redirectUri: args.redirectUri,
			type: args.type
		});
		return { code, redirectUri: args.redirectUri };
	}
});

export const exchangeAuthorizationCode = action({
	args: {
		boxId: v.id("boxes"),
		code: v.string(),
		codeVerifier: v.string(),
		redirectUri: v.string(),
		type: vBoxAuthorizationType
	},
	returns: v.union(
		v.object({ type: v.literal("password"), grant: v.string() }),
		v.object({ type: v.literal("session") })
	),
	handler: async (ctx, args) => {
		if (
			!isFlowSecret(args.code) ||
			!isFlowSecret(args.codeVerifier) ||
			!isRedirectUri(args.redirectUri)
		) {
			throw new ConvexError("Invalid authorization code.");
		}
		const grant = args.type === "password" ? base64url(bytes(32)) : undefined;
		await ctx.runMutation(internal.instance.auth.exchangeCode, {
			boxId: args.boxId,
			codeHash: await sha256(args.code),
			codeChallenge: await sha256(args.codeVerifier),
			redirectUri: args.redirectUri,
			type: args.type,
			grantHash: grant ? await sha256(grant) : undefined
		});
		return grant
			? ({ type: "password", grant } as const)
			: ({ type: "session" } as const);
	}
});

export const installPassword = action({
	args: {
		boxId: v.id("boxes"),
		grant: v.string(),
		runtimeAuthHash: v.string()
	},
	returns: v.object({ accepted: v.boolean() }),
	handler: async (ctx, args) => {
		if (!isFlowSecret(args.grant) || !isPasswordHash(args.runtimeAuthHash)) {
			throw new ConvexError("Invalid password hash.");
		}
		await ctx.runMutation(internal.instance.auth.claimGrantForPassword, {
			boxId: args.boxId,
			grantHash: await sha256(args.grant),
			runtimeAuthHash: args.runtimeAuthHash
		});
		return { accepted: true };
	}
});

// The grant flow proves ownership through the website and is the only way to
// set a password you cannot already produce. This is the other half: a box
// whose holder proved the current password changed it locally, and Convex has
// to record that or the next bootstrap would restore the old one.
export const changePassword = action({
	args: {
		boxId: v.id("boxes"),
		currentRuntimeAuthHash: v.string(),
		runtimeAuthHash: v.string()
	},
	returns: v.object({ accepted: v.boolean() }),
	handler: async (ctx, args) => {
		if (
			!isPasswordHash(args.currentRuntimeAuthHash) ||
			!isPasswordHash(args.runtimeAuthHash)
		) {
			throw new ConvexError("Invalid password hash.");
		}
		await ctx.runMutation(internal.instance.auth.applyPasswordChange, args);
		return { accepted: true };
	}
});

export const applyPasswordChange = internalMutation({
	args: {
		boxId: v.id("boxes"),
		currentRuntimeAuthHash: v.string(),
		runtimeAuthHash: v.string()
	},
	handler: async (ctx, args) => {
		const box = await ctx.db.get(args.boxId);
		if (!box || box.deleted_at) {
			throw new ConvexError("Box not found.");
		}
		// The box sends its configured hash only after validating the current
		// password locally. The browser's signed session never contains this hash.
		// Matching it here prevents a stale or different box from changing the
		// control-plane value; this only records a change already made on the box.
		if (box.runtime_auth_hash !== args.currentRuntimeAuthHash) {
			throw new ConvexError("Current password does not match.");
		}
		if (box.runtime_auth_hash === args.runtimeAuthHash) return;
		const timestamp = Date.now();
		await ctx.db.patch(box._id, {
			runtime_auth_hash: args.runtimeAuthHash,
			updated_at: timestamp
		});
		// Reconcile even though the box already applied this itself. A cloud box
		// reads its password from COMPOSERY_HASHED_PASSWORD in the env file we
		// render, which still holds the old hash: without this the new password
		// works until the next restart and then silently reverts.
		await ctx.scheduler.runAfter(
			PASSWORD_RECONCILE_DELAY_MS,
			internal.instance.auth.reconcilePassword,
			{
				boxId: box._id,
				idempotencyKey: `password:${box._id}:${timestamp}`,
				runtimeAuthHash: args.runtimeAuthHash,
				attempt: 1
			}
		);
	}
});

export const boxForAuthorization = internalQuery({
	args: { boxId: v.id("boxes") },
	handler: async (ctx, args) => await ctx.db.get(args.boxId)
});

export const storeAuthorizationCode = internalMutation({
	args: {
		boxId: v.id("boxes"),
		codeHash: v.string(),
		codeChallenge: v.string(),
		redirectUri: v.string(),
		type: vBoxAuthorizationType
	},
	handler: async (ctx, args) => {
		const timestamp = Date.now();
		await ctx.db.insert("box_auth_codes", {
			box_id: args.boxId,
			code_hash: args.codeHash,
			code_challenge: args.codeChallenge,
			redirect_uri: args.redirectUri,
			type: args.type,
			expires_at: timestamp + AUTHORIZATION_CODE_TTL_MS,
			created_at: timestamp
		});
	}
});

export const exchangeCode = internalMutation({
	args: {
		boxId: v.id("boxes"),
		codeHash: v.string(),
		codeChallenge: v.string(),
		redirectUri: v.string(),
		type: vBoxAuthorizationType,
		grantHash: v.optional(v.string())
	},
	handler: async (ctx, args) => {
		const code = await ctx.db
			.query("box_auth_codes")
			.withIndex("code_hash", (query) => query.eq("code_hash", args.codeHash))
			.unique();
		const timestamp = Date.now();
		if (
			!code ||
			code.box_id !== args.boxId ||
			code.consumed_at ||
			code.expires_at <= timestamp ||
			code.code_challenge !== args.codeChallenge ||
			code.redirect_uri !== args.redirectUri ||
			code.type !== args.type
		) {
			throw new ConvexError("Invalid or expired authorization code.");
		}

		const grantHash = args.grantHash;
		if (args.type === "session") {
			if (grantHash !== undefined) {
				throw new ConvexError("Invalid authorization capability.");
			}
			await ctx.db.patch(code._id, { consumed_at: timestamp });
			return;
		}
		if (!grantHash) {
			throw new ConvexError("Invalid authorization capability.");
		}
		await ctx.db.patch(code._id, { consumed_at: timestamp });
		await ctx.db.insert("box_auth_grants", {
			box_id: args.boxId,
			token_hash: grantHash,
			expires_at: timestamp + SETUP_GRANT_TTL_MS,
			created_at: timestamp
		});
	}
});

export const claimGrantForPassword = internalMutation({
	args: {
		boxId: v.id("boxes"),
		grantHash: v.string(),
		runtimeAuthHash: v.string()
	},
	handler: async (ctx, args) => {
		const grant = await ctx.db
			.query("box_auth_grants")
			.withIndex("token_hash", (query) =>
				query.eq("token_hash", args.grantHash)
			)
			.unique();
		const timestamp = Date.now();
		if (
			!grant ||
			grant.box_id !== args.boxId ||
			grant.expires_at <= timestamp ||
			(grant.consumed_at && grant.runtime_auth_hash !== args.runtimeAuthHash)
		) {
			throw new ConvexError("Invalid or expired setup grant.");
		}

		const box = await ctx.db.get(args.boxId);
		if (!box || box.deleted_at) {
			throw new ConvexError("Box not found.");
		}
		if (!grant.consumed_at) {
			await ctx.db.patch(grant._id, {
				consumed_at: timestamp,
				runtime_auth_hash: args.runtimeAuthHash
			});
		}
		await ctx.db.patch(box._id, {
			runtime_auth_hash: grant.runtime_auth_hash ?? args.runtimeAuthHash,
			password_setup_pending_at: timestamp,
			updated_at: timestamp
		});
		await ctx.scheduler.runAfter(
			PASSWORD_RECONCILE_DELAY_MS,
			internal.instance.auth.reconcilePassword,
			{
				boxId: grant.box_id,
				idempotencyKey: `password:${grant._id}`,
				runtimeAuthHash: grant.runtime_auth_hash ?? args.runtimeAuthHash,
				attempt: 1
			}
		);
	}
});

export const reconcilePassword = internalAction({
	args: {
		boxId: v.id("boxes"),
		idempotencyKey: v.string(),
		runtimeAuthHash: v.string(),
		attempt: v.number()
	},
	handler: async (ctx, args) => {
		const box = await ctx.runQuery(internal.instance.auth.boxForAuthorization, {
			boxId: args.boxId
		});
		if (
			!box ||
			box.deleted_at ||
			box.runtime_auth_hash !== args.runtimeAuthHash
		) {
			return;
		}

		try {
			await startBoxOperation(ctx, box._id, "change_password", {
				idempotencyKey: args.idempotencyKey,
				// The owner changed the password on the box itself; this reconciles the
				// hash we hold with what they set, so it is their action, not ours.
				trigger: "owner",
				// Stryker disable next-line ObjectLiteral: these are the workflow's
				// arguments, not the operation's, so nothing outside the workflow
				// body reads them back - and a workflow body cannot run in the test
				// harness (packages/web/tests/support/convex.ts records why).
				workflowArgs: { runtimeAuthHash: args.runtimeAuthHash }
			});
		} catch (error) {
			if (args.attempt >= PASSWORD_RECONCILE_MAX_ATTEMPTS) throw error;
			await ctx.scheduler.runAfter(
				PASSWORD_RECONCILE_RETRY_MS,
				internal.instance.auth.reconcilePassword,
				{ ...args, attempt: args.attempt + 1 }
			);
		}
	}
});

const AUTH_RECORD_DELETE_BATCH = 200;

export const deleteExpiredAuthRecords = internalMutation({
	args: {},
	handler: async (ctx) => {
		const timestamp = Date.now();
		let deleted = 0;
		let full = false;
		for (const table of ["box_auth_codes", "box_auth_grants"] as const) {
			const rows = await ctx.db
				.query(table)
				.withIndex("expires_at", (query) => query.lt("expires_at", timestamp))
				.take(AUTH_RECORD_DELETE_BATCH);
			for (const row of rows) {
				await ctx.db.delete(row._id as Id<typeof table>);
				deleted += 1;
			}
			if (rows.length === AUTH_RECORD_DELETE_BATCH) full = true;
		}
		// A full batch means there was more than this transaction could take, so it
		// says so and comes back. Without this the sweep deleted at most 400 rows
		// per quarter hour whatever it found: an authorization code lives two
		// minutes, so a fleet minting them faster than that ceiling would grow both
		// tables without bound, for ever, while the cron reported success every
		// fifteen minutes. Every other sweep in this codebase re-drives on a full
		// batch; this one did not.
		if (full) {
			await ctx.scheduler.runAfter(
				0,
				internal.instance.auth.deleteExpiredAuthRecords,
				{}
			);
		}
		return deleted;
	}
});
