"use client";

import type { Variants } from "motion/react";
import { motion } from "motion/react";
import { createAnimatedIcon, LUCIDE_SVG } from "@/components/icons/create";

const FRAME_VARIANTS: Variants = {
	visible: { opacity: 1 },
	hidden: { opacity: 1 }
};

const LINE_VARIANTS: Variants = {
	visible: { pathLength: 1, opacity: 1 },
	hidden: { pathLength: 0, opacity: 0 }
};

// The lines wipe out and back in rather than toggling between two poses, so this
// icon drives its controls directly instead of naming a variant.
function sweep(pathLength: number, opacity: number) {
	return (index: number) => ({
		pathLength,
		opacity,
		transition: { delay: index * 0.1, duration: 0.3 }
	});
}

export const ScanTextIcon = createAnimatedIcon(
	"ScanTextIcon",
	({ controls, size }) => (
		<svg {...LUCIDE_SVG} height={size} width={size}>
			<motion.path d="M3 7V5a2 2 0 0 1 2-2h2" variants={FRAME_VARIANTS} />
			<motion.path d="M17 3h2a2 2 0 0 1 2 2v2" variants={FRAME_VARIANTS} />
			<motion.path d="M21 17v2a2 2 0 0 1-2 2h-2" variants={FRAME_VARIANTS} />
			<motion.path d="M7 21H5a2 2 0 0 1-2-2v-2" variants={FRAME_VARIANTS} />
			{["M7 8h8", "M7 12h10", "M7 16h6"].map((path, index) => (
				<motion.path
					animate={controls}
					custom={index}
					d={path}
					initial="visible"
					key={path}
					variants={LINE_VARIANTS}
				/>
			))}
		</svg>
	),
	{
		start: async (controls) => {
			await controls.start(sweep(0, 0));
			await controls.start(sweep(1, 1));
		},
		stop: (controls) => controls.start("visible")
	}
);
