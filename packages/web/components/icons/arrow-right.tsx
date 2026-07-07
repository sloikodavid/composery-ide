"use client";

import { motion } from "motion/react";
import type { Variants } from "motion/react";
import { createAnimatedIcon, LUCIDE_SVG } from "@/components/icons/create";

const PATH_VARIANTS: Variants = {
	normal: { d: "M5 12h14" },
	animate: {
		d: ["M5 12h14", "M5 12h9", "M5 12h14"],
		transition: {
			duration: 0.4
		}
	}
};

const SECONDARY_PATH_VARIANTS: Variants = {
	normal: { d: "m12 5 7 7-7 7", translateX: 0 },
	animate: {
		d: "m12 5 7 7-7 7",
		translateX: [0, -3, 0],
		transition: {
			duration: 0.4
		}
	}
};

export const ArrowRightIcon = createAnimatedIcon(
	"ArrowRightIcon",
	({ controls, size }) => (
		<svg {...LUCIDE_SVG} height={size} width={size}>
			<motion.path animate={controls} d="M5 12h14" variants={PATH_VARIANTS} />
			<motion.path
				animate={controls}
				d="m12 5 7 7-7 7"
				variants={SECONDARY_PATH_VARIANTS}
			/>
		</svg>
	)
);
