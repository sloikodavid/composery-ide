"use client";

import { useQuery } from "convex/react";
import { useState } from "react";
import {
	DEFAULT_METRIC,
	DEFAULT_RANGE,
	MetricSelect,
	MetricsLineChart,
	MetricsRangeSelect,
	type MetricsRange
} from "@/components/box/metrics-chart";
import { ChartCard } from "@/components/box/chart-card";
import { api } from "@/convex/_generated/api";

// The all-boxes overlay: the top boxes ranked by the selected metric's latest
// rolled-up hour, so a fleet of any size stays readable.
export function Metrics() {
	const [metricKey, setMetricKey] = useState(DEFAULT_METRIC);
	const [range, setRange] = useState<MetricsRange>(DEFAULT_RANGE);
	const series = useQuery(api.staff.metrics.series, {
		metric: metricKey,
		range
	});

	return (
		<ChartCard
			controls={
				<>
					<MetricSelect onChange={setMetricKey} value={metricKey} />
					<MetricsRangeSelect onChange={setRange} value={range} />
				</>
			}
		>
			<MetricsLineChart
				className="h-78"
				metricKey={metricKey}
				range={range}
				series={series}
			/>
		</ChartCard>
	);
}
