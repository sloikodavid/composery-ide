import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../_generated/server";

// How many boxes this deployment has ever created, and the one place a box row
// is inserted.
//
// Those are one module on purpose. The total is only true if it rises with every
// insert, and nothing in the type system can say "increment that row when you
// write this one". `tests/invariants/convex/box-inserts.test.ts` holds the other
// half - it reads the checkout for inserts into the boxes table and allows the
// one below - so a third way to bring a box into existence cannot be written
// without passing the total on the way. That test matches on source text, so it
// counts a mention of the call in a comment as a second call site: describe the
// insert here, never spell it.
//
// Two mutations converting at once both read the row and both write it, which
// Convex settles by retrying the loser of the conflict. So the read-then-patch
// below cannot lose a box the way it would in a database that let both writes
// through.

async function countsRow(ctx: { db: DatabaseReader }) {
	return await ctx.db.query("box_counts").first();
}

// Zero before the first box, not null: a deployment that has created nothing has
// created zero, and every reader would otherwise repeat that reading.
export async function readBoxesCreated(ctx: { db: DatabaseReader }) {
	return (await countsRow(ctx))?.created ?? 0;
}

export async function insertBox(
	ctx: MutationCtx,
	box: WithoutSystemFields<Doc<"boxes">>
): Promise<Id<"boxes">> {
	const boxId = await ctx.db.insert("boxes", box);

	const row = await countsRow(ctx);
	if (row) await ctx.db.patch(row._id, { created: row.created + 1 });
	else await ctx.db.insert("box_counts", { created: 1 });

	return boxId;
}
