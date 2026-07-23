"use client";

import { useMutation } from "convex/react";
import Link from "next/link";
import { DismissButton } from "@/components/dismiss-button";
import { OpenInConvex, OpenInHetzner } from "@/components/open-in";
import { SortHeader } from "@/components/sort-header";
import {
	Table,
	TableBody,
	TableCell,
	TableEmptyRow,
	TableHead,
	TableHeader,
	TableLoadingRow,
	TableRow
} from "@/components/base/table";
import { useTableSort } from "@/hooks/use-table-sort";
import { formatDateTime } from "@/lib/datetime";
import { flagSignalLabel, type BoxFlagSignal } from "@/convex/model/box/metric";
import { consoleBoxPath } from "@/convex/model/box/path";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useBusyAction } from "@/hooks/use-busy-action";

// `signal` is the schema's own union rather than `string`: this row is what the
// console reads, and a loose type here is what let the raw identifier through a
// fallback and onto the page.
type FlagRow = {
	autoSuspended: boolean;
	boxId: Id<"boxes">;
	createdAt: number;
	dismissedAt: number | null;
	hetznerServerId: number | null;
	id: Id<"box_flags">;
	message: string;
	signal: BoxFlagSignal;
	slug: string;
};

const FLAG_SORT = {
	flag: (flag: FlagRow) => flagSignalLabel(flag.signal),
	slug: (flag: FlagRow) => flag.slug,
	createdAt: (flag: FlagRow) => flag.createdAt
};

// Abuse threshold crossings as a standalone panel; `showBox` adds the box
// column for the cross-box list on the console home.
export function FlagsTable({
	boxId,
	flags,
	showBox
}: {
	boxId?: Id<"boxes">;
	flags?: FlagRow[];
	showBox?: boolean;
}) {
	const dismissFlag = useMutation(api.staff.metrics.dismissFlag);
	const dismissAllFlags = useMutation(api.staff.metrics.dismissAllFlags);
	const { busy, run } = useBusyAction();
	const { sort, sortedRows } = useTableSort(flags ?? [], FLAG_SORT);
	const hasCurrentFlags = flags?.some((flag) => !flag.dismissedAt) ?? false;

	return (
		<div className="overflow-hidden rounded-2xl bg-card">
			<Table
				cols={
					showBox
						? ["fluid", "text", "datetime", "actions-3"]
						: ["fluid", "datetime", "actions-3"]
				}
			>
				<TableHeader>
					<TableRow>
						<TableHead className="pl-4">
							<SortHeader label="Flag" sort={sort} sortKey="flag" />
						</TableHead>
						{showBox ? (
							<TableHead>
								<SortHeader label="Box" sort={sort} sortKey="slug" />
							</TableHead>
						) : null}
						<TableHead>
							<SortHeader label="Created" sort={sort} sortKey="createdAt" />
						</TableHead>
						<TableHead className="pr-4 text-right">
							<div className="flex items-center justify-end gap-1">
								{hasCurrentFlags ? (
									<DismissButton
										disabled={busy !== null}
										iconOnly
										onClick={() =>
											run("dismiss-all-flags", "Flags dismissed", () =>
												dismissAllFlags({ boxId })
											)
										}
									>
										Dismiss all
									</DismissButton>
								) : null}
								<OpenInHetzner iconOnly label="Open servers in Hetzner" />
								<OpenInConvex iconOnly table="box_flags" />
							</div>
						</TableHead>
					</TableRow>
				</TableHeader>
				{flags === undefined ? (
					<TableBody>
						<TableLoadingRow />
					</TableBody>
				) : flags.length > 0 ? (
					<TableBody className="page-fade-in">
						{sortedRows.map((flag) => (
							<TableRow
								className="[&>td]:align-top has-[[data-link]:hover]:bg-hover"
								key={flag.id}
							>
								<TableCell className="pl-4">
									<div>
										<p className="font-medium wrap-break-word text-foreground">
											{flagSignalLabel(flag.signal)}
											{flag.autoSuspended ? " - auto-suspended" : ""}
										</p>
										<p className="wrap-break-word whitespace-normal text-muted-foreground">
											{flag.message}
										</p>
										{flag.dismissedAt ? (
											<p className="text-xs text-muted-foreground">
												Dismissed {formatDateTime(flag.dismissedAt)}
											</p>
										) : null}
									</div>
								</TableCell>
								{showBox ? (
									<TableCell>
										<Link
											className="block truncate text-foreground"
											data-link
											href={consoleBoxPath(flag.boxId)}
										>
											{flag.slug}
										</Link>
									</TableCell>
								) : null}
								<TableCell>{formatDateTime(flag.createdAt)}</TableCell>
								<TableCell className="pr-4 text-right">
									<div className="flex items-center justify-end gap-1">
										{flag.dismissedAt ? null : (
											<DismissButton
												disabled={busy !== null}
												iconOnly
												onClick={() =>
													run(`dismiss-flag-${flag.id}`, "Flag dismissed", () =>
														dismissFlag({ flagId: flag.id })
													)
												}
											/>
										)}
										<OpenInHetzner
											iconOnly
											label={`Open ${flag.slug} server in Hetzner`}
											serverId={flag.hetznerServerId}
										/>
										<OpenInConvex
											iconOnly
											label={`Open ${flag.slug} flag in Convex`}
											table="box_flags"
											value={flag.id}
										/>
									</div>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				) : (
					<TableBody>
						<TableEmptyRow>No flags.</TableEmptyRow>
					</TableBody>
				)}
			</Table>
		</div>
	);
}
