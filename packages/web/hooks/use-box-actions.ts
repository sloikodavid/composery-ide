"use client";

import { useAction, useMutation } from "convex/react";

import { api } from "@/convex/_generated/api";
import { useBusyAction } from "@/hooks/use-busy-action";

// Every action an owner can take on one box, bound to that box's slug and sharing
// one busy flag.
//
// The box page spreads these across a row of buttons and the box list gives each
// row the same set in a menu. Binding them here is what stops the two surfaces
// from calling the same mutation under a different busy name, or telling the
// owner a different thing when it finishes - and a name is what the dialogs read
// to know their own action is the one running.
//
// `changeSlug` is the one that reports nothing: its dialog owns the progress
// message, because it also clears its field and closes itself once the change is
// accepted.
export function useBoxActions(slug: string) {
	const changeSlug = useMutation(api.owner.boxes.changeSlug);
	const customerPortalUrl = useAction(api.owner.boxes.customerPortalUrl);
	const recoveryStatus = useAction(api.owner.boxes.recoveryStatus);
	const repairBox = useAction(api.owner.boxes.repair);
	const resetBox = useMutation(api.owner.boxes.reset);
	const retryCreate = useMutation(api.owner.boxes.retryCreate);
	const startBox = useMutation(api.owner.boxes.start);
	const stopBox = useMutation(api.owner.boxes.stop);
	const updateBox = useAction(api.owner.boxes.update);
	const { busy, run } = useBusyAction();

	return {
		busy,
		changeSlug: (newSlug: string) => changeSlug({ newSlug, slug }),
		checkRepair: () => recoveryStatus({ slug }),
		// No success message: the browser leaves for the payment provider, so the
		// only thing left to report here is a failure to get there.
		openBilling: () =>
			run("portal", null, async () => {
				const portal = await customerPortalUrl({ slug });
				window.location.assign(portal.url);
			}),
		repair: () => run("repair", "Repairing box", () => repairBox({ slug })),
		reset: () =>
			run("reset", "Resetting box", () =>
				resetBox({ confirmation: slug, slug })
			),
		retryCreate: () =>
			run("create", "Creating box", () => retryCreate({ slug })),
		start: () => run("start", "Starting box", () => startBox({ slug })),
		stop: () => run("stop", "Stopping box", () => stopBox({ slug })),
		update: () => run("update", "Updating box", () => updateBox({ slug }))
	};
}

export type BoxActions = ReturnType<typeof useBoxActions>;
