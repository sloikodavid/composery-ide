"use client";

import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { MAX_ACTIVE_CHECKOUT_INTENTS_PER_USER } from "@/convex/model/settings";
import { useBusyAction } from "@/hooks/use-busy-action";
import { useSettingDraft } from "@/hooks/use-setting-draft";
import { NumberField, SettingsCard, SettingsRow } from "./settings-card";

export function CheckoutLimit({ max }: { max?: number }) {
	const setMax = useMutation(
		api.staff.settings.setMaxActiveCheckoutIntentsPerUser
	);
	const { run, busy } = useBusyAction();
	const { draft, dirty, setField } = useSettingDraft(
		max === undefined ? undefined : { max: String(max) }
	);

	const parsed = Number(draft.max);
	// The same bound the mutation enforces, read from the same constant, so the
	// button is disabled for exactly the values the server would refuse - the
	// interface used to carry its own `50`.
	const valid =
		Number.isInteger(parsed) &&
		parsed >= 1 &&
		parsed <= MAX_ACTIVE_CHECKOUT_INTENTS_PER_USER;

	return (
		<SettingsCard
			onSave={() =>
				run("checkout-limit", "Reservation limit updated", () =>
					setMax({ max: parsed })
				)
			}
			saveDisabled={!dirty || !valid || busy !== null}
			title="Checkout reservation limit"
		>
			<SettingsRow
				label={
					<span className="text-sm text-pretty text-muted-foreground">
						Max concurrent pending checkouts per user
					</span>
				}
			>
				<NumberField
					disabled={busy !== null}
					max={MAX_ACTIVE_CHECKOUT_INTENTS_PER_USER}
					min={1}
					onChange={(value) => setField("max", value)}
					unit="reservations"
					unitClassName="w-16"
					value={draft.max ?? ""}
				/>
			</SettingsRow>
		</SettingsCard>
	);
}
