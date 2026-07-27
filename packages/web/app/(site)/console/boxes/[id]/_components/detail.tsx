"use client";

import {
	useAction,
	useMutation,
	usePaginatedQuery,
	useQuery
} from "convex/react";
import { useState, type ReactNode } from "react";
import { AnimatedIconButton } from "@/components/animated-icon";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { BoxStatusAction } from "@/components/box/status-action";
import { ChangeSlugDialog } from "@/components/box/change-slug-dialog";
import { FlagsTable } from "@/components/box/flags-table";
import { MonitorCard } from "@/components/box/monitor-card";
import { OpenInConvex, OpenInHetzner, OpenInPolar } from "@/components/open-in";
import { RepairDialog } from "@/components/box/repair-dialog";
import { ResetDialog } from "@/components/box/reset-dialog";
import { SortHeader } from "@/components/sort-header";
import { StatusText } from "@/components/box/status-text";
import {
	boxEventLabel,
	failureNotice,
	operationLabel
} from "@/convex/model/box/operation";
import { UpdateDialog } from "@/components/box/update-dialog";
import { UsageCard } from "@/components/box/usage-card";
import {
	DEFAULT_RANGE,
	type MetricsRange
} from "@/components/box/metrics-chart";
import { BoxSnapshots } from "./snapshots";
import { SuspendDialog } from "./suspend-dialog";
import { Card, CardContent } from "@/components/base/card";
import { Separator } from "@/components/base/separator";
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
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useBusyAction } from "@/hooks/use-busy-action";
import { useTableSort } from "@/hooks/use-table-sort";
import { formatDateTime } from "@/lib/datetime";
import { BOX_PLANS, boxPlanServerType } from "@/convex/model/box/plan";

// The stored rows themselves, not a hand-copied shape of them. Restating the
// columns is what let these drift: the event row typed its `type` as `string`,
// so the audit table would happily render an event name nothing can label.
type OperationRow = Doc<"box_operations">;

type EventRow = Doc<"box_events">;

const AUDIT_PAGE_SIZE = 100;

function operationDetail(operation: OperationRow) {
	if (operation.last_error) return operation.last_error;
	const reason = operation.metadata?.reason;
	return typeof reason === "string" && reason.trim()
		? `Reason: ${reason}`
		: null;
}

// What the two halves of the audit history have in common, which is everything
// except what a row is called and whether it carries a status. They were two
// copies of this table, so the events half kept rendering its raw stored
// identifier long after the operations half had been given words.
type AuditRow = { _id: string; created_at: number };

type AuditPage<Row> = ReturnType<typeof usePaginatedQuery> & {
	results: Row[];
};

function AuditTable<Row extends AuditRow>({
	boxId,
	detail,
	label,
	name,
	page,
	status,
	table,
	title
}: {
	boxId: Id<"boxes">;
	// The second line under the name, where a row has one.
	detail: (row: Row) => string | null;
	// What one row is called, in words.
	label: (row: Row) => string;
	// What the whole list is called - the column header, and the plural in the
	// "show more" button, so those two cannot disagree.
	name: string;
	page: AuditPage<Row>;
	// The status cell, for the half that has one.
	status?: (row: Row) => ReactNode;
	table: string;
	title: string;
}) {
	const accessors = {
		type: (row: Row) => label(row),
		created_at: (row: Row) => row.created_at
	};
	const { sort, sortedRows } = useTableSort(page.results, accessors);

	return (
		<>
			<div className="overflow-hidden rounded-2xl bg-card">
				<Table
					cols={
						status
							? ["fluid", "datetime", "status", "actions-1"]
							: ["fluid", "datetime", "actions-1"]
					}
				>
					<TableHeader>
						<TableRow>
							<TableHead className="pl-4">
								<SortHeader label={title} sort={sort} sortKey="type" />
							</TableHead>
							<TableHead>
								<SortHeader label="Created" sort={sort} sortKey="created_at" />
							</TableHead>
							{status ? <TableHead>Status</TableHead> : null}
							<TableHead className="pr-4 text-right">
								<OpenInConvex
									iconOnly
									field="box_id"
									table={table}
									value={boxId}
								/>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{page.status === "LoadingFirstPage" ? (
							<TableLoadingRow />
						) : sortedRows.length > 0 ? (
							sortedRows.map((row) => {
								const second = detail(row);
								return (
									<TableRow
										className={second ? "[&>td]:align-top" : undefined}
										key={row._id}
									>
										<TableCell className="pl-4">
											<div className="min-w-0">
												<p className="font-medium wrap-break-word text-foreground">
													{label(row)}
												</p>
												{second ? (
													<p className="wrap-break-word whitespace-normal text-muted-foreground">
														{second}
													</p>
												) : null}
											</div>
										</TableCell>
										<TableCell>{formatDateTime(row.created_at)}</TableCell>
										{status ? <TableCell>{status(row)}</TableCell> : null}
										<TableCell className="pr-4 text-right">
											<OpenInConvex
												iconOnly
												label={`Open ${label(row).toLowerCase()} in Convex`}
												table={table}
												value={row._id}
											/>
										</TableCell>
									</TableRow>
								);
							})
						) : (
							<TableEmptyRow>{`No ${name}.`}</TableEmptyRow>
						)}
					</TableBody>
				</Table>
			</div>
			{page.status === "CanLoadMore" || page.status === "LoadingMore" ? (
				<div className="flex justify-center">
					<AnimatedIconButton
						disabled={page.status === "LoadingMore"}
						icon="plus"
						iconPosition="start"
						onClick={() => page.loadMore(AUDIT_PAGE_SIZE)}
						variant="outline"
					>
						{page.status === "LoadingMore" ? "Loading…" : `Show more ${name}`}
					</AnimatedIconButton>
				</div>
			) : null}
		</>
	);
}

function BoxAuditHistory({ boxId }: { boxId: Id<"boxes"> }) {
	const operations = usePaginatedQuery(
		api.staff.boxes.auditOperations,
		{ boxId },
		{ initialNumItems: AUDIT_PAGE_SIZE }
	);
	const events = usePaginatedQuery(
		api.staff.boxes.auditEvents,
		{ boxId },
		{ initialNumItems: AUDIT_PAGE_SIZE }
	);

	return (
		<>
			<AuditTable<OperationRow>
				boxId={boxId}
				detail={operationDetail}
				label={(operation) => operationLabel(operation.type)}
				name="operations"
				page={operations as AuditPage<OperationRow>}
				status={(operation) => (
					<StatusText kind="operation" status={operation.status} />
				)}
				table="box_operations"
				title="Operation"
			/>
			<AuditTable<EventRow>
				boxId={boxId}
				detail={(event) => event.message ?? null}
				label={(event) => boxEventLabel(event.type)}
				name="events"
				page={events as AuditPage<EventRow>}
				table="box_events"
				title="Event"
			/>
		</>
	);
}

export function BoxDetail({ boxId }: { boxId: string }) {
	const [range, setRange] = useState<MetricsRange>(DEFAULT_RANGE);
	const detail = useQuery(api.staff.boxes.getById, { boxId });
	const metricsSeries = useQuery(
		api.staff.metrics.series,
		detail ? { boxId: detail.box.id, range } : "skip"
	);
	const flags = useQuery(
		api.staff.metrics.flags,
		detail ? { boxId: detail.box.id } : "skip"
	);
	const retryCreate = useMutation(api.staff.boxes.retryCreate);
	const revokeComp = useMutation(api.staff.boxes.revokeComp);
	const resetBox = useMutation(api.staff.boxes.reset);
	const stopBox = useMutation(api.staff.boxes.stop);
	const startBox = useMutation(api.staff.boxes.start);
	const changeSlug = useMutation(api.staff.boxes.changeSlug);
	const suspendBox = useAction(api.staff.boxes.suspend);
	const unsuspendBox = useAction(api.staff.boxes.unsuspend);
	const repair = useAction(api.staff.boxes.repair);
	const updateBox = useAction(api.staff.boxes.update);
	const recoveryStatus = useAction(api.staff.boxes.recoveryStatus);
	const cancelOperation = useAction(api.staff.boxes.cancelOperation);
	const runtimeLogs = useAction(api.staff.boxes.runtimeLogs);
	const setUserSuspended = useAction(api.staff.users.setUserSuspended);
	const { busy, run } = useBusyAction();
	if (detail === undefined) return null;

	if (!detail) {
		return (
			<Card className="page-fade-in">
				<CardContent>
					<p className="text-sm text-muted-foreground">Box not found.</p>
				</CardContent>
			</Card>
		);
	}

	const { box, user, subscription } = detail;
	const boxTransitioning =
		box.status === "suspending" || box.status === "unsuspending";

	const fields: Array<
		[string, string | number | null | undefined, ReactNode?]
	> = [
		["Box ID", box.id],
		["Slug", box.slug],
		["Created", formatDateTime(box.createdAt)],
		...(detail.suspendedReason
			? ([["Suspension reason", detail.suspendedReason]] as Array<
					[string, string | number | null | undefined, ReactNode?]
				>)
			: []),
		...(box.status === "deleted"
			? ([
					["Deleted", formatDateTime(box.deletedAt)],
					["Purges at", formatDateTime(box.purgeAt)]
				] as Array<[string, string | number | null | undefined, ReactNode?]>)
			: []),
		[
			"User",
			user?.email ?? box.userId,
			user ? (
				<OpenInConvex
					className="-my-1"
					field="clerk_user_id"
					iconOnly
					key="user"
					table="users"
					value={user.clerkUserId}
				/>
			) : undefined
		],
		[
			"Subscription",
			box.polarSubscriptionId,
			<OpenInPolar
				className="-my-1"
				iconOnly
				key="subscription"
				subscriptionId={box.polarSubscriptionId}
			/>
		],
		["Subscription status", subscription?.status ?? "none"],
		["Current period end", formatDateTime(subscription?.currentPeriodEnd)],
		[
			"Cancel at period end",
			subscription ? String(subscription.cancelAtPeriodEnd) : "none"
		],
		[
			"Customer",
			box.polarCustomerId,
			<OpenInPolar
				className="-my-1"
				customerId={box.polarCustomerId}
				iconOnly
				key="customer"
			/>
		],
		...(box.comp
			? ([
					["Comped by", box.compedBy ?? ""],
					["Comp reason", box.compReason ?? ""]
				] as Array<[string, string | number | null | undefined, ReactNode?]>)
			: []),
		...(box.status !== "deleted"
			? ([
					[
						"Server",
						box.hetznerServerId ?? "",
						<OpenInHetzner
							className="-my-1"
							iconOnly
							key="server"
							serverId={box.hetznerServerId ?? null}
						/>
					],
					[
						// The plan and the machine it should be on, side by side: a box
						// whose provisioning failed part-way is where the two differ, and
						// nothing moves a box between plans to explain it away.
						"Plan",
						`${BOX_PLANS[box.plan].label} (${boxPlanServerType(box.plan)})`
					],
					[
						"Placement",
						[box.hetznerServerType, box.hetznerLocation]
							.filter(Boolean)
							.join(" / ")
					],
					["IPv4", box.hetznerIpv4 ?? ""],
					["IPv6", box.hetznerIpv6 ?? ""],
					["DNS A", box.dnsRecordId ?? ""],
					["DNS AAAA", box.dnsRecordAaaaId ?? ""]
				] as Array<[string, string | number | null | undefined, ReactNode?]>)
			: [])
	];

	const suspendTargets = [
		...(box.status === "suspended" || boxTransitioning
			? []
			: [
					{
						label: "Box",
						description: "Stops the box and interrupts anything running in it.",
						onConfirm: (reason: string) =>
							run("suspend", "Suspending box", () =>
								suspendBox({ boxId: box.id, reason })
							)
					}
				]),
		...(user && !user.suspended
			? [
					{
						label: "User",
						description: "Suspends the account and every box it owns.",
						onConfirm: (reason: string) =>
							run("suspend", "Suspending user", () =>
								setUserSuspended({
									clerkUserId: user.clerkUserId,
									suspended: true,
									reason
								})
							)
					}
				]
			: [])
	];

	return (
		<div className="page-fade-in space-y-4">
			<Card>
				<CardContent className="space-y-6">
					<dl className="grid gap-4 text-sm sm:grid-cols-2">
						{fields.map(([label, value, action]) => (
							<div className="min-w-0 space-y-1.5" key={label}>
								<dt className="text-muted-foreground">{label}</dt>
								<dd className="flex items-center gap-1 font-medium text-foreground">
									<span className="min-w-0 break-all">{value || "none"}</span>
									{action}
								</dd>
							</div>
						))}
					</dl>

					{box.status !== "deleted" ? (
						<>
							<Separator />

							<div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
								<BoxStatusAction
									retry={{
										disabled: busy === "create",
										onClick: () =>
											run("create", "Creating box", () =>
												retryCreate({ boxId: box.id })
											)
									}}
									start={{
										disabled: busy === "start",
										onClick: () =>
											run("start", "Starting box", () =>
												startBox({ boxId: box.id })
											)
									}}
									status={box.status}
									stop={{
										onConfirm: () =>
											run("stop", "Stopping box", () =>
												stopBox({ boxId: box.id })
											)
									}}
									unsuspend={{
										// When the owner's whole account is suspended, this box-only
										// unsuspend would just power on a box they still can't reach;
										// "Unsuspend user" below is the right control there.
										disabled: busy === "unsuspend" || user?.suspended,
										onClick: () =>
											run("unsuspend", "Unsuspending box", () =>
												unsuspendBox({ boxId: box.id })
											)
									}}
								/>
								<ChangeSlugDialog
									onSubmit={(newSlug) => changeSlug({ boxId: box.id, newSlug })}
									slug={box.slug}
								/>
								{user?.suspended ? (
									<AnimatedIconButton
										disabled={busy === "unsuspend-user"}
										icon="play"
										iconPosition="start"
										onClick={() =>
											run("unsuspend-user", "Unsuspending user", () =>
												setUserSuspended({
													clerkUserId: user.clerkUserId,
													suspended: false
												})
											)
										}
										variant="outline"
									>
										Unsuspend user
									</AnimatedIconButton>
								) : null}
								{suspendTargets.length > 0 ? (
									<SuspendDialog targets={suspendTargets}>
										{(open) => (
											<AnimatedIconButton
												disabled={busy === "suspend"}
												icon="construction"
												iconPosition="start"
												onClick={open}
												variant="outline"
											>
												Suspend
											</AnimatedIconButton>
										)}
									</SuspendDialog>
								) : null}
								{box.comp ? (
									<AnimatedIconButton
										disabled={busy === "revoke-comp"}
										icon="delete"
										iconPosition="start"
										onClick={() =>
											run("revoke-comp", "Comp revoked", () =>
												revokeComp({ boxId: box.id })
											)
										}
										variant="outline"
									>
										Revoke comp
									</AnimatedIconButton>
								) : null}
								{/* Only while an operation actually holds the box's lock. It is the
							    documented way out of a wedged operation - the alert about one
							    points here - and before it existed the only way to free the box
							    was editing its row in the Convex dashboard. */}
								{detail.activeOperation ? (
									<ConfirmDialog
										confirmLabel="Cancel operation"
										description={`Stops the ${operationLabel(detail.activeOperation.type, true)} operation and records it as failed, which frees the box for other actions. Only do this once you have established it is wedged rather than working - cancelling a repair part-way leaves its files on the parking volume for the next repair to resume from.`}
										destructive
										onConfirm={() =>
											run("cancel", "Cancelling operation", () =>
												cancelOperation({ boxId: box.id })
											)
										}
										title="Cancel operation"
									>
										{(openConfirm) => (
											<AnimatedIconButton
												disabled={busy === "cancel"}
												icon="x"
												iconPosition="start"
												onClick={openConfirm}
												variant="destructive"
											>
												Cancel operation
											</AnimatedIconButton>
										)}
									</ConfirmDialog>
								) : null}
								<BoxSnapshots
									boxId={box.id}
									plan={box.plan}
									split={box.snapshots}
									status={box.status}
								/>
								<UpdateDialog
									boxStatus={box.status}
									busy={busy}
									onUpdate={() =>
										run("update", "Updating box", () =>
											updateBox({ boxId: box.id })
										)
									}
									runtime={detail.runtime}
									slug={box.slug}
									update={detail.update}
								/>
								<RepairDialog
									boxStatus={box.status}
									busy={busy}
									check={() => recoveryStatus({ boxId: box.id })}
									onRepair={() =>
										run("repair", "Repairing box", () =>
											repair({ boxId: box.id })
										)
									}
									repair={detail.repair}
									slug={box.slug}
								/>
								<ResetDialog
									busy={busy}
									onReset={() =>
										run("reset", "Resetting box", () =>
											resetBox({ boxId: box.id })
										)
									}
									slug={box.slug}
								/>
							</div>
						</>
					) : null}
				</CardContent>
			</Card>

			{box.status !== "deleted" ? (
				<MonitorCard
					className="h-112"
					failure={failureNotice(detail.failure, "staff")}
					loadLogs={() => runtimeLogs({ boxId: box.id })}
					note={detail.suspendedReason ?? undefined}
					onRangeChange={setRange}
					range={range}
					series={metricsSeries}
					status={box.status}
				/>
			) : null}

			<UsageCard readings={detail.usage} />

			<FlagsTable boxId={box.id} flags={flags} />

			<BoxAuditHistory boxId={box.id} />
		</div>
	);
}
