// What this deployment publishes about its own size.
//
// The `site/` audience, so an anonymous visitor is the caller: this is read by
// the home page and by anyone who asks. Only ever a total that rises - see
// `boxes/counts.ts` for why a count of the `boxes` table is not one.
import { v } from "convex/values";
import { query } from "../_generated/server";
import { readBoxesCreated } from "../boxes/counts";

export const boxesCreated = query({
	args: {},
	returns: v.number(),
	handler: async (ctx) => await readBoxesCreated(ctx)
});
