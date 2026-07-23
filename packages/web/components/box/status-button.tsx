"use client";

import {
	AnimatedIcon,
	type AnimatedIconName,
	useAnimatedIconHandlers
} from "@/components/animated-icon";
import { StatusText } from "@/components/box/status-text";
import { Button } from "@/components/base/button";
import { type BoxStatus } from "@/convex/model/box/status";

type StatusAction = {
	disabled?: boolean;
	icon: AnimatedIconName;
	iconClassName?: string;
	label: string;
	onClick: () => void;
};

export function StatusButton({
	action,
	status
}: {
	action?: StatusAction;
	status: BoxStatus;
}) {
	const { handlers, iconRef } = useAnimatedIconHandlers<HTMLButtonElement>({});

	if (!action) {
		return (
			<Button disabled variant="outline">
				<StatusText kind="box" status={status} />
			</Button>
		);
	}

	return (
		// Both states occupy one grid cell, and both start at its left edge.
		//
		// The resting status and the hover action have the same shape - a glyph, a
		// gap, a word - so pinning them to a shared left edge keeps the glyph in
		// exactly one place while the label grows rightwards. Centring each state
		// independently, which is what an absolutely positioned overlay does,
		// moves the glyph by half the difference in label width every time the
		// pointer arrives: "Running" to "Stop" visibly shunts it sideways.
		//
		// The cell is sized by the wider of the two, so the button does not resize
		// on hover either, and `justify-center` still centres that block within the
		// button the way every other button centres its content.
		<Button
			aria-label={action.label}
			className="inline-grid"
			disabled={action.disabled}
			onClick={action.onClick}
			variant="outline"
			{...handlers}
		>
			<StatusText
				className="col-start-1 row-start-1 justify-self-start transition-opacity group-hover/button:opacity-0 group-focus-visible/button:opacity-0"
				// Sized to the hovered glyph rather than the other way round: the
				// animated icon is 16 everywhere else in the interface, and matching
				// that keeps the icon-to-label gap identical to every other icon
				// button. Shrinking it instead made this one button's gap the odd one.
				iconClassName="size-4"
				kind="box"
				status={status}
			/>
			<span className="col-start-1 row-start-1 inline-flex items-center gap-1.5 justify-self-start opacity-0 transition-opacity group-hover/button:opacity-100 group-focus-visible/button:opacity-100">
				<AnimatedIcon
					// Default size, exactly as every other icon button renders it.
					// `createAnimatedIcon` puts the class on a wrapper div and sizes the
					// <svg> from the numeric prop alone, so overriding one without the
					// other leaves a glyph that overflows its own box.
					className={action.iconClassName}
					icon={action.icon}
					iconRef={iconRef}
				/>
				{action.label}
			</span>
		</Button>
	);
}
