"use client";

import type { ComponentProps } from "react";
import { AnimatedIconButton } from "@/components/animated-icon";

// `iconOnly` is what a table's action column takes: those columns are sized for
// icon buttons, and the label survives as the accessible name.
export function DismissButton({
	children = "Dismiss",
	iconOnly = false,
	...props
}: Omit<ComponentProps<typeof AnimatedIconButton>, "icon"> & {
	iconOnly?: boolean;
}) {
	return (
		<AnimatedIconButton
			{...props}
			aria-label={iconOnly ? String(children) : undefined}
			icon="x"
			iconPosition={iconOnly ? "only" : "start"}
			size={iconOnly ? "icon-sm" : "sm"}
			variant="ghost"
		>
			{iconOnly ? undefined : children}
		</AnimatedIconButton>
	);
}
