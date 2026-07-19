// What a signed-in visitor may ask about their own account.
//
// Filed under `owner/` rather than beside the identity helpers in
// `convex/users.ts` for the same reason every other public function is: an
// audience directory is the list of what can be called from outside, and one
// that has exceptions is not a list. These two were the last public functions
// living in a module whose other twelve exports are internal.
import { mutation, query } from "../_generated/server";
import {
	ensureUserRecord,
	findUserByClerkId,
	userHasCapability
} from "../users";

// Called once per load so a browsing account exists before staff ever need to
// find it. It returns nothing: the caller only needs the row to be there, and
// shipping the role and suspension reason to every page was a payload nobody
// read.
export const ensureCurrentUser = mutation({
	args: {},
	handler: async (ctx) => {
		await ensureUserRecord(ctx);
	}
});

// Whether to offer the console at all - the nav link and the page's own server
// guard ask this and nothing else. It answers `false` rather than throwing,
// because "you are an ordinary customer" is the expected case here, not a
// failure; every backend endpoint behind the console still checks the specific
// capability it needs, which is where the boundary actually is.
export const canAccessStaffConsole = query({
	args: {},
	handler: async (ctx) => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) return false;
		return userHasCapability(
			await findUserByClerkId(ctx, identity.subject),
			"staff_console"
		);
	}
});
