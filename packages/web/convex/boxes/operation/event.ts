import type { Doc } from "../../_generated/dataModel";
import type { DatabaseWriter } from "../../_generated/server";
import type { BoxEventType } from "../../model/box/operation";

type WriteDbCtx = { db: DatabaseWriter };

// `type` is the closed union rather than `string`, which is what makes the
// audit history unable to grow a row nothing can name: every member of it has a
// label in `convex/model/box/operation.ts`, so a new event is named in the same edit
// that writes it or it does not compile.
export async function appendBoxEvent(
	ctx: WriteDbCtx,
	box: Pick<Doc<"boxes">, "_id" | "user_id">,
	type: BoxEventType,
	input?: { message?: string; metadata?: Record<string, unknown> }
) {
	await ctx.db.insert("box_events", {
		box_id: box._id,
		user_id: box.user_id,
		type,
		message: input?.message,
		metadata: input?.metadata,
		created_at: Date.now()
	});
}
