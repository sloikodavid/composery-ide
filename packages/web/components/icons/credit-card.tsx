"use client";

import { motion } from "motion/react";
import type { Variants } from "motion/react";
import { createAnimatedIcon, LUCIDE_SVG } from "@/components/icons/create";

const CARD_VARIANTS: Variants = {
	normal: {
		x: 0,
		transition: {
			type: "spring",
			stiffness: 280,
			damping: 18
		}
	},
	animate: {
		x: [0, -4, 1.5, 0],
		transition: {
			duration: 0.7,
			times: [0, 0.4, 0.75, 1],
			ease: "easeInOut"
		}
	}
};

export const CreditCardIcon = createAnimatedIcon(
	"CreditCardIcon",
	({ controls, size }) => (
		<svg
			{...LUCIDE_SVG}
			className="overflow-visible"
			height={size}
			width={size}
		>
			<motion.g animate={controls} initial="normal" variants={CARD_VARIANTS}>
				<rect height="14" rx="2" width="20" x="2" y="5" />
				<line x1="2" x2="22" y1="10" y2="10" />
			</motion.g>
		</svg>
	)
);
