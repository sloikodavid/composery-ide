"use client";

import {
	ConstructionIcon,
	LoaderIcon,
	ScrollTextIcon,
	TriangleAlertIcon,
	UnplugIcon
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	DEFAULT_METRIC,
	MetricSelect,
	MetricsLineChart,
	MetricsRangeSelect,
	type MetricsRange,
	type MetricsSeries
} from "@/components/box/metrics-chart";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue
} from "@/components/base/select";
import { type BoxStatus } from "@/convex/model/box/status";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/error-message";
import { highlightLogs } from "@/lib/highlight-logs";
import type { FailureNotice } from "@/convex/model/box/operation";

const REFRESH_INTERVAL = 5000;

type View = "metrics" | "logs";

const VIEW_ITEMS: Record<View, string> = {
	metrics: "Metrics",
	logs: "Logs"
};

function Message({
	detail,
	icon: Icon,
	iconClassName,
	title
}: {
	detail?: string;
	icon: LucideIcon;
	iconClassName: string;
	title: string;
}) {
	return (
		<div className="flex h-full items-center justify-center p-6">
			<div className="flex max-w-sm flex-col items-center gap-1.5 text-center text-sm">
				<Icon className={cn("mb-0.5 size-5", iconClassName)} />
				<p className="text-foreground">{title}</p>
				{detail ? <p className="text-muted-foreground">{detail}</p> : null}
			</div>
		</div>
	);
}

function notRunningMessage(
	status: BoxStatus,
	note?: string,
	failure?: FailureNotice | null
) {
	if (status === "suspended" || status === "suspending") {
		return {
			icon: ConstructionIcon,
			iconClassName: "text-warning",
			title: "This box has been suspended.",
			detail: note ? `"${note}"` : undefined
		};
	}
	if (status === "stopped") {
		return {
			icon: UnplugIcon,
			iconClassName: "text-destructive",
			title: "This box is stopped.",
			detail: "Start it to see its metrics and logs."
		};
	}
	// A box sitting in a `*_failed` status used to fall through to the neutral
	// sentence below, so the largest thing on the page said "metrics will appear
	// when the box is running" while the actual reason it was not running sat
	// unread inside a dialog. Say what happened instead.
	if (failure) {
		return {
			icon: TriangleAlertIcon,
			iconClassName: "text-destructive",
			title: failure.title,
			detail: failure.detail
		};
	}
	return {
		icon: ScrollTextIcon,
		iconClassName: "text-muted-foreground",
		title: "Metrics and logs will appear here when the box is running."
	};
}

// The last operation on this box, if it failed and the viewer can act on it. A
// box whose slug change or configuration apply failed keeps running, so that
// failure has no status to show up in - the strip at the foot of the card is the
// only thing that reports it at all.
function FailureStrip({ notice }: { notice: FailureNotice }) {
	return (
		<div className="flex items-start gap-3 bg-destructive/5 px-4 py-2.5 text-xs">
			<TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
			<div className="min-w-0 flex-1">
				<p className="font-medium text-foreground">{notice.title}</p>
				<p className="wrap-break-word text-muted-foreground">{notice.detail}</p>
				{notice.hint ? (
					<p className="mt-0.5 text-muted-foreground">{notice.hint}</p>
				) : null}
			</div>
		</div>
	);
}

export function MonitorCard({
	className,
	failure,
	loadLogs,
	note,
	onRangeChange,
	range,
	series,
	status
}: {
	className?: string;
	failure?: FailureNotice | null;
	loadLogs: () => Promise<{ logs: string | null }>;
	note?: string;
	onRangeChange: (range: MetricsRange) => void;
	range: MetricsRange;
	series?: MetricsSeries[];
	status: BoxStatus;
}) {
	const [choice, setChoice] = useState<View | null>(null);
	const [metricKey, setMetricKey] = useState(DEFAULT_METRIC);
	const [html, setHtml] = useState<string | null>(null);
	const [unavailable, setUnavailable] = useState(false);
	const [wasRunning, setWasRunning] = useState(false);
	const inFlight = useRef(false);
	const viewport = useRef<HTMLDivElement>(null);
	const running = status === "running";
	const view = choice ?? "metrics";

	if (wasRunning !== running) {
		setWasRunning(running);
		setChoice(null);
		if (!running) {
			setHtml(null);
			setUnavailable(false);
		}
	}

	const refresh = useCallback(async () => {
		if (inFlight.current) return;
		inFlight.current = true;
		try {
			const result = await loadLogs();
			if (result.logs === null) {
				setUnavailable(true);
				return;
			}
			setUnavailable(false);
			setHtml(await highlightLogs(result.logs.trimEnd() || "No output yet."));
		} catch (cause) {
			setUnavailable(false);
			setHtml(await highlightLogs(errorMessage(cause)));
		} finally {
			inFlight.current = false;
		}
	}, [loadLogs]);

	useEffect(() => {
		if (!running || view !== "logs") return;

		let timer: ReturnType<typeof setInterval> | undefined;
		function syncPolling() {
			if (document.hidden) {
				clearInterval(timer);
				timer = undefined;
			} else if (!timer) {
				void refresh();
				timer = setInterval(() => void refresh(), REFRESH_INTERVAL);
			}
		}

		syncPolling();
		document.addEventListener("visibilitychange", syncPolling);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", syncPolling);
		};
	}, [running, view, refresh]);

	useEffect(() => {
		const node = viewport.current;
		if (node) node.scrollTop = node.scrollHeight;
	}, [html]);

	return (
		<div
			className={cn(
				"relative flex flex-col overflow-hidden rounded-2xl bg-card",
				className
			)}
		>
			{!running ? (
				<Message {...notRunningMessage(status, note, failure)} />
			) : (
				<>
					<div className="absolute top-3 left-3 z-10 flex gap-2">
						<Select
							items={VIEW_ITEMS}
							onValueChange={(next) => setChoice((next as View) ?? null)}
							value={view}
						>
							<SelectTrigger className="w-28" variant="secondary">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{Object.entries(VIEW_ITEMS).map(([key, label]) => (
									<SelectItem key={key} value={key}>
										{label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						{view === "metrics" ? (
							<MetricSelect
								onChange={setMetricKey}
								triggerVariant="secondary"
								value={metricKey}
							/>
						) : null}
						{view === "metrics" ? (
							<MetricsRangeSelect
								onChange={onRangeChange}
								triggerVariant="secondary"
								value={range}
							/>
						) : null}
					</div>

					{view === "metrics" ? (
						<div className="min-h-0 flex-1 p-4 pt-12">
							<MetricsLineChart
								className="h-full"
								metricKey={metricKey}
								range={range}
								series={series}
							/>
						</div>
					) : (
						<div
							className="min-h-0 flex-1 overflow-auto text-xs leading-relaxed [&_.shiki]:m-0 [&_.shiki]:min-h-full [&_.shiki]:p-4 [&_.shiki]:wrap-break-word [&_.shiki]:whitespace-pre-wrap"
							ref={viewport}
						>
							{html ? (
								<div
									className="page-fade-in"
									// biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki output is escaped.
									dangerouslySetInnerHTML={{ __html: html }}
								/>
							) : unavailable ? (
								<Message
									detail="Retrying every few seconds."
									icon={ScrollTextIcon}
									iconClassName="text-muted-foreground"
									title="Logs are unavailable."
								/>
							) : (
								<div className="flex h-full items-center justify-center">
									<LoaderIcon className="size-5 animate-spin text-muted-foreground" />
								</div>
							)}
						</div>
					)}
					{/* Only on the running path: when the box is not running the failure is
					    already the whole message above, and showing it twice would read as
					    two problems. */}
					{failure ? <FailureStrip notice={failure} /> : null}
				</>
			)}
		</div>
	);
}
