"use client";

import { motion } from "motion/react";
import type { Variants } from "motion/react";
import { createAnimatedIcon, LUCIDE_SVG } from "@/components/icons/create";

const PEN_VARIANTS: Variants = {
	normal: {
		rotate: 0,
		x: 0,
		y: 0
	},
	animate: {
		rotate: [-0.5, 0.5, -0.5],
		x: [0, -1, 1.5, 0],
		y: [0, 1.5, -1, 0]
	}
};

export const SquarePenIcon = createAnimatedIcon(
	"SquarePenIcon",
	({ controls, size }) => (
		<svg
			{...LUCIDE_SVG}
			height={size}
			style={{ overflow: "visible" }}
			width={size}
		>
			<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
			<motion.path
				animate={controls}
				d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"
				variants={PEN_VARIANTS}
			/>
		</svg>
	)
);
