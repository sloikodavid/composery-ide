"use client";

import { motion } from "motion/react";
import { createAnimatedIcon } from "@/components/icons/create";

// Hetzner's round logo: the white H (wide stems, thin crossbar) cut out
// of the red disc. It spins a quarter turn on hover with the same spring as
// the other "Open in" logos.

export const HetznerIcon = createAnimatedIcon(
	"HetznerIcon",
	({ controls, size }) => (
		<motion.svg
			animate={controls}
			fill="#D50C2D"
			height={size}
			transition={{ type: "spring", stiffness: 250, damping: 25 }}
			variants={{
				normal: { rotate: "0deg" },
				animate: { rotate: "90deg" }
			}}
			viewBox="0 0 24 24"
			width={size}
			xmlns="http://www.w3.org/2000/svg"
		>
			<path
				clipRule="evenodd"
				d="M12 0a12 12 0 1 0 0 24 12 12 0 0 0 0-24ZM5.47 5.55h2.98v5.17h7.21V5.55h2.98v12.97h-2.98v-5.25H8.45v5.25H5.47z"
				fillRule="evenodd"
			/>
		</motion.svg>
	)
);
