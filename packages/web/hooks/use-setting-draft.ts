"use client";

import { useState } from "react";
import { useReseed } from "@/hooks/use-reseed";

// A settings form's fields: seeded from what the server has, re-seeded when the
// server's answer actually changes (see `useReseed`), and never reset out from
// under someone who is in the middle of typing.
//
// Values are strings because that is what an `<input>` holds: an empty field, a
// half-typed number and a minus sign are all states a form has to survive, and
// none of them is a number yet. Parsing is the caller's business, on save.
export type SettingDraft = Record<string, string>;

function signatureOf(draft: SettingDraft | undefined) {
	return draft ? JSON.stringify(draft) : null;
}

export function useSettingDraft(saved: SettingDraft | undefined) {
	const [draft, setDraft] = useState<SettingDraft>(saved ?? {});

	const savedSignature = signatureOf(saved);
	useReseed(savedSignature, () => setDraft(saved ?? {}));

	return {
		draft,
		// Nothing to save until the server's value has arrived and been departed
		// from. A form still waiting on its query is never dirty.
		dirty: savedSignature !== null && signatureOf(draft) !== savedSignature,
		setDraft,
		setField: (key: string, value: string) =>
			setDraft((current) => ({ ...current, [key]: value }))
	};
}
