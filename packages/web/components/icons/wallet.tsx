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
		y: [0, -3, 0],
		rotate: [0, -4, 0],
		transition: {
			duration: 0.55,
			ease: "easeInOut",
			times: [0, 0.45, 1]
		}
	}
};

export const WalletIcon = createAnimatedIcon(
	"WalletIcon",
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
			<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
			<path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
		</motion.svg>
	)
);
