import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";

const RUNTIME_LOG_LINES = 200;

// `logs` is null when the stream is unavailable - the box is not running, or
// the container is mid-restart. Callers keep polling and recover; nothing here
// throws for a transient container state.
export async function fetchRuntimeLogsSafely(
	ctx: ActionCtx,
	boxId: Id<"boxes">
): Promise<{ logs: string | null }> {
	try {
		const logs: string = await ctx.runAction(
			internal.boxes.infra.host.fetchRuntimeLogs,
			{ boxId, tail: RUNTIME_LOG_LINES }
		);
		return { logs };
	} catch {
		return { logs: null };
	}
}
