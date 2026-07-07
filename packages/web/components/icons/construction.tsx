"use client";

import { motion } from "motion/react";
import { createAnimatedIcon, LUCIDE_SVG } from "@/components/icons/create";

export const ConstructionIcon = createAnimatedIcon(
	"ConstructionIcon",
	({ controls, id, size }) => (
		<svg {...LUCIDE_SVG} height={size} width={size}>
			<defs>
				<motion.pattern
					animate={controls}
					height="14"
					id={id}
					initial="normal"
					patternUnits="userSpaceOnUse"
					variants={{
						normal: {
							x: 0
						},
						animate: {
							x: [0, 6],
							transition: {
								duration: 1,
								ease: "linear",
								repeat: Number.POSITIVE_INFINITY,
								repeatType: "loop"
							}
						}
					}}
					width="6"
				>
					<path d="M-4 -2 L14 30" stroke="currentColor" strokeWidth="2" />
				</motion.pattern>
			</defs>
			<rect fill={`url(#${id})`} height="8" rx="1" width="20" x="2" y="6" />
			<path d="M17 14v7" />
			<path d="M7 14v7" />
			<path d="M17 3v3" />
			<path d="M7 3v3" />
		</svg>
	)
);
