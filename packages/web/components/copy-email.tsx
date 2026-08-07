"use client";

import { copyToClipboard } from "@/lib/clipboard";
import { SUPPORT_EMAIL } from "@/convex/model/links";
import { cn } from "@/lib/utils";

// Copies the support email instead of opening a mail client - mailto links
// dead-end on machines without one configured, and copying feeds whichever
// mail app the visitor actually uses.
export function CopyEmail({
	className,
	label = SUPPORT_EMAIL,
	message = "Email copied"
}: {
	className?: string;
	label?: string;
	message?: string;
}) {
	return (
		<button
			className={cn("cursor-pointer", className)}
			onClick={() => void copyToClipboard(SUPPORT_EMAIL, message)}
			type="button"
		>
			{label}
		</button>
	);
}
