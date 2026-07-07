"use client";

import { motion } from "motion/react";
import type { Variants } from "motion/react";
import { createAnimatedIcon, LUCIDE_SVG } from "@/components/icons/create";

const PATH_VARIANTS: Variants = {
	normal: {
		translateX: 0
	},
	animate: {
		translateX: [0, 3, 0],
		transition: {
			duration: 0.4
		}
	}
};

export const LogInIcon = createAnimatedIcon(
	"LogInIcon",
	({ controls, size }) => (
		<svg {...LUCIDE_SVG} height={size} width={size}>
			<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
			<motion.polyline
				animate={controls}
				points="10 17 15 12 10 7"
				variants={PATH_VARIANTS}
			/>
			<motion.line
				animate={controls}
				variants={PATH_VARIANTS}
				x1="3"
				x2="15"
				y1="12"
				y2="12"
			/>
		</svg>
	)
);
