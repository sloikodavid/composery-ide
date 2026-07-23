"use client";

import { useEffect, useRef } from "react";
import {
	AnimatedIcon,
	type AnimatedIconHandle
} from "@/components/animated-icon";
import { cn } from "@/lib/utils";

// The "running" status chip's spinning drum. Unlike the hover-driven button
// icons, this one starts its (already infinite) animation on mount and keeps
// tumbling, so a running box always reads as live.
export function RunningIndicator({ className }: { className?: string }) {
	const ref = useRef<AnimatedIconHandle>(null);

	useEffect(() => {
		ref.current?.startAnimation();
	}, []);

	return (
		<AnimatedIcon
			className={cn("size-3.5 text-success", className)}
			icon="washing-machine"
			iconRef={ref}
			size={28}
		/>
	);
}
