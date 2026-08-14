// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { useTableSort } from "@/hooks/use-table-sort";

afterEach(cleanup);

type Row = { at: number; slug: string };

const ROWS: Row[] = [
	{ at: 30, slug: "beta" },
	{ at: 10, slug: "Alpha" },
	{ at: 20, slug: "gamma" }
];

const ACCESSORS = {
	at: (row: Row) => row.at,
	slug: (row: Row) => row.slug
};

function sorted(rows: Row[]) {
	return rows.map((row) => row.slug);
}

describe("useTableSort", () => {
	test("leaves the rows in the order they arrived until a column is chosen", () => {
		const { result } = renderHook(() => useTableSort(ROWS, ACCESSORS));

		expect(result.current.sortedRows).toBe(ROWS);
		expect(result.current.sort.sortKey).toBeNull();
	});

	// Numbers compare as numbers. Falling back to string comparison would put 100
	// before 20, which is the shape of bug a date column hides for months.
	test("compares a numeric column numerically", () => {
		const { result } = renderHook(() =>
			useTableSort(
				[
					{ at: 100, slug: "a" },
					{ at: 20, slug: "b" }
				],
				ACCESSORS
			)
		);

		act(() => result.current.sort.toggleSort("at"));

		expect(result.current.sortedRows.map((row) => row.at)).toEqual([20, 100]);
	});

	// A slug column holds what people typed, so "Alpha" belongs beside "alpha"
	// rather than ahead of every lower-case row the way a codepoint sort puts it.
	test("compares a text column the way a reader would", () => {
		const { result } = renderHook(() => useTableSort(ROWS, ACCESSORS));

		act(() => result.current.sort.toggleSort("slug"));

		expect(sorted(result.current.sortedRows)).toEqual([
			"Alpha",
			"beta",
			"gamma"
		]);
	});

	test("reverses when the same column is chosen again", () => {
		const { result } = renderHook(() => useTableSort(ROWS, ACCESSORS));

		act(() => result.current.sort.toggleSort("at"));
		expect(sorted(result.current.sortedRows)).toEqual([
			"Alpha",
			"gamma",
			"beta"
		]);

		act(() => result.current.sort.toggleSort("at"));
		expect(result.current.sort.sortDirection).toBe("descending");
		expect(sorted(result.current.sortedRows)).toEqual([
			"beta",
			"gamma",
			"Alpha"
		]);
	});

	// Moving to another column starts it ascending rather than inheriting the
	// direction the previous one happened to be left in.
	test("starts a newly chosen column ascending", () => {
		const { result } = renderHook(() => useTableSort(ROWS, ACCESSORS));

		act(() => result.current.sort.toggleSort("at"));
		act(() => result.current.sort.toggleSort("at"));
		act(() => result.current.sort.toggleSort("slug"));

		expect(result.current.sort.sortDirection).toBe("ascending");
		expect(sorted(result.current.sortedRows)).toEqual([
			"Alpha",
			"beta",
			"gamma"
		]);
	});

	test("does not reorder the array it was handed", () => {
		const rows = [...ROWS];
		const { result } = renderHook(() => useTableSort(rows, ACCESSORS));

		act(() => result.current.sort.toggleSort("slug"));

		expect(sorted(rows)).toEqual(["beta", "Alpha", "gamma"]);
	});
});
