"use client";

import { motion } from "motion/react";
import type { Transition, Variants } from "motion/react";
import { createAnimatedIcon, LUCIDE_SVG } from "@/components/icons/create";

const LID_VARIANTS: Variants = {
	normal: { y: 0 },
	animate: { y: -1.1 }
};

const SPRING_TRANSITION: Transition = {
	type: "spring",
	stiffness: 500,
	damping: 30
};

export const DeleteIcon = createAnimatedIcon(
	"DeleteIcon",
	({ controls, size }) => (
		<svg {...LUCIDE_SVG} height={size} width={size}>
			<motion.g
				animate={controls}
				transition={SPRING_TRANSITION}
				variants={LID_VARIANTS}
			>
				<path d="M3 6h18" />
				<path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
			</motion.g>
			<motion.path
				animate={controls}
				d="M19 8v12c0 1-1 2-2 2H7c-1 0-2-1-2-2V8"
				transition={SPRING_TRANSITION}
				variants={{
					normal: { d: "M19 8v12c0 1-1 2-2 2H7c-1 0-2-1-2-2V8" },
					animate: { d: "M19 9v12c0 1-1 2-2 2H7c-1 0-2-1-2-2V9" }
				}}
			/>
			<motion.line
				animate={controls}
				transition={SPRING_TRANSITION}
				variants={{
					normal: { y1: 11, y2: 17 },
					animate: { y1: 11.5, y2: 17.5 }
				}}
				x1="10"
				x2="10"
				y1="11"
				y2="17"
			/>
			<motion.line
				animate={controls}
				transition={SPRING_TRANSITION}
				variants={{
					normal: { y1: 11, y2: 17 },
					animate: { y1: 11.5, y2: 17.5 }
				}}
				x1="14"
				x2="14"
				y1="11"
				y2="17"
			/>
		</svg>
	)
);
