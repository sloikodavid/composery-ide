"use client";

import { motion } from "motion/react";
import { createAnimatedIcon, LUCIDE_SVG } from "@/components/icons/create";

export const PlusIcon = createAnimatedIcon("PlusIcon", ({ controls, size }) => (
	<motion.svg
		{...LUCIDE_SVG}
		animate={controls}
		height={size}
		transition={{ type: "spring", stiffness: 100, damping: 15 }}
		variants={{
			normal: {
				rotate: 0
			},
			animate: {
				rotate: 180
			}
		}}
		width={size}
	>
		<path d="M5 12h14" />
		<path d="M12 5v14" />
	</motion.svg>
));
