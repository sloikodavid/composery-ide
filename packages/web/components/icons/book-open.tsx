"use client";

import { motion } from "motion/react";
import type { Variants } from "motion/react";
import { createAnimatedIcon, LUCIDE_SVG } from "@/components/icons/create";

const VARIANTS: Variants = {
	normal: {
		y: 0,
		rotate: 0,
		transition: {
			duration: 0.3,
			ease: "easeOut"
		}
	},
	animate: {
		y: [0, -2, 0],
		rotate: [0, -5, 0],
		transition: {
			duration: 0.55,
			ease: "easeInOut",
			times: [0, 0.45, 1]
		}
	}
};

export const BookOpenIcon = createAnimatedIcon(
	"BookOpenIcon",
	({ controls, size }) => (
		<motion.svg
			{...LUCIDE_SVG}
			animate={controls}
			height={size}
			initial="normal"
			style={{ transformOrigin: "12px 12px" }}
			variants={VARIANTS}
			width={size}
		>
			<path d="M12 7v14" />
			<path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
		</motion.svg>
	)
);
