// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { useIsTouch } from "@/hooks/use-is-touch";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

// One definition of "is this a touch device", and it is a capability question
// rather than a device one: hover availability and pointer coarseness, both
// observable. A touchscreen laptop has a coarse pointer *and* hover, a tablet
// with a trackpad has hover, and a narrow desktop window has neither - so a
// check keyed to width, or to a vendor string, is wrong on all three.

type Listener = () => void;

// A matchMedia that records which query it was asked and can change its answer,
// because the whole point of `useSyncExternalStore` here is that the answer is
// allowed to change while the page is open.
function stubMatchMedia(initial: boolean) {
	const listeners = new Set<Listener>();
	const queries: string[] = [];
	let matches = initial;

	vi.stubGlobal(
		"matchMedia",
		vi.fn((query: string) => {
			queries.push(query);
			return {
				get matches() {
					return matches;
				},
				media: query,
				addEventListener: (_event: string, listener: Listener) => {
					listeners.add(listener);
				},
				removeEventListener: (_event: string, listener: Listener) => {
					listeners.delete(listener);
				}
			};
		})
	);

	return {
		queries,
		set(next: boolean) {
			matches = next;
			for (const listener of listeners) listener();
		},
		listenerCount: () => listeners.size
	};
}

describe("deciding whether the pointer is a finger", () => {
	test("asks about hover and pointer coarseness, not about a screen size", () => {
		const media = stubMatchMedia(false);

		renderHook(() => useIsTouch());

		expect(media.queries[0]).toBe("(hover: none) and (pointer: coarse)");
		expect(media.queries.join(" ")).not.toMatch(/width/);
	});

	test("reports true where there is no hover and the pointer is coarse", () => {
		stubMatchMedia(true);

		expect(renderHook(() => useIsTouch()).result.current).toBe(true);
	});

	test("reports false anywhere the query does not match", () => {
		stubMatchMedia(false);

		expect(renderHook(() => useIsTouch()).result.current).toBe(false);
	});

	// A tablet put into a keyboard case, or a browser window moved to a second
	// screen, changes the answer without reloading the page.
	test("follows the capability changing while the page is open", () => {
		const media = stubMatchMedia(false);
		const { result } = renderHook(() => useIsTouch());

		act(() => media.set(true));
		expect(result.current).toBe(true);

		act(() => media.set(false));
		expect(result.current).toBe(false);
	});

	// The subscription is what makes the change above visible, and leaving it
	// attached after unmount is a listener per mount for the life of the tab.
	test("stops listening once the component is gone", () => {
		const media = stubMatchMedia(false);
		const { unmount } = renderHook(() => useIsTouch());
		expect(media.listenerCount()).toBe(1);

		unmount();

		expect(media.listenerCount()).toBe(0);
	});
});
