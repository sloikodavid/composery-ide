"use client";

import { PlayIcon, PlugZapIcon, PlusIcon, type LucideIcon } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { StatusButton } from "@/components/box/status-button";
import type { AnimatedIconName } from "@/components/animated-icon";
import { type BoxOperationType } from "@/convex/model/box/operation";
import { type BoxStatus } from "@/convex/model/box/status";

type ConfirmAction = { onConfirm: () => void };
type ClickAction = { disabled?: boolean; onClick: () => void };

// Which operation a status leads with, and the only place this page decides it.
//
// *Which* one is a product decision and stays written down: several operations
// are legal from `running` - stop, reset, repair, update, snapshot, a slug
// change - and this is the one the page puts a button on. What is not a decision
// is whether that operation is legal at all, and that is what this table exists
// to pin. The branches below used to test the status literal directly, so this
// page held a second, hand-written copy of `BOX_OPERATIONS[type].from`: adding
// `suspended` to `start.from` grew no button here, and removing `running` from
// `stop.from` would leave a button that throws when pressed. Neither failed
// anything.
//
// The behaviour test drives every row through `isOperationAllowed`, so the
// catalogue and this page cannot disagree without CI saying so.
export const PRIMARY_ACTION = {
	running: "stop",
	stopped: "start",
	create_failed: "create",
	suspended: "unsuspend"
} as const satisfies Partial<Record<BoxStatus, BoxOperationType>>;

// What each of those actions is called. The box list offers the same actions as
// menu items rather than as this button, so the words live here once - two
// shapes, one name per action.
export const PRIMARY_LABEL = {
	create: "Create again",
	start: "Start",
	stop: "Stop",
	unsuspend: "Unsuspend"
} as const satisfies Record<
	(typeof PRIMARY_ACTION)[keyof typeof PRIMARY_ACTION],
	string
>;

// The one glyph each action draws, wherever it appears: the animated name for
// this page's own button, the static component for the dropdown menu's copy of
// the same action (`components/box/actions-menu.tsx`). One table rather than a
// literal at each call site is what stops two actions from picking the same
// glyph by accident - which is how the menu once drew "Create again" and
// "Update" with the same spinning-arrows icon side by side.
export const PRIMARY_ICON = {
	create: { animated: "plus", static: PlusIcon },
	start: { animated: "plug-zap", static: PlugZapIcon },
	stop: { animated: "plug-zap", static: PlugZapIcon },
	unsuspend: { animated: "play", static: PlayIcon }
} as const satisfies Record<
	(typeof PRIMARY_ACTION)[keyof typeof PRIMARY_ACTION],
	{ animated: AnimatedIconName; static: LucideIcon }
>;

// What stopping costs, shown wherever a stop is confirmed.
export const STOP_DESCRIPTION =
	"Stops the box and anything running in it. Billing continues while the box is stopped.";

// The primary status button shared by the owner and console box pages: which
// action a status offers lives here once, so the two pages can't drift. Each
// page passes its own bound handlers (owner targets by slug, console by id);
// omitting `unsuspend` hides the suspended-state action, which owners lack.
export function BoxStatusAction({
	start,
	status,
	stop,
	retry,
	unsuspend
}: {
	start: ClickAction;
	status: BoxStatus;
	stop: ConfirmAction;
	retry: ClickAction;
	unsuspend?: ClickAction;
}) {
	const primary: BoxOperationType | undefined =
		PRIMARY_ACTION[status as keyof typeof PRIMARY_ACTION];

	if (primary === "stop") {
		return (
			<ConfirmDialog
				confirmLabel={PRIMARY_LABEL.stop}
				description={STOP_DESCRIPTION}
				destructive
				onConfirm={stop.onConfirm}
				title={PRIMARY_LABEL.stop}
			>
				{(open) => (
					<StatusButton
						action={{
							icon: PRIMARY_ICON.stop.animated,
							iconClassName: "text-destructive",
							label: PRIMARY_LABEL.stop,
							onClick: open
						}}
						status={status}
					/>
				)}
			</ConfirmDialog>
		);
	}

	if (primary === "start") {
		return (
			<StatusButton
				action={{
					disabled: start.disabled,
					icon: PRIMARY_ICON.start.animated,
					iconClassName: "text-success",
					label: PRIMARY_LABEL.start,
					onClick: start.onClick
				}}
				status={status}
			/>
		);
	}

	if (primary === "create") {
		return (
			<StatusButton
				action={{
					disabled: retry.disabled,
					icon: PRIMARY_ICON.create.animated,
					label: PRIMARY_LABEL.create,
					onClick: retry.onClick
				}}
				status={status}
			/>
		);
	}

	if (primary === "unsuspend" && unsuspend) {
		return (
			<StatusButton
				action={{
					disabled: unsuspend.disabled,
					icon: PRIMARY_ICON.unsuspend.animated,
					label: PRIMARY_LABEL.unsuspend,
					onClick: unsuspend.onClick
				}}
				status={status}
			/>
		);
	}

	return <StatusButton status={status} />;
}
