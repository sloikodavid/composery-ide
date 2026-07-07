"use client";

import { motion } from "motion/react";
import type { Variants } from "motion/react";
import { createAnimatedIcon, LUCIDE_SVG } from "@/components/icons/create";

const RECT_1_VARIANTS: Variants = {
	normal: { translateX: 0, translateY: 0 },
	animate: {
		translateX: [0, 11, 11, 0],
		translateY: [0, 0, 0, 0],
		transition: { duration: 0.8, ease: "easeInOut", times: [0, 0.4, 0.6, 1] }
	}
};

const RECT_2_VARIANTS: Variants = {
	normal: { translateX: 0, translateY: 0 },
	animate: {
		translateX: [0, 0, 0, 0],
		translateY: [0, 11, 11, 0],
		transition: { duration: 0.8, ease: "easeInOut", times: [0, 0.4, 0.6, 1] }
	}
};

const RECT_3_VARIANTS: Variants = {
	normal: { translateX: 0, translateY: 0 },
	animate: {
		translateX: [0, -11, -11, 0],
		translateY: [0, 0, 0, 0],
		transition: { duration: 0.8, ease: "easeInOut", times: [0, 0.4, 0.6, 1] }
	}
};

const RECT_4_VARIANTS: Variants = {
	normal: { translateX: 0, translateY: 0 },
	animate: {
		translateX: [0, 0, 0, 0],
		translateY: [0, -11, -11, 0],
		transition: { duration: 0.8, ease: "easeInOut", times: [0, 0.4, 0.6, 1] }
	}
};

export const LayoutGridIcon = createAnimatedIcon(
	"LayoutGridIcon",
	({ controls, size }) => (
		<svg {...LUCIDE_SVG} height={size} width={size}>
			<motion.rect
				animate={controls}
				height="7"
				initial="normal"
				rx="1"
				variants={RECT_1_VARIANTS}
				width="7"
				x="3"
				y="3"
			/>
			<motion.rect
				animate={controls}
				height="7"
				initial="normal"
				rx="1"
				variants={RECT_2_VARIANTS}
				width="7"
				x="14"
				y="3"
			/>
			<motion.rect
				animate={controls}
				height="7"
				initial="normal"
				rx="1"
				variants={RECT_3_VARIANTS}
				width="7"
				x="14"
				y="14"
			/>
			<motion.rect
				animate={controls}
				height="7"
				initial="normal"
				rx="1"
				variants={RECT_4_VARIANTS}
				width="7"
				x="3"
				y="14"
			/>
		</svg>
	)
);
