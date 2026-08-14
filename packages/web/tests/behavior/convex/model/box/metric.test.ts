import { describe, expect, test } from "vitest";

import {
	FLAG_SIGNALS,
	METRICS_RANGES,
	ROLLED_METRICS,
	flagDisplayValue,
	flagSignalLabel,
	flagStoredValue,
	formatFlagValue,
	type BoxFlagSignal
} from "@/convex/model/box/metric";
import { vBoxFlagSignal } from "@/convex/schema";

// The union the schema stores, as a list. `satisfies` already stops a signal
// going missing from `FLAG_SIGNALS` at compile time; what it cannot see is one
// left behind there after the union dropped it.
const SIGNALS = vBoxFlagSignal.members.map(
	(member) => member.value
) as BoxFlagSignal[];

// The one vocabulary both planes read. A wrong conversion here is not a display
// bug: `flagStoredValue` is what the console writes into the settings row, and
// `formatFlagValue` is what the alert an operator acts on quotes - so the same
// mistake would set a threshold a thousand times too low and then describe it
// back correctly.

const MEGABIT_PER_SECOND_IN_BYTES = 1_000_000 / 8;

describe("the signals a box can be flagged on", () => {
	test("defines every signal the schema admits, and no others", () => {
		expect(Object.keys(FLAG_SIGNALS).sort()).toEqual([...SIGNALS].sort());
	});

	test("measures each signal against a metric that is actually rolled up", () => {
		for (const definition of Object.values(FLAG_SIGNALS)) {
			expect(ROLLED_METRICS).toContain(definition.metric);
		}
	});

	test("offers the chart's ranges shortest first", () => {
		expect([...METRICS_RANGES]).toEqual(["1h", "6h", "24h", "7d", "30d"]);
	});
});

// Title case standing alone, lower case inside a sentence - the same rule
// `operationLabel` follows, because a leading capital mid-sentence reads as a
// proper noun.
describe("naming a signal", () => {
	test("titles a signal on its own and lowers it inside a sentence", () => {
		expect(flagSignalLabel("egress_bandwidth")).toBe("Outbound bandwidth");
		expect(flagSignalLabel("egress_bandwidth", true)).toBe(
			"outbound bandwidth"
		);
	});

	test("names every signal distinctly", () => {
		const labels = SIGNALS.map((signal) => flagSignalLabel(signal));
		expect(new Set(labels).size).toBe(labels.length);
	});
});

// Bandwidth is stored in bytes/s because that is what Hetzner reports, and
// thresholded in Mbit/s because that is what a person types. This is the only
// place that arithmetic exists.
describe("converting between the stored unit and the one people type", () => {
	test("reads bytes per second back as megabits per second", () => {
		expect(
			flagDisplayValue("egress_bandwidth", 25 * MEGABIT_PER_SECOND_IN_BYTES)
		).toBe(25);
	});

	test("stores a megabit-per-second threshold as bytes per second", () => {
		expect(flagStoredValue("egress_bandwidth", 25)).toBe(
			25 * MEGABIT_PER_SECOND_IN_BYTES
		);
	});

	// A signal already in its display unit says so with a 1 rather than restating
	// the identity, so the two directions have to be the identity for it.
	test("leaves a signal already in its display unit alone", () => {
		expect(flagDisplayValue("egress_pps", 30_000)).toBe(30_000);
		expect(flagStoredValue("egress_pps", 30_000)).toBe(30_000);
	});

	test.each(SIGNALS)(
		"round-trips a %s threshold a person could enter",
		(signal) => {
			expect(flagDisplayValue(signal, flagStoredValue(signal, 42))).toBe(42);
		}
	);

	// The control that edits it is a whole-number field, so a stored value between
	// two of them has to land on one rather than render as a fraction.
	test("rounds a stored value that falls between two whole display units", () => {
		expect(
			flagDisplayValue("egress_bandwidth", MEGABIT_PER_SECOND_IN_BYTES * 1.5)
		).toBe(2);
		expect(
			flagDisplayValue("egress_bandwidth", MEGABIT_PER_SECOND_IN_BYTES * 1.4)
		).toBe(1);
	});
});

// This string ends up in an alert email and in the stored flag message, so it is
// pinned to a locale: a machine grouping with "." would write a threshold of
// 1.000 Mbit/s where CI wrote 1,000.
describe("quoting a value", () => {
	test("groups thousands the same way everywhere and names the unit", () => {
		expect(formatFlagValue("egress_pps", 30_000)).toBe("30,000 packets/s");
		expect(
			formatFlagValue("egress_bandwidth", 25 * MEGABIT_PER_SECOND_IN_BYTES)
		).toBe("25 Mbit/s");
	});
});
