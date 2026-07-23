"use client";

import { useState } from "react";

export type SortDirection = "ascending" | "descending";

export type TableSortControls<Key extends string> = {
	sortDirection: SortDirection;
	sortKey: Key | null;
	toggleSort: (key: Key) => void;
};

// Column sorting for a table that already holds every row it will show - one
// page of a paginated query, or a capped list - so the sort is over tens to
// hundreds of rows and is done on each render.
//
// Deliberately not memoized. `accessors` is a record of functions, and a call
// site that writes it inline hands over a new one every render, so a `useMemo`
// keyed on it recomputes every render anyway while reading as though it does
// not. That is the worse of the two: the cost is identical and the code claims a
// guarantee it never had.
export function useTableSort<Row, Key extends string>(
	rows: Row[],
	accessors: Record<Key, (row: Row) => string | number>
) {
	const [sortKey, setSortKey] = useState<Key | null>(null);
	const [sortDirection, setSortDirection] =
		useState<SortDirection>("ascending");

	function sortRows() {
		if (sortKey === null) return rows;
		const read = accessors[sortKey];
		return [...rows].sort((first, second) => {
			const firstValue = read(first);
			const secondValue = read(second);
			const result =
				typeof firstValue === "number" && typeof secondValue === "number"
					? firstValue - secondValue
					: String(firstValue).localeCompare(String(secondValue));
			return sortDirection === "ascending" ? result : -result;
		});
	}

	function toggleSort(nextKey: Key) {
		if (sortKey === nextKey) {
			setSortDirection((current) =>
				current === "ascending" ? "descending" : "ascending"
			);
			return;
		}
		setSortKey(nextKey);
		setSortDirection("ascending");
	}

	const sort: TableSortControls<Key> = { sortDirection, sortKey, toggleSort };
	return { sort, sortedRows: sortRows() };
}
