"use client";

import { motion } from "motion/react";
import { createAnimatedIcon, LUCIDE_SVG } from "@/components/icons/create";

export const RotateCWIcon = createAnimatedIcon(
	"RotateCWIcon",
	({ controls, size }) => (
		<motion.svg
			{...LUCIDE_SVG}
			animate={controls}
			height={size}
			transition={{ type: "spring", stiffness: 250, damping: 25 }}
			variants={{
				normal: { rotate: "0deg" },
				animate: { rotate: "50deg" }
			}}
			width={size}
		>
			<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
			<path d="M21 3v5h-5" />
		</motion.svg>
	)
);
