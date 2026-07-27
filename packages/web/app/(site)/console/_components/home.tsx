"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";
import { AlertDelivery } from "./alert-delivery";
import { Capacity, CertificateBudget } from "./capacity";
import { CheckoutLimit } from "./checkout-limit";
import { Failures } from "./failures";
import { GrantBox } from "./grant-box";
import { Metrics } from "./metrics";
import { SnapshotPolicy } from "./snapshot-policy";
import { Stats } from "./stats";
import { Thresholds } from "./thresholds";
import { FlagsTable } from "@/components/box/flags-table";
import { DismissButton } from "@/components/dismiss-button";
import { OpenInConvex, OpenInHetzner, OpenInPolar } from "@/components/open-in";
import { SortHeader } from "@/components/sort-header";
import { StatusText } from "@/components/box/status-text";
import { AnimatedIconButton } from "@/components/animated-icon";
import { Input } from "@/components/base/input";
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
import { useBusyAction } from "@/hooks/use-busy-action";
import { useTableSort } from "@/hooks/use-table-sort";
import { formatDate, formatDateTime } from "@/lib/datetime";
import { consoleBoxPath } from "@/convex/model/box/path";

type ConsoleBox = NonNullable<
	ReturnType<typeof useQuery<typeof api.staff.boxes.search>>
>[number];

type CheckoutIntent = NonNullable<
	ReturnType<typeof useQuery<typeof api.staff.checkout.activeCheckoutIntents>>
>[number];

const CONSOLE_BOX_SORT = {
	slug: (box: ConsoleBox) => box.slug,
	user: (box: ConsoleBox) => box.userEmail || box.userId,
	createdAt: (box: ConsoleBox) => box.createdAt,
	status: (box: ConsoleBox) => box.status
};

const INTENT_SORT = {
	slug: (intent: CheckoutIntent) => intent.slug,
	user: (intent: CheckoutIntent) => intent.userEmail || intent.userId,
	status: (intent: CheckoutIntent) => intent.polarCheckoutStatus ?? "active",
	createdAt: (intent: CheckoutIntent) => intent.createdAt,
	expiresAt: (intent: CheckoutIntent) => intent.expiresAt ?? 0
};

export function ConsoleHome() {
	const [query, setQuery] = useState("");
	const boxes = useQuery(api.staff.boxes.search, { query });
	const intents = useQuery(api.staff.checkout.activeCheckoutIntents, {
		query
	});
	const settings = useQuery(api.staff.settings.get);
	const flags = useQuery(api.staff.metrics.flags, {});
	const setCheckoutEnabled = useMutation(api.staff.settings.setCheckoutEnabled);
	const setAutoSuspendEnabled = useMutation(
		api.staff.settings.setAutoSuspendEnabled
	);
	const releaseIntent = useMutation(api.staff.checkout.releaseCheckoutIntent);
	const { run } = useBusyAction();
	const { sort: boxSort, sortedRows: sortedBoxes } = useTableSort(
		boxes ?? [],
		CONSOLE_BOX_SORT
	);
	const { sort: intentSort, sortedRows: sortedIntents } = useTableSort(
		intents ?? [],
		INTENT_SORT
	);

	return (
		<div className="space-y-6">
			<Stats />

			<Failures />
			<AlertDelivery />

			<div className="space-y-3">
				<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<Input
						className="sm:max-w-sm"
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search ID, slug, user, subscription"
						value={query}
					/>
					<div className="grid grid-cols-2 gap-2 sm:flex">
						<AnimatedIconButton
							disabled={settings === undefined}
							icon="credit-card"
							iconPosition="start"
							onClick={() =>
								run("toggle", "Checkout updated", () =>
									setCheckoutEnabled({
										enabled: !(settings?.checkoutEnabled ?? true)
									})
								)
							}
							variant="outline"
						>
							{settings?.checkoutEnabled === false
								? "Enable checkout"
								: "Disable checkout"}
						</AnimatedIconButton>
						<AnimatedIconButton
							disabled={settings === undefined}
							icon="construction"
							iconPosition="start"
							onClick={() =>
								run("toggle-auto-suspend", "Auto-suspend updated", () =>
									setAutoSuspendEnabled({
										enabled: !(settings?.autoSuspendEnabled ?? false)
									})
								)
							}
							variant="outline"
						>
							{settings?.autoSuspendEnabled
								? "Disable auto-suspend"
								: "Enable auto-suspend"}
						</AnimatedIconButton>
					</div>
				</div>

				<div className="overflow-hidden rounded-2xl bg-card">
					<Table cols={["fluid", "text", "date", "status", "actions-3"]}>
						<TableHeader>
							<TableRow>
								<TableHead className="pl-4">
									<SortHeader label="Box" sort={boxSort} sortKey="slug" />
								</TableHead>
								<TableHead>
									<SortHeader label="User" sort={boxSort} sortKey="user" />
								</TableHead>
								<TableHead>
									<SortHeader
										label="Created"
										sort={boxSort}
										sortKey="createdAt"
									/>
								</TableHead>
								<TableHead>
									<SortHeader label="Status" sort={boxSort} sortKey="status" />
								</TableHead>
								<TableHead className="pr-4 text-right">
									<div className="flex items-center justify-end gap-1">
										<OpenInHetzner iconOnly label="Open servers in Hetzner" />
										<OpenInPolar iconOnly label="Open customers in Polar" />
										<OpenInConvex iconOnly table="boxes" />
									</div>
								</TableHead>
							</TableRow>
						</TableHeader>
						{boxes === undefined ? (
							<TableBody>
								<TableLoadingRow />
							</TableBody>
						) : boxes.length > 0 ? (
							<TableBody className="page-fade-in">
								{sortedBoxes.map((box: ConsoleBox) => (
									<TableRow
										className="h-14 has-[[data-link]:hover]:bg-hover"
										key={box.id}
									>
										{/* The link is an overlay so it fills the whole cell (height
										    100% does not resolve inside a td), which is what makes the
										    row hover and click as one. A stacked row has no cell to
										    fill and takes its height from its contents, so below sm the
										    link goes back into the flow. */}
										<TableCell className="relative p-0">
											<Link
												className="absolute inset-0 flex flex-col justify-center pl-4 max-sm:static max-sm:pl-0"
												data-link
												href={consoleBoxPath(box.id)}
											>
												<span className="truncate font-medium text-foreground">
													{box.slug}
												</span>
												<span className="truncate text-xs text-muted-foreground">
													{box.id}
												</span>
											</Link>
										</TableCell>
										<TableCell>{box.userEmail || box.userId}</TableCell>
										<TableCell>{formatDate(box.createdAt)}</TableCell>
										<TableCell>
											<StatusText kind="box" status={box.status} />
										</TableCell>
										<TableCell className="pr-4">
											<div className="flex items-center justify-end gap-1">
												<OpenInHetzner
													iconOnly
													label={`Open ${box.slug} server in Hetzner`}
													serverId={box.hetznerServerId ?? null}
												/>
												<OpenInPolar
													iconOnly
													label={`Open ${box.slug} subscription in Polar`}
													subscriptionId={box.polarSubscriptionId}
												/>
												<OpenInConvex
													iconOnly
													label={`Open ${box.slug} in Convex`}
													table="boxes"
													value={box.id}
												/>
											</div>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						) : (
							<TableBody>
								<TableEmptyRow>No boxes found.</TableEmptyRow>
							</TableBody>
						)}
					</Table>
				</div>
			</div>

			<div className="grid gap-3">
				{settings ? (
					<Capacity
						capacity={settings.capacity}
						serverLimit={settings.hetznerServerLimit}
						snapshotLimit={settings.hetznerSnapshotLimit}
					/>
				) : null}
				{settings ? (
					<CertificateBudget
						capacity={settings.capacity}
						weeklyLimit={settings.certificateWeeklyLimit}
					/>
				) : null}
				<GrantBox />
				<CheckoutLimit max={settings?.maxActiveCheckoutIntentsPerUser} />
				<Thresholds thresholds={settings?.thresholds} />
				<SnapshotPolicy policy={settings?.snapshotPolicy} />
				{/* The only record that a threshold, policy or reservation limit was
				    changed at all: unlike the checkout and capacity toggles, those
				    raise no alert. */}
				{settings?.updatedBy && settings.updatedAt ? (
					<p className="px-1 text-xs text-muted-foreground">
						Settings last changed by {settings.updatedBy} on{" "}
						{formatDateTime(settings.updatedAt)}.
					</p>
				) : null}
			</div>

			<div className="overflow-hidden rounded-2xl bg-card">
				<Table
					cols={["fluid", "text", "date", "datetime", "status", "actions-2"]}
				>
					<TableHeader>
						<TableRow>
							<TableHead className="pl-4">
								<SortHeader label="Intent" sort={intentSort} sortKey="slug" />
							</TableHead>
							<TableHead>
								<SortHeader label="User" sort={intentSort} sortKey="user" />
							</TableHead>
							<TableHead>
								<SortHeader
									label="Created"
									sort={intentSort}
									sortKey="createdAt"
								/>
							</TableHead>
							<TableHead>
								<SortHeader
									label="Expires"
									sort={intentSort}
									sortKey="expiresAt"
								/>
							</TableHead>
							<TableHead>
								<SortHeader label="Status" sort={intentSort} sortKey="status" />
							</TableHead>
							<TableHead className="pr-4 text-right">
								<OpenInConvex iconOnly table="box_checkout_intents" />
							</TableHead>
						</TableRow>
					</TableHeader>
					{intents === undefined ? (
						<TableBody>
							<TableLoadingRow />
						</TableBody>
					) : intents.length > 0 ? (
						<TableBody className="page-fade-in">
							{sortedIntents.map((intent: CheckoutIntent) => (
								<TableRow key={intent.id}>
									<TableCell className="pl-4">
										<div className="min-w-0">
											<span className="block truncate font-medium text-foreground">
												{intent.slug}
											</span>
											<span className="block truncate text-muted-foreground">
												{intent.polarCheckoutId ?? intent.id}
											</span>
										</div>
									</TableCell>
									<TableCell>{intent.userEmail || intent.userId}</TableCell>
									<TableCell>{formatDate(intent.createdAt)}</TableCell>
									<TableCell>{formatDateTime(intent.expiresAt)}</TableCell>
									<TableCell>
										<StatusText
											kind="foreign"
											status={intent.polarCheckoutStatus ?? "active"}
										/>
									</TableCell>
									<TableCell className="pr-4">
										<div className="flex items-center justify-end gap-1">
											<DismissButton
												iconOnly
												onClick={() =>
													run("release", "Checkout released", () =>
														releaseIntent({
															intentId: intent.id,
															reason: "staff_release"
														})
													)
												}
											>
												Release
											</DismissButton>
											<OpenInConvex
												iconOnly
												label={`Open ${intent.slug} intent in Convex`}
												table="box_checkout_intents"
												value={intent.id}
											/>
										</div>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					) : (
						<TableBody>
							<TableEmptyRow>No active checkout intents.</TableEmptyRow>
						</TableBody>
					)}
				</Table>
			</div>

			<Metrics />

			<FlagsTable flags={flags} showBox />
		</div>
	);
}
