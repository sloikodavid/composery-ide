"use client";

import { useState } from "react";

// Re-seed local form state when the server's answer actually changes.
//
// The comparison is on a signature of the *content*, never on the identity of
// the value, and that is the whole point of this existing. A Convex query result
// is a new object on every push that touches anything it read: the console's
// settings query also reports live capacity, so it is rebuilt whenever any box
// in the fleet changes state - a box starting, a snapshot finishing, a checkout
// reservation lapsing. A form that re-seeded on identity threw away whatever
// someone had typed but not yet saved, on an event that had nothing to do with
// them. Every form here goes through this, so there is no longer a right and a
// wrong way to ask the question.
//
// `signature` is null while the server has not answered yet, which is the state
// where there is nothing to seed from and nothing to compare against.
export function useReseed(signature: string | null, reseed: () => void) {
	const [seeded, setSeeded] = useState<string | null>(null);

	// A render-phase state update, which React handles by re-rendering this
	// component before committing - the documented alternative to a
	// setState-in-effect, which would paint the stale draft for a frame first.
	if (signature !== null && signature !== seeded) {
		setSeeded(signature);
		reseed();
	}
}
