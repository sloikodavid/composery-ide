import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { currentUserForRead, requireActiveUser } from "../users";
import { findOwnedBoxBySlug } from "../boxes/queries";
import {
	RUNTIME_CONFIG_FIELDS,
	RuntimeConfigError,
	SECRET_CONFIG_KEYS,
	applySecretIntent,
	normalizeRuntimeConfig
} from "../boxes/configuration";
import { startBoxOperation } from "../boxes/operation/start";
import { isOperationAllowed } from "../model/box/operation";
import { sanitizeSlug } from "../model/box/slug";

// The box needs these values, the owner set them, and nobody needs to read them
// back - so the page is told one exists rather than being sent it. A page that
// echoed a GitHub token would put it in every browser cache and error report
// that ever renders it.
const SECRET_KEYS = new Set(SECRET_CONFIG_KEYS);

export const get = query({
	args: { slug: v.string() },
	handler: async (ctx, args) => {
		const { identity } = await currentUserForRead(ctx);
		const box = await findOwnedBoxBySlug(
			ctx,
			identity.subject,
			sanitizeSlug(args.slug)
		);
		if (!box) return null;

		const stored = box.runtime_config ?? {};
		return {
			// The field definitions travel with the values so the page renders from
			// one source. Adding a variable to the allowlist makes it appear without
			// a matching change in the interface, which is what stops the two lists
			// drifting apart.
			fields: RUNTIME_CONFIG_FIELDS,
			values: Object.fromEntries(
				Object.entries(stored).map(([key, value]) => [
					key,
					SECRET_KEYS.has(key) ? "" : value
				])
			),
			// Which secrets are set, without their values, so the page can say "set"
			// instead of showing an empty box that looks unconfigured.
			secretsSet: Object.keys(stored).filter((key) => SECRET_KEYS.has(key)),
			canConfigure: isOperationAllowed(box.status, "change_config")
		};
	}
});

export const save = mutation({
	args: {
		slug: v.string(),
		config: v.record(v.string(), v.string())
	},
	handler: async (ctx, args) => {
		const user = await requireActiveUser(ctx);
		const box = await findOwnedBoxBySlug(
			ctx,
			user.clerk_user_id,
			sanitizeSlug(args.slug)
		);
		if (!box) throw new ConvexError("Box not found.");

		let config: Record<string, string>;
		try {
			config = normalizeRuntimeConfig(args.config);
		} catch (error) {
			// The field-level message is the whole value of validating here rather
			// than letting the env render fail later: the owner is told which
			// variable is wrong while the form is still in front of them.
			throw new ConvexError(
				error instanceof RuntimeConfigError
					? error.message
					: "That configuration could not be applied."
			);
		}

		config = applySecretIntent({
			normalized: config,
			stored: box.runtime_config,
			submittedKeys: Object.keys(args.config)
		});

		const operationId = await startBoxOperation(ctx, box._id, "change_config", {
			idempotencyKey: `change-config:${box._id}:${Date.now()}`,
			trigger: "owner",
			// The attempted configuration lives on the operation so a failed apply is
			// still recoverable for support, even though the box row deliberately
			// keeps the last configuration known to boot. Secret values are held back
			// - an operation record is read by staff.
			metadata: {
				keys: Object.keys(config)
					.filter((key) => !SECRET_KEYS.has(key))
					.sort()
			},
			workflowArgs: { config }
		});

		if (!operationId) {
			throw new ConvexError("This box is already applying a configuration.");
		}
	}
});
