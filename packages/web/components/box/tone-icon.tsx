import {
	CircleCheckIcon,
	CircleHelpIcon,
	CircleXIcon,
	TriangleAlertIcon
} from "lucide-react";
import type { Tone } from "@/lib/box/repair";
import { cn } from "@/lib/utils";

// A tone as a glyph, for the box dialogs that report a state they read rather
// than one they control. Shared so "we could not read this" (muted) and "this is
// fine" (ok) cannot end up drawn the same way in two places - the Repair dialog
// and the Update dialog both lean on that distinction to avoid reporting an
// unchecked box as healthy or an uncomparable one as up to date.
export function ToneIcon({
	tone,
	className
}: {
	tone: Tone;
	className?: string;
}) {
	const base = cn("size-4 shrink-0", className);
	if (tone === "ok") {
		return <CircleCheckIcon className={cn(base, "text-success")} />;
	}
	if (tone === "warn") {
		return <TriangleAlertIcon className={cn(base, "text-warning")} />;
	}
	if (tone === "bad") {
		return <CircleXIcon className={cn(base, "text-destructive")} />;
	}
	return <CircleHelpIcon className={cn(base, "text-muted-foreground")} />;
}
