"use client";

import Link from "next/link";
import type {
	AnchorHTMLAttributes,
	ComponentProps,
	FocusEventHandler,
	MouseEventHandler,
	ReactNode,
	Ref
} from "react";
import { useRef } from "react";

import { ArrowRightIcon } from "@/components/icons/arrow-right";
import { ArrowUpRightIcon } from "@/components/icons/arrow-up-right";
import { BookOpenIcon } from "@/components/icons/book-open";
import { CheckIcon } from "@/components/icons/check";
import { ConstructionIcon } from "@/components/icons/construction";
import { ConvexIcon } from "@/components/icons/convex";
import { CopyIcon } from "@/components/icons/copy";
import { CreditCardIcon } from "@/components/icons/credit-card";
import type { AnimatedIconHandle } from "@/components/icons/create";

export type { AnimatedIconHandle };
import { DeleteIcon } from "@/components/icons/delete";
import { DownloadIcon } from "@/components/icons/download";
import { HetznerIcon } from "@/components/icons/hetzner";
import { LayoutGridIcon } from "@/components/icons/layout-grid";
import { LockIcon } from "@/components/icons/lock";
import { LogInIcon } from "@/components/icons/login";
import { PenToolIcon } from "@/components/icons/pen-tool";
import { PlayIcon } from "@/components/icons/play";
import { PlugZapIcon } from "@/components/icons/plug-zap";
import { PlusIcon } from "@/components/icons/plus";
import { PolarIcon } from "@/components/icons/polar";
import { RotateCWIcon } from "@/components/icons/rotate-cw";
import { ScanTextIcon } from "@/components/icons/scan-text";
import { SquarePenIcon } from "@/components/icons/square-pen";
import { SunMoonIcon } from "@/components/icons/sun-moon";
import { VercelIcon } from "@/components/icons/vercel";
import { WalletIcon } from "@/components/icons/wallet";
import { WashingMachineIcon } from "@/components/icons/washing-machine";
import { WrenchIcon } from "@/components/icons/wrench";
import { XIcon } from "@/components/icons/x";
import { Button } from "@/components/base/button";
import { cn } from "@/lib/utils";

// Every @lucide-animated glyph the app can name. Adding one line here updates
// the name union and makes the glyph available to every interactive caller.
const ICONS = {
	"arrow-right": ArrowRightIcon,
	"arrow-up-right": ArrowUpRightIcon,
	"book-open": BookOpenIcon,
	check: CheckIcon,
	construction: ConstructionIcon,
	convex: ConvexIcon,
	copy: CopyIcon,
	"credit-card": CreditCardIcon,
	delete: DeleteIcon,
	download: DownloadIcon,
	hetzner: HetznerIcon,
	"layout-grid": LayoutGridIcon,
	lock: LockIcon,
	login: LogInIcon,
	"pen-tool": PenToolIcon,
	play: PlayIcon,
	"plug-zap": PlugZapIcon,
	plus: PlusIcon,
	polar: PolarIcon,
	"rotate-cw": RotateCWIcon,
	"scan-text": ScanTextIcon,
	"square-pen": SquarePenIcon,
	"sun-moon": SunMoonIcon,
	vercel: VercelIcon,
	wallet: WalletIcon,
	"washing-machine": WashingMachineIcon,
	wrench: WrenchIcon,
	x: XIcon
};

export type AnimatedIconName = keyof typeof ICONS;

type AnimatedIconPosition = "start" | "end" | "only";

type SharedProps = {
	children?: ReactNode;
	icon: AnimatedIconName;
	iconClassName?: string;
	iconPosition?: AnimatedIconPosition;
	iconSize?: number;
};

type HandlerProps<T extends HTMLElement> = {
	onBlur?: FocusEventHandler<T>;
	onFocus?: FocusEventHandler<T>;
	onMouseEnter?: MouseEventHandler<T>;
	onMouseLeave?: MouseEventHandler<T>;
};

// True only when the browser would paint a focus ring (keyboard/AT focus), so
// mouse clicks and programmatic focus don't trigger the hover animation. Older
// engines that reject the selector fall back to not animating.
function isFocusVisible(element: HTMLElement) {
	try {
		return element.matches(":focus-visible");
	} catch {}
	return false;
}

// Wires a whole interactive element (link, anchor, button) to an icon's handle,
// so the icon animates while the target - not just the glyph - is hovered or
// keyboard-focused. Anything rendering an animated icon inside its own trigger
// should use this rather than repeating the four handlers.
export function useAnimatedIconHandlers<T extends HTMLElement>({
	onBlur,
	onFocus,
	onMouseEnter,
	onMouseLeave
}: HandlerProps<T>) {
	const iconRef = useRef<AnimatedIconHandle>(null);

	return {
		iconRef,
		handlers: {
			onBlur: (event) => {
				void iconRef.current?.stopAnimation();
				onBlur?.(event);
			},
			onFocus: (event) => {
				// Only animate on keyboard focus. Programmatic focus - e.g. a dialog
				// autofocusing its first button on open - would otherwise start the
				// hover animation and hold it, leaving the icon frozen mid-pose until
				// the element blurs.
				if (isFocusVisible(event.currentTarget)) {
					void iconRef.current?.startAnimation();
				}
				onFocus?.(event);
			},
			onMouseEnter: (event) => {
				void iconRef.current?.startAnimation();
				onMouseEnter?.(event);
			},
			onMouseLeave: (event) => {
				void iconRef.current?.stopAnimation();
				onMouseLeave?.(event);
			}
		} satisfies HandlerProps<T>
	};
}

// A named glyph bound to a handle. Exported for the odd trigger that lays its
// icon out itself (see StatusButton) and so still needs the ref, but not the
// start/end placement AnimatedIconContents does.
export function AnimatedIcon({
	className,
	icon,
	iconRef,
	position = "only",
	size = 16
}: {
	className?: string;
	icon: AnimatedIconName;
	iconRef: Ref<AnimatedIconHandle>;
	position?: AnimatedIconPosition;
	size?: number;
}) {
	const Glyph = ICONS[icon];

	return (
		<Glyph
			aria-hidden
			className={cn("size-4", className)}
			data-icon={position === "only" ? undefined : `inline-${position}`}
			ref={iconRef}
			size={size}
		/>
	);
}

function AnimatedIconContents({
	children,
	icon,
	iconClassName,
	iconPosition = "end",
	iconRef,
	iconSize
}: SharedProps & { iconRef: Ref<AnimatedIconHandle> }) {
	const glyph = (
		<AnimatedIcon
			className={iconClassName}
			icon={icon}
			iconRef={iconRef}
			position={iconPosition}
			size={iconSize}
		/>
	);

	return (
		<>
			{iconPosition !== "end" ? glyph : null}
			{children}
			{iconPosition === "end" ? glyph : null}
		</>
	);
}

type AnimatedIconLinkProps = ComponentProps<typeof Link> & SharedProps;

export function AnimatedIconLink({
	children,
	icon,
	iconClassName,
	iconPosition,
	iconSize,
	onBlur,
	onFocus,
	onMouseEnter,
	onMouseLeave,
	...props
}: AnimatedIconLinkProps) {
	const { handlers, iconRef } = useAnimatedIconHandlers<HTMLAnchorElement>({
		onBlur,
		onFocus,
		onMouseEnter,
		onMouseLeave
	});

	return (
		<Link {...props} {...handlers}>
			<AnimatedIconContents
				icon={icon}
				iconClassName={iconClassName}
				iconPosition={iconPosition}
				iconRef={iconRef}
				iconSize={iconSize}
			>
				{children}
			</AnimatedIconContents>
		</Link>
	);
}

type AnimatedIconAnchorProps = AnchorHTMLAttributes<HTMLAnchorElement> &
	SharedProps;

export function AnimatedIconAnchor({
	children,
	icon,
	iconClassName,
	iconPosition,
	iconSize,
	onBlur,
	onFocus,
	onMouseEnter,
	onMouseLeave,
	...props
}: AnimatedIconAnchorProps) {
	const { handlers, iconRef } = useAnimatedIconHandlers<HTMLAnchorElement>({
		onBlur,
		onFocus,
		onMouseEnter,
		onMouseLeave
	});

	return (
		<a {...props} {...handlers}>
			<AnimatedIconContents
				icon={icon}
				iconClassName={iconClassName}
				iconPosition={iconPosition}
				iconRef={iconRef}
				iconSize={iconSize}
			>
				{children}
			</AnimatedIconContents>
		</a>
	);
}

type AnimatedIconButtonProps = ComponentProps<typeof Button> & SharedProps;

export function AnimatedIconButton({
	children,
	icon,
	iconClassName,
	iconPosition,
	iconSize,
	onBlur,
	onFocus,
	onMouseEnter,
	onMouseLeave,
	...props
}: AnimatedIconButtonProps) {
	const { handlers, iconRef } = useAnimatedIconHandlers<HTMLButtonElement>({
		onBlur,
		onFocus,
		onMouseEnter,
		onMouseLeave
	});

	return (
		<Button {...props} {...handlers}>
			<AnimatedIconContents
				icon={icon}
				iconClassName={iconClassName}
				iconPosition={iconPosition}
				iconRef={iconRef}
				iconSize={iconSize}
			>
				{children}
			</AnimatedIconContents>
		</Button>
	);
}
