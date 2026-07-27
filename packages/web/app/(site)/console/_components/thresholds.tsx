"use client";

import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
	DEFAULT_THRESHOLDS,
	FLAG_SIGNALS,
	flagDisplayValue,
	flagSignalLabel,
	flagStoredValue,
	type ThresholdSetting
} from "@/convex/model/box/metric";
import { useBusyAction } from "@/hooks/use-busy-action";
import { useSettingDraft, type SettingDraft } from "@/hooks/use-setting-draft";
import { NumberField, SettingsCard } from "./settings-card";

type Signal = ThresholdSetting["signal"];

// One flat draft keyed `<signal>.<field>`, so the thresholds - which are a list -
// still ride the same draft the other panels use. The signals themselves are
// fixed by `DEFAULT_THRESHOLDS`, never by what the server happened to return, so
// a stored row for a signal that no longer exists cannot render a phantom field.
const SIGNALS: Signal[] = DEFAULT_THRESHOLDS.map(
	(threshold) => threshold.signal
);

function toDraft(thresholds: readonly ThresholdSetting[]): SettingDraft {
	const draft: SettingDraft = {};
	for (const signal of SIGNALS) {
		const threshold =
			thresholds.find((row) => row.signal === signal) ??
			DEFAULT_THRESHOLDS.find((row) => row.signal === signal);
		if (!threshold) continue;
		draft[`${signal}.value`] = String(
			flagDisplayValue(signal, threshold.value)
		);
		draft[`${signal}.samples`] = String(threshold.sustainedSamples);
	}
	return draft;
}

function toSettings(draft: SettingDraft): ThresholdSetting[] {
	return SIGNALS.map((signal) => ({
		signal,
		value: flagStoredValue(signal, Number(draft[`${signal}.value`])),
		sustainedSamples: Number(draft[`${signal}.samples`])
	}));
}

export function Thresholds({
	thresholds
}: {
	thresholds?: ThresholdSetting[];
}) {
	const setThresholds = useMutation(api.staff.settings.setThresholds);
	const { run, busy } = useBusyAction();
	const { draft, dirty, setDraft, setField } = useSettingDraft(
		thresholds && toDraft(thresholds)
	);

	return (
		<SettingsCard
			onReset={() => setDraft(toDraft(DEFAULT_THRESHOLDS))}
			onSave={() =>
				run("thresholds", "Thresholds updated", () =>
					setThresholds({ thresholds: toSettings(draft) })
				)
			}
			saveDisabled={!dirty || busy !== null}
			title="Abuse thresholds"
		>
			{SIGNALS.map((signal) => {
				const disabled = Number(draft[`${signal}.value`]) <= 0;
				return (
					/* Two fixed-width control groups plus a label don't fit on one
					   narrow row - they were what made the whole console page scroll
					   sideways - so the label takes its own line below sm. This is why
					   the thresholds lay out their own rows rather than using
					   SettingsRow's two-column grid. */
					<div
						className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 sm:grid-cols-[1fr_auto_auto]"
						key={signal}
					>
						<span
							className={`col-span-2 text-sm sm:col-span-1 ${disabled ? "text-muted-foreground" : "text-foreground"}`}
						>
							{flagSignalLabel(signal)}
						</span>
						<NumberField
							disabled={busy !== null}
							inputClassName="w-24"
							min={0}
							onChange={(value) => setField(`${signal}.value`, value)}
							unit={disabled ? "disabled" : FLAG_SIGNALS[signal].unit}
							unitClassName="w-16"
							value={draft[`${signal}.value`] ?? ""}
						/>
						<NumberField
							disabled={busy !== null}
							inputClassName="w-14"
							min={1}
							onChange={(value) => setField(`${signal}.samples`, value)}
							unit="polls"
							unitClassName=""
							value={draft[`${signal}.samples`] ?? ""}
						/>
					</div>
				);
			})}
		</SettingsCard>
	);
}
