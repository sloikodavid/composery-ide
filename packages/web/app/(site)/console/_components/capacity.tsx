"use client";

import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type {
	CapacityBlockReason,
	CapacityUsage
} from "@/convex/boxes/capacity";
import { useBusyAction } from "@/hooks/use-busy-action";
import { useSettingDraft } from "@/hooks/use-setting-draft";
import { NumberField, SettingsCard, SettingsRow } from "./settings-card";

const LIMIT_MAX = 100_000;

function draftValue(value: number | null) {
	return value === null ? "" : String(value);
}

// An empty field is "no allocation configured", which is a real state - capacity
// admission fails closed on it - so it parses to null rather than to zero.
function parsedLimit(value: string) {
	return value === "" ? null : Number(value);
}

function validLimit(value: number | null) {
	return (
		value === null ||
		(Number.isInteger(value) && value >= 1 && value <= LIMIT_MAX)
	);
}

// One line per reason checkout can be closed, and every reason has one.
//
// A record rather than a chain of comparisons with a fallback, because the
// fallback was the bug: a reason nobody had written a sentence for fell through
// to "N additional boxes can be reserved", so the console reported capacity as
// available on a deployment where checkout was blocked. That is the silent wrong
// answer this codebase refuses - and it is invisible, because the page renders
// perfectly either way.
//
// Keyed by every non-null `CapacityBlockReason`, so adding a reason to
// `model/box/capacity.ts` fails to compile here until somebody writes what staff
// should read when it fires.
const BLOCK_REASON_STATUS: Record<
	Exclude<CapacityBlockReason, null>,
	string
> = {
	limits_not_configured: "Set every allocation before checkout can start.",
	server_limit: "Server capacity is fully committed.",
	snapshot_limit: "Snapshot capacity is fully committed.",
	certificate_limit:
		"This week's certificate allowance is committed to new boxes. Resets, renames and restores keep their reserve.",
	manual_pause: "Capacity is available, but checkout is manually paused."
};

function capacityStatus(
	capacity: CapacityUsage,
	serverLimit: number | null,
	snapshotLimit: number | null
) {
	if (capacity.blockReason === "limits_not_configured") {
		return BLOCK_REASON_STATUS.limits_not_configured;
	}

	const serverOvercommit =
		serverLimit !== null && capacity.serverCommitments > serverLimit;
	const snapshotOvercommit =
		snapshotLimit !== null && capacity.snapshotCommitments > snapshotLimit;
	if (serverOvercommit || snapshotOvercommit) {
		const which =
			serverOvercommit && snapshotOvercommit
				? "server and snapshot allocations"
				: serverOvercommit
					? "server allocation"
					: "snapshot allocation";
		return `Existing commitments exceed the configured ${which}. New checkout is blocked; existing boxes keep priority.`;
	}

	// Every remaining reason has a sentence, so the only thing left to say is the
	// unblocked one. Nothing falls through.
	if (capacity.blockReason !== null) {
		return BLOCK_REASON_STATUS[capacity.blockReason];
	}
	return `${capacity.availableNewBoxes} additional box${capacity.availableNewBoxes === 1 ? "" : "es"} can be reserved.`;
}

export function Capacity({
	capacity,
	serverLimit,
	snapshotLimit
}: {
	capacity: CapacityUsage;
	serverLimit: number | null;
	snapshotLimit: number | null;
}) {
	const setLimits = useMutation(api.staff.settings.setHetznerLimits);
	const { run, busy } = useBusyAction();
	const { draft, dirty, setField } = useSettingDraft({
		server: draftValue(serverLimit),
		snapshot: draftValue(snapshotLimit)
	});

	const nextServerLimit = parsedLimit(draft.server ?? "");
	const nextSnapshotLimit = parsedLimit(draft.snapshot ?? "");
	// Both or neither: one allocation alone cannot admit a box, and the mutation
	// refuses the half-configured pair, so the button refuses it too.
	const bothSetOrCleared =
		(nextServerLimit === null) === (nextSnapshotLimit === null);
	const valid =
		bothSetOrCleared &&
		validLimit(nextServerLimit) &&
		validLimit(nextSnapshotLimit);

	return (
		<SettingsCard
			onSave={() =>
				run("hetzner-capacity", "Hetzner capacity updated", () =>
					setLimits({
						serverLimit: nextServerLimit,
						snapshotLimit: nextSnapshotLimit
					})
				)
			}
			saveDisabled={!dirty || !valid || busy !== null}
			subtitle={capacityStatus(capacity, serverLimit, snapshotLimit)}
			title="Hetzner capacity"
		>
			<SettingsRow
				label={
					<div>
						<p className="text-sm">Server allocation</p>
						<p className="text-xs text-muted-foreground">
							{capacity.serverCommitments} committed: {capacity.liveBoxCount}{" "}
							boxes and {capacity.activeCheckoutCount} active checkouts
						</p>
					</div>
				}
			>
				<NumberField
					disabled={busy !== null}
					inputClassName="w-24"
					max={LIMIT_MAX}
					min={1}
					onChange={(value) => setField("server", value)}
					placeholder="Required"
					value={draft.server ?? ""}
				/>
			</SettingsRow>
			<SettingsRow
				label={
					<div>
						<p className="text-sm">Snapshot allocation</p>
						<p className="text-xs text-muted-foreground">
							{capacity.snapshotCommitments} committed;{" "}
							{capacity.snapshotSlotsPerBox} reserved per new box
						</p>
					</div>
				}
			>
				<NumberField
					disabled={busy !== null}
					inputClassName="w-24"
					max={LIMIT_MAX}
					min={1}
					onChange={(value) => setField("snapshot", value)}
					placeholder="Required"
					value={draft.snapshot ?? ""}
				/>
			</SettingsRow>
		</SettingsCard>
	);
}

// The apex's weekly Let's Encrypt allowance.
//
// A card of its own rather than a third field on the Hetzner one, because it is
// not a provider allocation and does not move when that one does: it changes
// when Let's Encrypt grants this deployment a rate limit adjustment. Folding it
// in would also have meant one save button writing two unrelated settings.
export function CertificateBudget({
	capacity,
	weeklyLimit
}: {
	capacity: CapacityUsage;
	weeklyLimit: number | null;
}) {
	const setCertificateLimit = useMutation(
		api.staff.settings.setCertificateLimit
	);
	const { run, busy } = useBusyAction();
	const { draft, dirty, setField } = useSettingDraft({
		weekly: draftValue(weeklyLimit)
	});

	const nextLimit = parsedLimit(draft.weekly ?? "");

	return (
		<SettingsCard
			onSave={() =>
				run("certificate-budget", "Certificate budget updated", () =>
					setCertificateLimit({ weeklyLimit: nextLimit })
				)
			}
			saveDisabled={!dirty || !validLimit(nextLimit) || busy !== null}
			subtitle={
				weeklyLimit === null
					? "Set the weekly allowance before checkout can start."
					: `${capacity.issuedCertificatesThisWeek} issued in the last 7 days. ${capacity.certificatesForCreation} left for new boxes, ${capacity.certificatesForRecovery} for resets, renames and restores.`
			}
			title="Certificate budget"
		>
			<SettingsRow
				label={
					<div>
						<p className="text-sm">Weekly allowance</p>
						<p className="text-xs text-muted-foreground">
							Certificates per week for the whole domain. Roughly 50 unless
							Let&apos;s Encrypt has granted an adjustment.
						</p>
					</div>
				}
			>
				<NumberField
					disabled={busy !== null}
					inputClassName="w-24"
					max={LIMIT_MAX}
					min={1}
					onChange={(value) => setField("weekly", value)}
					placeholder="Required"
					value={draft.weekly ?? ""}
				/>
			</SettingsRow>
		</SettingsCard>
	);
}
