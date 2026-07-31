"use client";

import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";

export function FadingText({
	className,
	text
}: {
	className?: string;
	text: string;
}) {
	return (
		<AnimatePresence initial={false} mode="wait">
			{text ? (
				<motion.span
					animate={{ opacity: 1 }}
					className={cn("inline-block", className)}
					exit={{ opacity: 0 }}
					initial={{ opacity: 0 }}
					key={text}
					transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
				>
					{text}
				</motion.span>
			) : null}
		</AnimatePresence>
	);
}
