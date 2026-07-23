"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/error-message";

export function useBusyAction() {
	const [busy, setBusy] = useState<string | null>(null);
	const currentRun = useRef(0);

	async function run(
		name: string,
		success: string | null,
		work: () => Promise<unknown>
	) {
		const runId = currentRun.current + 1;
		currentRun.current = runId;
		setBusy(name);
		try {
			await work();
			if (success) toast.success(success);
		} catch (error) {
			toast.error("Action failed", { description: errorMessage(error) });
		} finally {
			if (currentRun.current === runId) setBusy(null);
		}
	}

	return { busy, run };
}
