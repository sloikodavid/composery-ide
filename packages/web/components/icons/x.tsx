"use client";

import { motion } from "motion/react";
import type { Variants } from "motion/react";
import { createAnimatedIcon, LUCIDE_SVG } from "@/components/icons/create";

const PATH_VARIANTS: Variants = {
	normal: {
		opacity: 1,
		pathLength: 1
	},
	animate: {
		opacity: [0, 1],
		pathLength: [0, 1]
	}
};

export const XIcon = createAnimatedIcon("XIcon", ({ controls, size }) => (
	<svg {...LUCIDE_SVG} height={size} width={size}>
		<motion.path
			animate={controls}
			d="M18 6 6 18"
			initial="normal"
			variants={PATH_VARIANTS}
		/>
		<motion.path
			animate={controls}
			d="m6 6 12 12"
			initial="normal"
			transition={{ delay: 0.2 }}
			variants={PATH_VARIANTS}
		/>
	</svg>
));
