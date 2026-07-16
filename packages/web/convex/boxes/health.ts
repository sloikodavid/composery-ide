"use node";

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { cloudUrl } from "../env";
import { vRecoveryStatus, type RecoveryStatus } from "../model/box/recovery";

const HEALTH_TIMEOUT_MS = 5_000;

export const probeRuntime = internalAction({
	args: {
		boxId: v.id("boxes")
	},
	returns: v.object({
		reachable: v.boolean()
	}),
	handler: async (ctx, args): Promise<{ reachable: boolean }> => {
		const box = await ctx.runQuery(
			internal.boxes.queries.getBoxLifecycleSnapshot,
			{ boxId: args.boxId }
		);
		try {
			const response = await fetch(
				new URL("/_composery/healthz", cloudUrl(box.slug)),
				{
					cache: "no-store",
					redirect: "manual",
					signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
				}
			);
			return { reachable: response.ok };
		} catch {
			return { reachable: false };
		}
	}
});

// The full picture: the public URL and the host inspected in parallel, so the
// Repair dialog can show one honest account of every layer at once. Read-only -
// the single Repair action is the only thing that changes a box.
//
// It lives beside the liveness probe rather than in a module of its own because
// they answer the same question at two levels of detail, and the sweep that calls the
// cheap one has to mean the same thing by "reachable" as the dialog does.
export const recoveryStatus = internalAction({
	args: { boxId: v.id("boxes") },
	returns: vRecoveryStatus,
	handler: async (ctx, args): Promise<RecoveryStatus> => {
		const [http, host] = await Promise.all([
			ctx.runAction(internal.boxes.health.probeRuntime, args),
			ctx.runAction(internal.boxes.infra.host.inspectRuntime, args)
		]);
		return { ...host, httpReachable: http.reachable };
	}
});
