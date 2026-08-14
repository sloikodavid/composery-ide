// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

// The navigation bar's own rule about a question it has not heard back on yet.
//
// Answering "your boxes" while the staff query is in flight puts one item on the
// bar and then shoves it sideways a round trip later when Console appears beside
// it. So nothing renders until the answer is known and the bar grows once.

const useQuery = vi.fn();
vi.mock("convex/react", () => ({ useQuery: () => useQuery() }));

const { PUBLIC_NAV_LINKS, useAuthedNavLinks } = await import("@/lib/nav-links");

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const labels = () =>
	renderHook(() => useAuthedNavLinks()).result.current.map(
		(link) => link.label
	);

describe("what the navigation offers a signed-in visitor", () => {
	test("offers nothing at all until the answer is known", () => {
		useQuery.mockReturnValue(undefined);

		expect(labels()).toEqual([]);
	});

	test("offers an ordinary account only their own boxes", () => {
		useQuery.mockReturnValue(false);

		expect(labels()).toEqual(["Boxes"]);
	});

	// Staff keep their own boxes: the console is an addition, not a replacement,
	// and a staff member with boxes of their own still needs the way to them.
	test("offers staff the console beside their boxes", () => {
		useQuery.mockReturnValue(true);

		expect(labels()).toEqual(["Boxes", "Console"]);
	});
});

describe("what the navigation offers everyone", () => {
	test("names the two pages a signed-out visitor can reach", () => {
		expect(PUBLIC_NAV_LINKS.map((link) => link.href)).toEqual([
			"/pricing",
			"/docs"
		]);
	});

	// Every link renders an icon by name from the animated-icon map, so a link
	// with no icon is a gap in the bar rather than a missing picture.
	test("gives every link a label, a destination and an icon", () => {
		useQuery.mockReturnValue(true);
		const all = [
			...PUBLIC_NAV_LINKS,
			...renderHook(() => useAuthedNavLinks()).result.current
		];

		for (const link of all) {
			expect(link.href.startsWith("/")).toBe(true);
			expect(link.label.length).toBeGreaterThan(0);
			expect(link.icon.length).toBeGreaterThan(0);
		}
	});
});
