"use client";

import { motion } from "motion/react";
import { createAnimatedIcon } from "@/components/icons/create";

// Vercel's triangle logo. Monochrome, so it draws in `currentColor` to
// follow the button's foreground in light and dark. It lifts on hover with the
// same spring as the other "Open in" logos.

export const VercelIcon = createAnimatedIcon(
	"VercelIcon",
	({ controls, size }) => (
		<motion.svg
			animate={controls}
			fill="currentColor"
			height={size}
			transition={{ type: "spring", stiffness: 250, damping: 25 }}
			variants={{
				normal: { y: 0 },
				animate: { y: -2.5 }
			}}
			viewBox="0 0 24 24"
			width={size}
			xmlns="http://www.w3.org/2000/svg"
		>
			<path d="M12 2 L23 21 H1 Z" />
		</motion.svg>
	)
);
