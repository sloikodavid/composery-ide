"use client";

import { ContextMenu } from "@base-ui/react/context-menu";
import {
	ArrowUpRightIcon,
	CopyIcon,
	ExternalLinkIcon,
	LinkIcon
} from "lucide-react";
import { useTheme } from "next-themes";
import Link from "next/link";
import { type ComponentProps, type ReactNode, useId } from "react";
import { BRAND_ASSETS, copySvg } from "@/lib/brand-assets";
import { copyToClipboard } from "@/lib/clipboard";
import { LOGO_INNER, LOGO_VIEWBOX } from "@/lib/logo-data";
import { cn } from "@/lib/utils";

// The plain logo - just an inline SVG. The /brand previews use this directly
// and keep the browser's native right-click. The brand menu lives on LogoMenu,
// wrapped only around the real clickable logo below.
export function BrandLogo({ className }: { className?: string }) {
	const holesId = useId().replace(/[^A-Za-z0-9_-]/g, "");
	const inner = LOGO_INNER.replaceAll("composery-logo-icon-holes", holesId);

	return (
		<svg
			aria-hidden
			className={className}
			dangerouslySetInnerHTML={{ __html: inner }}
			fill="none"
			viewBox={LOGO_VIEWBOX}
			xmlns="http://www.w3.org/2000/svg"
		/>
	);
}

// ponytail: this menu styling mirrors dropdown-menu.tsx on purpose - it's the
// single logo right-click menu, so it's inlined rather than extracted.
const MENU_POPUP =
	"z-50 min-w-44 origin-(--transform-origin) rounded-2xl bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/5 outline-none dark:ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";
const MENU_ITEM =
	"flex min-h-7 cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 text-sm no-underline outline-hidden select-none focus:bg-selected focus:text-selected-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

// Right-click the real logo to copy the logo or icon as SVG or jump to the brand page,
// instead of the browser's native "save image" menu.
function LogoMenu({ children }: { children: ReactNode }) {
	const { resolvedTheme } = useTheme();
	// Copy the variant that matches what's on screen (white on dark, black on light).
	const assets = BRAND_ASSETS[resolvedTheme === "dark" ? "dark" : "light"];

	const copyLink = () =>
		void copyToClipboard(window.location.origin, "Link copied");

	return (
		<ContextMenu.Root>
			<ContextMenu.Trigger className="inline-flex">
				{children}
			</ContextMenu.Trigger>
			<ContextMenu.Portal>
				<ContextMenu.Positioner className="isolate z-50 outline-none">
					{/* The popup renders in a portal, but React events still bubble up the
					    component tree - into the <Link> the logo sits in - so a menu click
					    would navigate home. Stop the click here. */}
					<ContextMenu.Popup
						className={MENU_POPUP}
						onClick={(event) => event.stopPropagation()}
					>
						<ContextMenu.Item
							className={MENU_ITEM}
							onClick={() => window.open("/", "_blank", "noopener")}
						>
							<ExternalLinkIcon />
							Open in new tab
						</ContextMenu.Item>
						<ContextMenu.Item className={MENU_ITEM} onClick={copyLink}>
							<LinkIcon />
							Copy link
						</ContextMenu.Item>
						<ContextMenu.Separator className="-mx-1 my-1 h-px bg-border/50" />
						<ContextMenu.Item
							className={MENU_ITEM}
							onClick={() => copySvg(assets.logo)}
						>
							<CopyIcon />
							Copy logo SVG
						</ContextMenu.Item>
						<ContextMenu.Item
							className={MENU_ITEM}
							onClick={() => copySvg(assets.icon)}
						>
							<CopyIcon />
							Copy icon SVG
						</ContextMenu.Item>
						<ContextMenu.Separator className="-mx-1 my-1 h-px bg-border/50" />
						<ContextMenu.LinkItem
							className={MENU_ITEM}
							closeOnClick
							render={<Link href="/brand" />}
						>
							<ArrowUpRightIcon />
							Brand assets
						</ContextMenu.LinkItem>
					</ContextMenu.Popup>
				</ContextMenu.Positioner>
			</ContextMenu.Portal>
		</ContextMenu.Root>
	);
}

// The one logo link, for every surface: site header, footer, and both fumadocs
// nav slots. `size` picks the logo's height - only the footer differs, since
// it's a brand block rather than a fixed-height bar. Remaining props land on the
// link, which is what the fumadocs nav-title slot needs: it passes a `me-auto`
// that keeps the sidebar collapse button pushed to the end.
export function Logo({
	className,
	size = "h-9",
	...props
}: ComponentProps<"a"> & { size?: string }) {
	return (
		<Link
			{...props}
			aria-label="Composery"
			href="/"
			className={cn(
				// Fade with opacity, not a translucent currentColor: the logo's icon
				// paints fill and stroke in the same paint, so a per-shape alpha
				// composites them twice and the stroke shows through as a seam. Opacity
				// composites the whole logo once (same as auth.css's .auth-logo-link).
				"inline-flex text-foreground transition-opacity hover:opacity-80",
				className
			)}
		>
			<LogoMenu>
				<BrandLogo className={cn(size, "w-auto")} />
			</LogoMenu>
		</Link>
	);
}
