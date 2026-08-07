"use client";

import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from "lucide-react";
import type { TableSortControls } from "@/hooks/use-table-sort";
import { cn } from "@/lib/utils";

// Clickable column header that drives a useTableSort instance. Shows the active
// direction arrow when its key is sorted, and a faint hint arrow on hover.
export function SortHeader<Key extends string>({
	label,
	sort,
	sortKey
}: {
	label: string;
	sort: TableSortControls<Key>;
	sortKey: Key;
}) {
	const active = sort.sortKey === sortKey;
	return (
		<button
			className={cn(
				"group/sort -mx-1 inline-flex cursor-pointer items-center gap-1 rounded-md px-1 transition-colors",
				active ? "text-foreground" : "hover:text-foreground"
			)}
			onClick={() => sort.toggleSort(sortKey)}
			type="button"
		>
			{label}
			<span className="flex w-3.5 justify-center">
				{active ? (
					sort.sortDirection === "ascending" ? (
						<ArrowUpIcon className="size-3.5" />
					) : (
						<ArrowDownIcon className="size-3.5" />
					)
				) : (
					<ChevronsUpDownIcon className="size-3.5 opacity-0 transition-opacity group-hover/sort:opacity-50" />
				)}
			</span>
		</button>
	);
}
