"use client";

import { useSyncExternalStore } from "react";

// One definition of "is this a touch device", so the box actions bar has a single
// answer to lay itself out against.
const TOUCH_QUERY = "(hover: none) and (pointer: coarse)";

function subscribe(onChange: () => void) {
	const mql = window.matchMedia(TOUCH_QUERY);
	mql.addEventListener("change", onChange);
	return () => mql.removeEventListener("change", onChange);
}

// True on phones/tablets. The server snapshot is false so SSR markup matches the
// first client paint; useSyncExternalStore then settles to the real value with no
// setState-in-effect and no hydration mismatch.
export function useIsTouch() {
	return useSyncExternalStore(
		subscribe,
		() => window.matchMedia(TOUCH_QUERY).matches,
		() => false
	);
}
