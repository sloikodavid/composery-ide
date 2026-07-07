"use client";

import type { Variants } from "motion/react";
import { motion } from "motion/react";
import { createAnimatedIcon, LUCIDE_SVG } from "@/components/icons/create";

const SUN_VARIANTS: Variants = {
	normal: {
		rotate: 0
	},
	animate: {
		rotate: [0, -5, 5, -2, 2, 0],
		transition: {
			duration: 1.5,
			ease: "easeInOut"
		}
	}
};

const MOON_VARIANTS: Variants = {
	normal: { opacity: 1 },
	animate: (index: number) => ({
		opacity: [0, 1],
		transition: { delay: index * 0.1, duration: 0.3 }
	})
};

const RAY_PATHS = [
	"M12 2v2",
	"M12 20v2",
	"m4.9 4.9 1.4 1.4",
	"m17.7 17.7 1.4 1.4",
	"M2 12h2",
	"M20 12h2",
	"m6.3 17.7-1.4 1.4",
	"m19.1 4.9-1.4 1.4"
];

export const SunMoonIcon = createAnimatedIcon(
	"SunMoonIcon",
	({ controls, size }) => (
		<svg {...LUCIDE_SVG} height={size} width={size}>
			<motion.g animate={controls} initial="normal" variants={SUN_VARIANTS}>
				<path d="M12 8a2.83 2.83 0 0 0 4 4 4 4 0 1 1-4-4" />
			</motion.g>
			{RAY_PATHS.map((path, index) => (
				<motion.path
					animate={controls}
					custom={index + 1}
					d={path}
					initial="normal"
					key={path}
					variants={MOON_VARIANTS}
				/>
			))}
		</svg>
	)
);
