"use client";

import { useAnimation } from "motion/react";
import type { HTMLAttributes, ReactNode } from "react";
import {
	forwardRef,
	useCallback,
	useId,
	useImperativeHandle,
	useRef
} from "react";

import { cn } from "@/lib/utils";

type Controls = ReturnType<typeof useAnimation>;

export type AnimatedIconHandle = {
	startAnimation: () => void | Promise<void>;
	stopAnimation: () => void | Promise<void>;
};

type AnimatedIconProps = HTMLAttributes<HTMLDivElement> & {
	size?: number;
};

// The props every lucide glyph's <svg> carries. Brand logos (Convex, Polar, ...)
// are filled artwork on their own grid and set these themselves.
export const LUCIDE_SVG = {
	fill: "none",
	stroke: "currentColor",
	strokeLinecap: "round",
	strokeLinejoin: "round",
	strokeWidth: "2",
	viewBox: "0 0 24 24",
	xmlns: "http://www.w3.org/2000/svg"
} as const;

// Every icon in this folder is the same component with a different <svg> body:
// a wrapper that animates itself on hover, unless a parent claims the handle -
// then the parent drives the animation and the local hover handlers are handed
// straight back so the parent's own onMouseEnter/onMouseLeave still fire.
//
// `render` receives a `useId()` value for icons that need document-unique ids
// (a <pattern>, a <mask>): two copies on one page must not share one `url(#id)`.
export function createAnimatedIcon(
	displayName: string,
	render: (context: {
		controls: Controls;
		id: string;
		size: number;
	}) => ReactNode,
	{
		start = (controls) => controls.start("animate"),
		stop = (controls) => controls.start("normal")
	}: {
		start?: (controls: Controls) => void | Promise<void>;
		stop?: (controls: Controls) => void | Promise<void>;
	} = {}
) {
	const Icon = forwardRef<AnimatedIconHandle, AnimatedIconProps>(
		({ className, onMouseEnter, onMouseLeave, size = 28, ...props }, ref) => {
			const controls = useAnimation();
			const id = useId();
			const isControlled = useRef(false);

			useImperativeHandle(ref, () => {
				isControlled.current = true;

				return {
					startAnimation: () => start(controls),
					stopAnimation: () => stop(controls)
				};
			});

			const handleMouseEnter = useCallback(
				(event: React.MouseEvent<HTMLDivElement>) => {
					if (isControlled.current) onMouseEnter?.(event);
					else void start(controls);
				},
				[controls, onMouseEnter]
			);

			const handleMouseLeave = useCallback(
				(event: React.MouseEvent<HTMLDivElement>) => {
					if (isControlled.current) onMouseLeave?.(event);
					else void stop(controls);
				},
				[controls, onMouseLeave]
			);

			return (
				<div
					className={cn(className)}
					onMouseEnter={handleMouseEnter}
					onMouseLeave={handleMouseLeave}
					{...props}
				>
					{render({ controls, id, size })}
				</div>
			);
		}
	);

	Icon.displayName = displayName;

	return Icon;
}
