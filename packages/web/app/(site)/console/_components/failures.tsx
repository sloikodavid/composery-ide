"use client";

import { useMutation, useQuery } from "convex/react";
import { TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { DismissButton } from "@/components/dismiss-button";
import { OpenInConvex } from "@/components/open-in";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow
} from "@/components/base/table";
import { api } from "@/convex/_generated/api";
import { useBusyAction } from "@/hooks/use-busy-action";
import { formatDateTime } from "@/lib/datetime";
import { operationLabel } from "@/convex/model/box/operation";
import { consoleBoxPath } from "@/convex/model/box/path";

type FailedOperation = NonNullable<
	ReturnType<typeof useQuery<typeof api.staff.boxes.recentFailedOperations>>
>[number];

// Only renders when something is actually wrong, so a healthy console stays
// clean and this reads as an alert rather than a permanent panel.
export function Failures() {
	const failures = useQuery(api.staff.boxes.recentFailedOperations, {});
	const dismissFailure = useMutation(api.staff.boxes.dismissFailedOperation);
	const dismissAllFailures = useMutation(
		api.staff.boxes.dismissAllFailedOperations
	);
	const { busy, run } = useBusyAction();
	if (!failures || failures.length === 0) return null;

	return (
		<div className="overflow-hidden rounded-2xl border border-destructive/40 bg-card">
			<div className="flex flex-wrap items-center gap-x-2 px-4 py-3">
				<TriangleAlertIcon className="size-4 text-destructive" />
				<span className="text-sm font-medium text-foreground">
					Needs attention
				</span>
				<span className="text-sm text-muted-foreground">
					{failures.length} failed operation{failures.length === 1 ? "" : "s"}{" "}
					in the last 7 days
				</span>
			</div>
			<Table cols={["fluid", "text", "datetime", "actions-2"]}>
				<TableHeader>
					<TableRow>
						<TableHead className="pl-4">Operation</TableHead>
						<TableHead>Box</TableHead>
						<TableHead>When</TableHead>
						<TableHead className="pr-4 text-right">
							<div className="flex items-center justify-end gap-1">
								<DismissButton
									disabled={busy !== null}
									iconOnly
									onClick={() =>
										run("dismiss-all-failures", "Messages dismissed", () =>
											dismissAllFailures({})
										)
									}
								>
									Dismiss all
								</DismissButton>
								<OpenInConvex
									field="status"
									iconOnly
									table="box_operations"
									value="failed"
								/>
							</div>
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody className="page-fade-in">
					{failures.map((failure: FailedOperation) => (
						<TableRow
							className={failure.lastError ? "[&>td]:align-top" : undefined}
							key={failure.id}
						>
							<TableCell className="pl-4">
								<div className="min-w-0">
									<p className="font-medium text-foreground">
										{operationLabel(failure.type)}
									</p>
									{failure.lastError ? (
										<p className="wrap-break-word whitespace-normal text-muted-foreground">
											{failure.lastError}
										</p>
									) : null}
								</div>
							</TableCell>
							<TableCell>
								{failure.slug ? (
									<Link
										className="font-medium text-foreground hover:underline"
										href={consoleBoxPath(failure.boxId)}
									>
										{failure.slug}
									</Link>
								) : (
									<span className="text-muted-foreground">unknown</span>
								)}
							</TableCell>
							<TableCell>{formatDateTime(failure.createdAt)}</TableCell>
							<TableCell className="pr-4 text-right">
								<div className="flex items-center justify-end gap-1">
									<DismissButton
										disabled={busy !== null}
										iconOnly
										onClick={() =>
											run(
												`dismiss-failure-${failure.id}`,
												"Message dismissed",
												() => dismissFailure({ operationId: failure.id })
											)
										}
									/>
									<OpenInConvex
										iconOnly
										label={`Open ${operationLabel(failure.type, true)} operation in Convex`}
										table="box_operations"
										value={failure.id}
									/>
								</div>
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}
