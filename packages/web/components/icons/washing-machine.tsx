"use client";

import { motion } from "motion/react";
import { createAnimatedIcon, LUCIDE_SVG } from "@/components/icons/create";

export const WashingMachineIcon = createAnimatedIcon(
	"WashingMachineIcon",
	({ controls, size }) => (
		// The size- class pins the svg to its wrapper and opts it out of
		// container rules that resize bare svgs (e.g. the button variants'
		// [&_svg:not([class*='size-'])]:size-4).
		<svg {...LUCIDE_SVG} className="size-full" height={size} width={size}>
			<motion.g
				animate={controls}
				variants={{
					normal: {
						x: 0
					},
					animate: {
						x: [0, 0.5, -0.5, 0.3, -0.3, 0],
						transition: {
							duration: 0.8,
							repeat: Number.POSITIVE_INFINITY,
							ease: "easeInOut"
						}
					}
				}}
			>
				<path d="M3 6h3" />
				<path d="M17 6h.01" />
				<rect height="20" rx="2" width="18" x="3" y="2" />
			</motion.g>
			<motion.g
				animate={controls}
				variants={{
					normal: {
						rotate: 0,
						y: 0,
						transition: {
							duration: 0.5,
							ease: "linear"
						}
					},
					animate: {
						rotate: 360,
						y: [0, -0.3, 0, 0.3, 0],
						transition: {
							rotate: {
								duration: 1,
								repeat: Number.POSITIVE_INFINITY,
								ease: "linear"
							},
							y: {
								duration: 0.3,
								repeat: Number.POSITIVE_INFINITY,
								ease: "easeInOut"
							}
						}
					}
				}}
			>
				<circle cx="12" cy="13" r="5" />
				<path d="M12 18a2.5 2.5 0 0 0 0-5 2.5 2.5 0 0 1 0-5" />
			</motion.g>
		</svg>
	)
);
