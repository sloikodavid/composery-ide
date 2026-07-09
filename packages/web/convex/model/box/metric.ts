import type { StoredThreshold } from "../../schema";

// What a box's telemetry is called, and the units it is quoted in.
//
// Vocabulary only - no query, no validator, no chart. It sits here because both
// planes read it: `convex/boxes/metrics.ts` builds its validators and its alert
// text from these lists, and the console's chart, thresholds panel and flags
// table draw from the same rows. The three of them each used to keep their own
// copy, so one signal was "outbound bandwidth" in the alert an operator got,
// "Outbound bandwidth" in the panel where they raised the threshold, and
// "Network out" in the table of what it had flagged.
//
// The per-box metrics rolled up hourly and kept for thirty days. Declaration
// order is the order the chart's picker offers them in.
export const ROLLED_METRICS = [
	"cpu_percent",
	"egress_bps",
	"ingress_bps",
	"egress_pps",
	"ingress_pps",
	"disk_read_bps",
	"disk_write_bps"
] as const;

export type RolledMetric = (typeof ROLLED_METRICS)[number];

// The windows a series may be asked for. One list, so the picker cannot offer a
// range the query would reject and the query cannot grow one nothing offers.
export const METRICS_RANGES = ["1h", "6h", "24h", "7d", "30d"] as const;

export type MetricsRange = (typeof METRICS_RANGES)[number];

type FlagSignalDefinition = {
	// Title case, and it reads inside a sentence in lower case - see
	// `flagSignalLabel`. The same rule `operationLabel` follows.
	label: string;
	// The rolled metric the threshold is measured against. Stored values are in
	// this metric's own unit, which is why nothing here quotes a number without
	// going through `formatFlagValue`.
	metric: RolledMetric;
	// How many stored units make one of the units the label is quoted in - the
	// only place the bits-per-byte and Mbit arithmetic appears. A signal already
	// stored in its display unit says 1 rather than restating the identity.
	storedPerDisplayUnit: number;
	unit: string;
};

// Bandwidth is stored in bytes/s, which is what Hetzner's API reports and what
// the samples hold; it is read and set in Mbit/s, which is what a person
// thresholds in. 1 Mbit/s is 1e6 / 8 bytes/s.
export const FLAG_SIGNALS = {
	egress_bandwidth: {
		label: "Outbound bandwidth",
		metric: "egress_bps",
		storedPerDisplayUnit: 1_000_000 / 8,
		unit: "Mbit/s"
	},
	egress_pps: {
		label: "Outbound packet rate",
		metric: "egress_pps",
		storedPerDisplayUnit: 1,
		unit: "packets/s"
	}
} as const satisfies Record<string, FlagSignalDefinition>;

// What a box can be flagged for. Derived from the table above, so
// `convex/schema.ts` cannot store a signal nothing here can name or label.
export type BoxFlagSignal = keyof typeof FLAG_SIGNALS;

export const BOX_FLAG_SIGNALS = Object.keys(FLAG_SIGNALS) as BoxFlagSignal[];

// The same name inside a sentence ("sustained outbound bandwidth at 30 Mbit/s"),
// where a leading capital would read as a proper noun.
export function flagSignalLabel(signal: BoxFlagSignal, sentence = false) {
	const { label } = FLAG_SIGNALS[signal];
	return sentence ? label.toLowerCase() : label;
}

// Stored unit -> the unit the label is quoted in, rounded because the control
// that edits it is a whole-number field.
export function flagDisplayValue(signal: BoxFlagSignal, stored: number) {
	return Math.round(stored / FLAG_SIGNALS[signal].storedPerDisplayUnit);
}

export function flagStoredValue(signal: BoxFlagSignal, display: number) {
	return Math.round(display * FLAG_SIGNALS[signal].storedPerDisplayUnit);
}

// A stored value as words. The locale is pinned for the same reason
// `formatPrice` pins it: CI and a developer machine must produce the same
// string, and this one ends up in an alert email and in a stored flag message.
export function formatFlagValue(signal: BoxFlagSignal, stored: number) {
	return `${flagDisplayValue(signal, stored).toLocaleString("en-US")} ${
		FLAG_SIGNALS[signal].unit
	}`;
}

// The alert thresholds an operator sets against those signals. Pure vocabulary
// and arithmetic, same as the rest of this module, and here rather than beside
// the queries that read them because the console's thresholds panel imports
// them: a module that also defines Convex functions cannot be imported by the
// browser without `convex` refusing it.
export type ThresholdSpec = {
	value: number;
	sustainedSamples: number;
};

export type ThresholdSetting = {
	signal: BoxFlagSignal;
	value: number;
	sustainedSamples: number;
};

export const DEFAULT_THRESHOLDS: readonly ThresholdSetting[] = [
	{
		signal: "egress_bandwidth",
		value: 25_000_000,
		sustainedSamples: 3
	},
	{
		signal: "egress_pps",
		value: 30_000,
		sustainedSamples: 3
	}
];

export const THRESHOLD_SIGNALS = DEFAULT_THRESHOLDS.map(
	(threshold) => threshold.signal
);

function validThresholdValue(threshold: ThresholdSpec) {
	return (
		Number.isFinite(threshold.value) &&
		threshold.value >= 0 &&
		Number.isInteger(threshold.sustainedSamples) &&
		threshold.sustainedSamples >= 1
	);
}

export function isEnabled(threshold: ThresholdSetting) {
	return threshold.value > 0;
}

export function resolveThresholds(
	stored: StoredThreshold[] | undefined
): ThresholdSetting[] {
	return DEFAULT_THRESHOLDS.map((def) => {
		const override = stored?.find(
			(row) =>
				row.signal === def.signal &&
				validThresholdValue({
					value: row.value,
					sustainedSamples: row.sustained_samples
				})
		);
		if (!override) return def;
		return {
			signal: override.signal,
			value: override.value,
			sustainedSamples: override.sustained_samples
		};
	});
}

export function thresholdsToStored(
	thresholds: readonly ThresholdSetting[]
): StoredThreshold[] {
	validateThresholds(thresholds);
	return thresholds.map((threshold) => ({
		signal: threshold.signal,
		value: threshold.value,
		sustained_samples: threshold.sustainedSamples
	}));
}

export function validateThresholds(thresholds: readonly ThresholdSetting[]) {
	const seen = new Set<BoxFlagSignal>();
	for (const threshold of thresholds) {
		if (!THRESHOLD_SIGNALS.includes(threshold.signal)) {
			throw new Error(`Unknown threshold signal: ${threshold.signal}.`);
		}
		if (seen.has(threshold.signal)) {
			throw new Error(`Duplicate threshold for signal: ${threshold.signal}.`);
		}
		seen.add(threshold.signal);

		if (!Number.isFinite(threshold.value) || threshold.value < 0) {
			throw new Error(
				`Threshold value for ${threshold.signal} must be >= 0 (0 disables).`
			);
		}
		if (
			!Number.isInteger(threshold.sustainedSamples) ||
			threshold.sustainedSamples < 1
		) {
			throw new Error(
				`Sustained samples for ${threshold.signal} must be a positive integer.`
			);
		}
	}

	const missing = THRESHOLD_SIGNALS.filter((signal) => !seen.has(signal));
	if (missing.length > 0) {
		throw new Error(
			`Provide a threshold for every signal (${missing.join(", ")} missing).`
		);
	}
}

// Decides whether a threshold is "sustained": the most recent N values must all
// be at or above the threshold. Returns the mean of that window when sustained,
// null otherwise. Values are assumed newest-first (the caller orders desc).
export function crossedValue(values: number[], threshold: ThresholdSpec) {
	if (values.length < threshold.sustainedSamples) return null;
	const window = values.slice(0, threshold.sustainedSamples);
	if (!window.every((value) => value >= threshold.value)) return null;
	return window.reduce((sum, value) => sum + value, 0) / window.length;
}
