"use client";

import type { ComponentProps } from "react";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
	AnimatedIcon,
	type AnimatedIconHandle
} from "@/components/animated-icon";
import { Button } from "@/components/base/button";
import { copyToClipboard } from "@/lib/clipboard";

type ButtonProps = ComponentProps<typeof Button>;

// How long the check stays before the copy glyph comes back.
const CHECK_MS = 1500;

// Copies a value to the clipboard. The label never changes - only the icon swaps
// to a check on success - so the button keeps its width and nothing shifts when
// clicked. Outline by default; pass-through props let callers match the
// surrounding button size/variant. For an icon-only button, pass `label=""`
// with an explicit `size`/`variant` and an `aria-label` (see `Field` in
// `ssh-dialog.tsx`) - the label survives as the accessible name.
export function CopyLinkButton({
	label = "Copy link",
	message = "Link copied",
	onBlur,
	onFocus,
	onMouseEnter,
	onMouseLeave,
	value,
	...props
}: { label?: string; message?: string; value: string } & Omit<
	ButtonProps,
	"children" | "value" | "onClick"
>) {
	const [copied, setCopied] = useState(false);
	const check = useRef<AnimatedIconHandle>(null);
	const copy = useRef<AnimatedIconHandle>(null);

	// Play the draw once the check has mounted (it replaces the copy glyph).
	useEffect(() => {
		if (copied) check.current?.startAnimation();
	}, [copied]);

	const handleFocus: NonNullable<ButtonProps["onFocus"]> = (event) => {
		if (!copied) copy.current?.startAnimation();
		onFocus?.(event);
	};

	const handleBlur: NonNullable<ButtonProps["onBlur"]> = (event) => {
		if (!copied) copy.current?.stopAnimation();
		onBlur?.(event);
	};

	const handleMouseEnter: NonNullable<ButtonProps["onMouseEnter"]> = (
		event
	) => {
		if (!copied) copy.current?.startAnimation();
		onMouseEnter?.(event);
	};

	const handleMouseLeave: NonNullable<ButtonProps["onMouseLeave"]> = (
		event
	) => {
		if (!copied) copy.current?.stopAnimation();
		onMouseLeave?.(event);
	};

	return (
		<Button
			variant="outline"
			{...props}
			onBlur={handleBlur}
			onClick={async () => {
				// The check only replaces the copy glyph on a copy that actually
				// happened; a rejected one leaves the button as it was, beside the
				// toast that says why.
				if (!(await copyToClipboard(value, message))) return;
				setCopied(true);
				setTimeout(() => setCopied(false), CHECK_MS);
			}}
			onFocus={handleFocus}
			onMouseEnter={handleMouseEnter}
			onMouseLeave={handleMouseLeave}
		>
			<span className="relative size-4 shrink-0" aria-hidden>
				<AnimatePresence initial={false}>
					<motion.span
						animate={{ opacity: 1, scale: 1, rotate: 0 }}
						className="absolute inset-0 flex items-center justify-center"
						exit={{ opacity: 0, scale: 0.78, rotate: copied ? -8 : 8 }}
						initial={{ opacity: 0, scale: 0.78, rotate: copied ? 8 : -8 }}
						key={copied ? "check" : "copy"}
						transition={{
							duration: 0.16,
							ease: [0.16, 1, 0.3, 1]
						}}
					>
						{copied ? (
							<AnimatedIcon icon="check" iconRef={check} />
						) : (
							<AnimatedIcon icon="copy" iconRef={copy} />
						)}
					</motion.span>
				</AnimatePresence>
			</span>
			{label}
		</Button>
	);
}
