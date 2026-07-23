"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// A chart with its pickers floating over its top-left corner.
//
// The overlay is the whole point and the reason this is shared: the selects sit
// inside the card rather than above it, so the chart keeps the card's full width
// and the header row costs no vertical space. What that buys is paid for by a
// coupling nothing declares - the body's top padding has to clear a control
// positioned out of flow - and two panels had written the pair out separately,
// where the two numbers could be changed one at a time.
//
// `MonitorCard` deliberately does not use this. It swaps its body between a
// padded chart and a full-bleed log viewport, so it has no single body padding
// to share; it repeats the overlay line and nothing else.
export function ChartCard({
	children,
	className,
	controls
}: {
	children: ReactNode;
	className?: string;
	controls: ReactNode;
}) {
	return (
		<div className={cn("relative rounded-2xl bg-card", className)}>
			<div className="absolute top-3 left-3 z-10 flex gap-2">{controls}</div>
			<div className="p-4 pt-12">{children}</div>
		</div>
	);
}
