"use client";

import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
	DEFAULT_SNAPSHOT_POLICY,
	type SnapshotPolicy
} from "@/convex/boxes/snapshotPolicy";
import { useBusyAction } from "@/hooks/use-busy-action";
import { useSettingDraft, type SettingDraft } from "@/hooks/use-setting-draft";
import { NumberField, SettingsCard, SettingsRow } from "./settings-card";

type FieldKey = keyof SnapshotPolicy;

// Timing only. How many snapshots a box may hold is sold by its plan and split
// by its owner, so there is nothing here that could contradict either.
//
// Automatic retention covers every snapshot this deployment takes by itself -
// the daily one and the rollback one. There is no manual retention to set: a
// snapshot the owner took is kept until they remove it.
const FIELDS: { key: FieldKey; label: string; unit: string }[] = [
	{
		key: "manualMinIntervalMinutes",
		label: "Manual cooldown",
		unit: "minutes"
	},
	{ key: "automaticRetentionDays", label: "Automatic retention", unit: "days" }
];

// Both directions go through the one field list, so a policy field added to the
// type has one place to appear rather than three hand-written object literals to
// be pasted into.
function toDraft(policy: SnapshotPolicy): SettingDraft {
	return Object.fromEntries(
		FIELDS.map((field) => [field.key, String(policy[field.key])])
	);
}

function toPolicy(draft: SettingDraft): SnapshotPolicy {
	return {
		manualMinIntervalMinutes: Number(draft.manualMinIntervalMinutes),
		automaticRetentionDays: Number(draft.automaticRetentionDays)
	};
}

export function SnapshotPolicy({ policy }: { policy?: SnapshotPolicy }) {
	const setSnapshotPolicy = useMutation(api.staff.settings.setSnapshotPolicy);
	const { run, busy } = useBusyAction();
	const { draft, dirty, setDraft, setField } = useSettingDraft(
		policy && toDraft(policy)
	);

	return (
		<SettingsCard
			onReset={() => setDraft(toDraft(DEFAULT_SNAPSHOT_POLICY))}
			onSave={() =>
				run("snapshot-policy", "Snapshot policy updated", () =>
					setSnapshotPolicy({ policy: toPolicy(draft) })
				)
			}
			saveDisabled={!dirty || busy !== null}
			title="Snapshot policy"
		>
			{FIELDS.map((field) => (
				<SettingsRow key={field.key} label={field.label}>
					<NumberField
						disabled={busy !== null}
						min={1}
						onChange={(value) => setField(field.key, value)}
						unit={field.unit}
						value={draft[field.key] ?? ""}
					/>
				</SettingsRow>
			))}
		</SettingsCard>
	);
}
