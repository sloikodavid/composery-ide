import { fetchQuery } from "convex/nextjs";
import { NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";

// The oracle a cloud box's in-IDE update notifier asks. GitHub is the wrong
// authority for these boxes: what they run is whatever the fleet's runtime
// channel resolved to, which deliberately lags the latest release, and their
// owner cannot pull an image anyway - the website drives the update over SSH.
//
// Unauthenticated, because a box has no website session to present, so the body
// carries only what a box needs to compare itself: the fleet's current image
// digest and its version label. The digest is the content address of a public
// image, not a secret - what stays behind the authenticated queries is the
// minimum-version floor, its deadline, and anything about how many boxes exist.
export const dynamic = "force-dynamic";

// The refresh behind this value runs hourly, so caching for five minutes cannot
// make the answer meaningfully staler than its source, and every box in the
// fleet polls this same route.
const CACHE_CONTROL = "public, max-age=300, s-maxage=300";

export async function GET() {
	try {
		const release = await fetchQuery(api.instance.release.fleetVersion, {});
		return NextResponse.json(release, {
			headers: { "Cache-Control": CACHE_CONTROL }
		});
	} catch {
		// A failure has to look like one, and it must not be cached. A 200 carrying
		// no version reads as a successful "nothing is cached yet", which is a
		// different fact from "we could not answer".
		return NextResponse.json(
			{ error: "Runtime release is unavailable." },
			{ status: 503, headers: { "Cache-Control": "no-store" } }
		);
	}
}
