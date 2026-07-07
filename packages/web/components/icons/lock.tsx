"use client";

import { motion } from "motion/react";
import { createAnimatedIcon, LUCIDE_SVG } from "@/components/icons/create";

export const LockIcon = createAnimatedIcon("LockIcon", ({ controls, size }) => (
	<motion.svg
		{...LUCIDE_SVG}
		animate={controls}
		height={size}
		initial="normal"
		transition={{
			duration: 1,
			ease: [0.4, 0, 0.2, 1]
		}}
		variants={{
			normal: {
				rotate: 0,
				scale: 1
			},
			animate: {
				rotate: [-3, 1, -2, 0],
				scale: [0.95, 1.05, 0.98, 1]
			}
		}}
		width={size}
	>
		<rect height="11" rx="2" ry="2" width="18" x="3" y="11" />
		<motion.path
			animate={controls}
			d="M7 11V7a5 5 0 0 1 10 0v4"
			initial="normal"
			transition={{
				duration: 0.3,
				ease: [0.4, 0, 0.2, 1]
			}}
			variants={{
				normal: {
					pathLength: 1
				},
				animate: {
					pathLength: 0.7
				}
			}}
		/>
	</motion.svg>
));
