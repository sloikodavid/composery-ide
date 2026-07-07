"use client";

import { motion } from "motion/react";
import type { Variants } from "motion/react";
import { createAnimatedIcon, LUCIDE_SVG } from "@/components/icons/create";

const SVG_VARIANTS: Variants = {
	normal: { rotate: 0, translateX: 0, translateY: 0 },
	animate: {
		rotate: [0, 0, 8, -3, 8, 0],
		translateY: [0, 2, 0, -1, 0]
	}
};

const PATH_VARIANTS: Variants = {
	normal: { pathLength: 1, opacity: 1, pathOffset: 0 },
	animate: {
		pathLength: [0, 0, 1],
		opacity: [0, 1],
		pathOffset: [0, 1, 0]
	}
};

export const PenToolIcon = createAnimatedIcon(
	"PenToolIcon",
	({ controls, size }) => (
		<motion.svg
			{...LUCIDE_SVG}
			animate={controls}
			height={size}
			transition={{
				duration: 1
			}}
			variants={SVG_VARIANTS}
			width={size}
		>
			<path d="M15.707 21.293a1 1 0 0 1-1.414 0l-1.586-1.586a1 1 0 0 1 0-1.414l5.586-5.586a1 1 0 0 1 1.414 0l1.586 1.586a1 1 0 0 1 0 1.414z" />
			<path d="m18 13-1.375-6.874a1 1 0 0 0-.746-.776L3.235 2.028a1 1 0 0 0-1.207 1.207L5.35 15.879a1 1 0 0 0 .776.746L13 18" />
			<motion.path
				animate={controls}
				d="m2.3 2.3 7.286 7.286"
				transition={{
					duration: 0.8
				}}
				variants={PATH_VARIANTS}
			/>
			<circle cx="11" cy="11" r="2" />
		</motion.svg>
	)
);
