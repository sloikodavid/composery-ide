"use client";

import { motion } from "motion/react";
import type { Variants } from "motion/react";
import { createAnimatedIcon, LUCIDE_SVG } from "@/components/icons/create";

const PATH_VARIANTS: Variants = {
	normal: {
		x: 0,
		rotate: 0
	},
	animate: {
		x: [0, -1, 2, 0],
		rotate: [0, -10, 0, 0],
		transition: {
			duration: 0.5,
			times: [0, 0.2, 0.5, 1],
			stiffness: 260,
			damping: 20
		}
	}
};

export const PlayIcon = createAnimatedIcon("PlayIcon", ({ controls, size }) => (
	<motion.svg {...LUCIDE_SVG} height={size} width={size}>
		<motion.polygon
			animate={controls}
			points="6 3 20 12 6 21 6 3"
			variants={PATH_VARIANTS}
		/>
	</motion.svg>
));
