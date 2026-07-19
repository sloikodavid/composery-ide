// What a running box may ask about the fleet's current image.
//
// Deliberately the narrowest possible answer: the digest and the label, and
// nothing else. The digest is what a box compares against its own
// COMPOSERY_RUNTIME_IMAGE, so both surfaces answer from one fact rather than one
// comparing labels and the other digests. It is not a secret to withhold - it is
// the content address of a public image, and anyone can resolve the same tag
// themselves. What stays behind the authenticated queries is everything *about
// the fleet*: the floor, its deadline, and how many boxes there are.
//
// Null means there is no cached release to compare against - never refreshed
// yet, or a channel tag that resolved to no version. Callers must read that as
// "not known", never as "you are current".
import { v } from "convex/values";
import { query } from "../_generated/server";
import { readGlobalSettings } from "../settings";

export const fleetVersion = query({
	args: {},
	returns: v.object({
		image: v.union(v.string(), v.null()),
		version: v.union(v.string(), v.null())
	}),
	handler: async (ctx) => {
		const settings = await readGlobalSettings(ctx);
		return {
			image: settings.runtimeRelease?.image ?? null,
			version: settings.runtimeRelease?.version ?? null
		};
	}
});
