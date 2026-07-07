"use client";

import { LoaderIcon } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

// Column convention. Every table declares its column shape once, as `cols`, and
// the widths come from the map below - never from the contents. That is what
// keeps a table still between its loading and its loaded state: a column is the
// same width empty as it is full.
//
// - Exactly one `fluid` column per table. It carries no width, so it takes all
//   the leftover space and is the only column that ever resizes - with the
//   viewport, never with the data. Its cell truncates or wraps.
// - Every other column takes the token for what it holds. Each width fits that
//   token's widest possible contents, header and sort arrow included.
// - `actions-N` is N icon buttons: N x size-8, the gap-1 between them, and the
//   row's edge padding. Action columns hold icon buttons only, so N says it all.
// - From `sm` up the table is at least the sum of those widths, so a merely
//   narrow window scrolls the container rather than squishing a column into its
//   neighbour. Below `sm` the widths stop applying entirely - see STACKED.
const COL_WIDTH = {
	text: 192, // a slug, an email, an id - anything user-supplied (truncates)
	date: 128, // formatDate, e.g. "Sep 30, 2025"
	datetime: 208, // formatDateTime, e.g. "Sep 30, 2025, 03:04 PM"
	status: 192, // StatusText, glyph plus its longest label ("Couldn't restore")
	short: 96, // a size, a count, a fixed label like "Automatic"
	"actions-1": 60,
	"actions-2": 96,
	"actions-3": 132
} as const;

// What the fluid column is guaranteed, and so the width the table reserves for
// it before the container starts scrolling.
const FLUID_WIDTH = 192;

// Below `sm` a table stops being a table. There is no width at which four sized
// columns and a phone agree: the fixed columns keep their full width, so the
// fluid column - the one holding what the row is actually about - ends up the
// narrowest thing on the row, and you scroll sideways to read a date that never
// needed the space. Instead each row becomes a block: the first cell is the
// row's identity, the middle cells stack under it as muted metadata, and the
// last cell (an action column in every table here) sits to its right.
//
// This is also why the min-width reservation is a custom property applied from
// `sm` up rather than an inline style - an inline `min-width` no class can
// override is what would keep the scroller alive underneath the stacked rows.
const STACKED = [
	"max-sm:block max-sm:min-w-0",
	"max-sm:[&_thead]:hidden",
	"max-sm:[&_tbody]:block",
	// h-auto because rows are given a fixed h-14 to keep a table's rows even -
	// stacked, that height is a ceiling the content immediately overflows.
	"max-sm:[&_tr]:grid max-sm:[&_tr]:h-auto max-sm:[&_tr]:grid-cols-[1fr_auto] max-sm:[&_tr]:items-center max-sm:[&_tr]:gap-x-3 max-sm:[&_tr]:px-4 max-sm:[&_tr]:py-2.5",
	"max-sm:[&_td]:overflow-visible max-sm:[&_td]:px-0 max-sm:[&_td]:py-0 max-sm:[&_td]:whitespace-normal",
	// Middle cells: their own line under the identity, muted.
	"max-sm:[&_td:not(:first-child):not(:last-child)]:col-start-1 max-sm:[&_td:not(:first-child):not(:last-child)]:text-muted-foreground",
	// Action cell: beside the identity rather than below it.
	"max-sm:[&_td:last-child:not(:only-child)]:col-start-2 max-sm:[&_td:last-child:not(:only-child)]:row-start-1",
	// The loading and empty rows are a single colSpan cell, which is both the
	// first and the last child - it spans instead of sitting in the action slot.
	"max-sm:[&_td:only-child]:col-span-2"
].join(" ");

type TableCol = "fluid" | keyof typeof COL_WIDTH;

// Lets the loading and empty rows span the table without every call site
// restating a count that can drift from the columns above it.
const ColumnCount = React.createContext(1);

function Table({
	children,
	className,
	cols,
	...props
}: React.ComponentProps<"table"> & { cols: readonly TableCol[] }) {
	const fixed = cols.reduce(
		(total, col) => (col === "fluid" ? total : total + COL_WIDTH[col]),
		0
	);
	return (
		<div
			data-slot="table-container"
			className="relative w-full overflow-x-auto"
		>
			<ColumnCount value={cols.length}>
				<table
					data-slot="table"
					className={cn(
						"w-full table-fixed caption-bottom text-sm sm:min-w-(--table-min-width)",
						STACKED,
						className
					)}
					style={
						{
							"--table-min-width": `${fixed + FLUID_WIDTH}px`
						} as React.CSSProperties
					}
					{...props}
				>
					<colgroup>
						{cols.map((col, index) => (
							<col
								key={index}
								style={col === "fluid" ? undefined : { width: COL_WIDTH[col] }}
							/>
						))}
					</colgroup>
					{children}
				</table>
			</ColumnCount>
		</div>
	);
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
	return (
		<thead
			data-slot="table-header"
			className={cn("[&_tr]:border-b", className)}
			{...props}
		/>
	);
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
	return <tbody data-slot="table-body" className={className} {...props} />;
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
	return (
		<tfoot
			data-slot="table-footer"
			className={cn(
				"bg-muted/50 font-medium [&>tr]:last:border-b-0",
				className
			)}
			{...props}
		/>
	);
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
	return (
		<tr
			data-slot="table-row"
			className={cn(
				// No row-level hover: only clickable regions (e.g. a row's link
				// cell) show a hover state, so hover always means "you can click
				// here". The only line in a table is the one under its header
				// (TableHeader), so rows do not look like separate boxes.
				"transition-colors data-[state=selected]:bg-selected data-[state=selected]:text-selected-foreground",
				className
			)}
			{...props}
		/>
	);
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
	return (
		<th
			data-slot="table-head"
			className={cn(
				"h-10 px-3 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0",
				className
			)}
			{...props}
		/>
	);
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
	return (
		<td
			data-slot="table-cell"
			className={cn(
				// Fixed layout gives the cell its column's width whatever it holds, so
				// overflowing contents clip and ellipsize here rather than widening
				// anything.
				"overflow-hidden px-3 py-2 align-middle text-ellipsis whitespace-nowrap [&:has([role=checkbox])]:pr-0",
				className
			)}
			{...props}
		/>
	);
}

// The shared loading and empty states for data tables: one full-width row in
// place of the body. Neither can move a column, because no column is sized from
// the body.
function TableLoadingRow() {
	return (
		<TableRow>
			<TableCell className="h-14 text-center" colSpan={React.use(ColumnCount)}>
				<LoaderIcon className="mx-auto size-5 animate-spin text-muted-foreground" />
			</TableCell>
		</TableRow>
	);
}

function TableEmptyRow({ children }: { children: string }) {
	return (
		<TableRow>
			<TableCell
				className="h-14 text-center text-muted-foreground"
				colSpan={React.use(ColumnCount)}
			>
				{children}
			</TableCell>
		</TableRow>
	);
}

function TableCaption({
	className,
	...props
}: React.ComponentProps<"caption">) {
	return (
		<caption
			data-slot="table-caption"
			className={cn("mt-4 text-sm text-muted-foreground", className)}
			{...props}
		/>
	);
}

export {
	Table,
	TableHeader,
	TableBody,
	TableFooter,
	TableHead,
	TableRow,
	TableCell,
	TableCaption,
	TableLoadingRow,
	TableEmptyRow
};
