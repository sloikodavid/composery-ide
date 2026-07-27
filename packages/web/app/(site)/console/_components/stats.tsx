"use client";

import { useQuery } from "convex/react";
import { LoaderIcon } from "lucide-react";
import { useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
	type ChartConfig
} from "@/components/base/chart";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue
} from "@/components/base/select";
import { ChartCard } from "@/components/box/chart-card";
import { api } from "@/convex/_generated/api";
import { formatDate } from "@/lib/datetime";

type Overview = NonNullable<
	ReturnType<typeof useQuery<typeof api.staff.stats.overview>>
>;

type StatsRange = "7d" | "30d" | "90d";

const DEFAULT_STATS_RANGE: StatsRange = "30d";

const RANGE_ITEMS: Record<StatsRange, string> = {
	"7d": "7 days",
	"30d": "30 days",
	"90d": "90 days"
};

const TREND_CONFIG: ChartConfig = {
	signups: { label: "Signups", color: "var(--chart-1)" },
	boxes: { label: "Boxes", color: "var(--chart-2)" }
};

// Every tile is the same three fixed-height lines - label, value, hint - so
// tiles stay uniform whether or not they carry a hint and never resize when the
// value resolves. The value swaps a spinner for the number in place, matching
// the fixed-height loading the data tables use (no skeleton rectangles).
function Tile({
	hint,
	label,
	value
}: {
	hint?: string;
	label: string;
	value?: string;
}) {
	return (
		<div className="rounded-2xl bg-card p-4">
			<p className="text-sm text-muted-foreground">{label}</p>
			<div className="mt-1 flex h-8 items-center">
				{value === undefined ? (
					<LoaderIcon className="size-5 animate-spin text-muted-foreground" />
				) : (
					<span className="text-2xl font-semibold tabular-nums text-foreground">
						{value}
					</span>
				)}
			</div>
			<p className="h-4 text-xs text-muted-foreground">{hint ?? ""}</p>
		</div>
	);
}

function formatCount(value?: number, capped?: boolean) {
	if (value === undefined) return undefined;
	return `${value.toLocaleString()}${capped ? "+" : ""}`;
}

function tiles(data: Overview | undefined, range: StatsRange) {
	return [
		{
			label: "Active boxes",
			value: formatCount(data?.activeBoxes, data?.activeBoxesCapped),
			hint:
				data &&
				`${formatCount(data.runningBoxes, data.runningBoxesCapped)} running`
		},
		{
			label: "Suspended",
			value: formatCount(data?.suspendedBoxes, data?.suspendedBoxesCapped)
		},
		{
			label: "Needs attention",
			value: formatCount(data?.failedBoxes, data?.failedBoxesCapped)
		},
		{
			label: `Signups / ${range}`,
			value: formatCount(data?.windowSignups, data?.windowSignupsCapped)
		},
		{
			label: `New boxes / ${range}`,
			value: formatCount(data?.windowNewBoxes, data?.windowNewBoxesCapped)
		},
		{
			label: `Conversion / ${range}`,
			value:
				data &&
				`${data.conversionRateCapped ? "~" : ""}${Math.round(data.conversionRate * 100)}%`,
			hint:
				data &&
				`${formatCount(data.convertedIntents, data.convertedIntentsCapped)}/${formatCount(data.totalIntents, data.totalIntentsCapped)} checkouts`
		}
	];
}

// Fleet + funnel overview at the top of the console: current state as tiles,
// signups and boxes over the trailing window as a trend.
export function Stats() {
	const [range, setRange] = useState<StatsRange>(DEFAULT_STATS_RANGE);
	const data = useQuery(api.staff.stats.overview, { range });

	return (
		<div className="space-y-3">
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
				{tiles(data, range).map((tile) => (
					<Tile
						hint={tile.hint || undefined}
						key={tile.label}
						label={tile.label}
						value={tile.value || undefined}
					/>
				))}
			</div>

			<ChartCard
				controls={
					<Select
						items={RANGE_ITEMS}
						onValueChange={(next) =>
							setRange((next as StatsRange | undefined) ?? DEFAULT_STATS_RANGE)
						}
						value={range}
					>
						<SelectTrigger className="w-32" variant="secondary">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{Object.entries(RANGE_ITEMS).map(([key, label]) => (
								<SelectItem key={key} value={key}>
									{label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				}
			>
				{data === undefined ? (
					<div className="flex h-56 items-center justify-center">
						<LoaderIcon className="size-5 animate-spin text-muted-foreground" />
					</div>
				) : (
					<ChartContainer className="h-56 w-full" config={TREND_CONFIG}>
						<LineChart
							data={data.series}
							margin={{ left: 0, right: 12, top: 4 }}
						>
							<CartesianGrid vertical={false} />
							<XAxis
								axisLine={false}
								dataKey="at"
								minTickGap={24}
								tickFormatter={(value: number) => formatDate(value)}
								tickLine={false}
								tickMargin={8}
							/>
							<YAxis
								allowDecimals={false}
								axisLine={false}
								tickLine={false}
								width={28}
							/>
							<ChartTooltip
								content={
									<ChartTooltipContent
										labelFormatter={(_, payload) =>
											formatDate(payload?.[0]?.payload?.at)
										}
									/>
								}
							/>
							{Object.keys(TREND_CONFIG).map((key) => (
								<Line
									dataKey={key}
									dot={false}
									isAnimationActive={false}
									key={key}
									stroke={`var(--color-${key})`}
									strokeWidth={1.5}
									type="monotone"
								/>
							))}
						</LineChart>
					</ChartContainer>
				)}
			</ChartCard>
		</div>
	);
}
