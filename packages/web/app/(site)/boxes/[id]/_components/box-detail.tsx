"use client";

import { useAction, useQuery } from "convex/react";
import { EllipsisIcon } from "lucide-react";
import { useState } from "react";
import { AnimatedIconButton } from "@/components/animated-icon";
import { BoxStatusAction } from "@/components/box/status-action";
import { MonitorCard } from "@/components/box/monitor-card";
import { AgentStack } from "@/components/box/agent-stack";
import { BoxActionsMenu } from "@/components/box/actions-menu";
import { SshDialog } from "@/components/box/ssh-dialog";
import { UsageCard } from "@/components/box/usage-card";
import { UpdateDialog } from "@/components/box/update-dialog";
import {
	DEFAULT_RANGE,
	type MetricsRange
} from "@/components/box/metrics-chart";
import { Card, CardContent } from "@/components/base/card";
import { Button } from "@/components/base/button";
import { api } from "@/convex/_generated/api";
import { useBoxActions } from "@/hooks/use-box-actions";
import { billingLabel } from "@/lib/box/billing";
import type { BoxDetail as BoxDetailData } from "@/lib/box/detail";
import { failureNotice } from "@/convex/model/box/operation";

export function BoxDetail({ boxId }: { boxId: string }) {
	const [range, setRange] = useState<MetricsRange>(DEFAULT_RANGE);
	const detail = useQuery(api.owner.boxes.getById, { boxId });
	const metricsSeries = useQuery(
		api.owner.boxes.metricsSeries,
		detail ? { slug: detail.box.slug, range } : "skip"
	);
	const runtimeLogs = useAction(api.owner.boxes.runtimeLogs);

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

	const { box } = detail;

	return (
		// 10rem + 1px is the page chrome above and below this column (header
		// incl. its border, main padding, breadcrumb row, gaps), so the card
		// fills the rest of the viewport without making the page scroll.
		<div className="page-fade-in flex h-[calc(100dvh-10rem-1px)] min-h-112 flex-col gap-4">
			<MonitorCard
				className="min-h-0 flex-1"
				failure={failureNotice(detail.failure, "owner")}
				loadLogs={() => runtimeLogs({ slug: box.slug })}
				note={detail.suspendedReason ?? undefined}
				onRangeChange={setRange}
				range={range}
				series={metricsSeries}
				status={box.status}
			/>

			<UsageCard readings={detail.usage} />

			<Actions detail={detail} />
		</div>
	);
}

// Every action lives in this one row: what an owner reaches for on the left - the
// status action, connecting, updating - and the plan and everything else on the
// right. Its own component because binding the actions needs a box, and the page
// above it may not have one yet.
function Actions({ detail }: { detail: BoxDetailData }) {
	const [sshOpen, setSshOpen] = useState(false);
	const actions = useBoxActions(detail.box.slug);
	const { box } = detail;
	const { busy } = actions;

	return (
		<div className="flex flex-wrap items-center justify-between gap-2">
			<div className="flex flex-wrap items-center gap-2">
				<BoxStatusAction
					retry={{
						disabled: busy === "create",
						onClick: () => void actions.retryCreate()
					}}
					start={{
						disabled: busy === "start",
						onClick: () => void actions.start()
					}}
					status={box.status}
					stop={{ onConfirm: () => void actions.stop() }}
				/>
				<Button
					disabled={box.status !== "running"}
					onClick={() => setSshOpen(true)}
					variant="outline"
				>
					<AgentStack />
					Connect remotely
				</Button>
				<UpdateDialog
					boxStatus={box.status}
					busy={busy}
					onUpdate={actions.update}
					runtime={detail.runtime}
					slug={box.slug}
					update={detail.update}
				/>
			</div>

			<div className="flex flex-wrap items-center gap-2">
				{/* A comped box has no subscription to manage, so the same button
				    names its plan and refuses to be pressed. */}
				<AnimatedIconButton
					disabled={box.comp || busy === "portal"}
					icon="credit-card"
					iconPosition="start"
					onClick={() => void actions.openBilling()}
					variant="outline"
				>
					{billingLabel(box, detail.subscription)}
				</AnimatedIconButton>
				<BoxActionsMenu
					actions={actions}
					box={box}
					detail={detail}
					trigger={
						<Button variant="outline">
							<EllipsisIcon />
							More
						</Button>
					}
				/>
			</div>

			<SshDialog
				host={new URL(box.runtimeUrl).host}
				onOpenChange={setSshOpen}
				open={sshOpen}
				slug={box.slug}
			/>
		</div>
	);
}
