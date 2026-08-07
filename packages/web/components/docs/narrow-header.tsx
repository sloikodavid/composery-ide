"use client";

import { UserButton } from "@clerk/nextjs";
import { Authenticated, Unauthenticated } from "convex/react";
import { NextProvider } from "fumadocs-core/framework/next";
import {
	SidebarDrawerContent,
	SidebarDrawerOverlay,
	SidebarProvider,
	SidebarTrigger,
	SidebarViewport
} from "fumadocs-ui/components/sidebar/base";
import { buttonVariants as fdButtonVariants } from "fumadocs-ui/components/ui/button";
import { SidebarIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatedIconLink } from "@/components/animated-icon";
import { buttonVariants } from "@/components/base/button";
import { FumadocsThemeToggle } from "@/components/docs/theme-toggle";
import { GitHubLogo } from "@/components/icons/github-logo";
import { GITHUB_REPO_URL } from "@/convex/model/links";
import { Logo } from "@/components/logo";
import {
	type NavLink,
	PUBLIC_NAV_LINKS,
	useAuthedNavLinks
} from "@/lib/nav-links";
import { clerkAppearance } from "@/lib/clerk-appearance";
import { cn } from "@/lib/utils";

// fumadocs' real ghost icon button (its buttonVariants), exactly as the docs use
// it for the sidebar toggle, the drawer close, and the GitHub link.
const FUMADOCS_GHOST_ICON = fdButtonVariants({
	color: "ghost",
	size: "icon-sm",
	className: "p-2"
});

// The narrow-screen header bar, plus the drawer its trigger opens. The bar has
// to read as the same component as the docs' own narrow header (fumadocs'
// `#nd-subnav`, in dist/layouts/docs/slots/header.js), since the two alternate
// as you move between the marketing pages and the docs: same h-14, same
// px-2.5, same solid background, same Logo, and the same ghost icon button
// below. A patch pulls #nd-subnav's `ps-4 pe-2.5` to `px-2.5` to close the last
// gap - keep the two in step when either moves. Neither draws a border or a
// blur; the subnav's border-b and backdrop-blur-sm are stripped in fumadocs.css.
//
// SidebarProvider owns the drawer's open state, the responsive drawer/full
// switch (collapses on resize to desktop), and close-on-navigation;
// SidebarDrawerContent supplies the exact slide/fade. NextProvider wires the
// framework hooks it needs. All fumadocs is confined to this file so the rest
// of the app stays free of it. Narrow-gated (md:hidden) to mirror the desktop
// pill's md:flex, matching the project's narrow gate rather than a touch or
// "mobile" one.
export function FumadocsNarrowHeader() {
	const pathname = usePathname();
	const authedLinks = useAuthedNavLinks();

	// Plain icon-less rows that mirror the docs sidebar (the bar's animated icons
	// would behave differently here, and the docs sidebar has no icons).
	const row = (link: NavLink) => (
		<Link
			data-active={pathname.startsWith(link.href)}
			className={cn(
				"relative flex flex-row items-center gap-2 rounded-lg p-2 text-start text-fd-muted-foreground wrap-anywhere transition-colors hover:bg-[var(--hover)] hover:text-fd-foreground hover:transition-none data-[active=true]:bg-selected data-[active=true]:text-selected-foreground data-[active=true]:hover:transition-colors"
			)}
			href={link.href}
			key={link.href}
		>
			{link.label}
		</Link>
	);

	return (
		<NextProvider>
			<SidebarProvider>
				<div className="flex h-14 items-center bg-header px-2.5 text-header-foreground md:hidden">
					<Logo />
					<div className="flex-1" />
					<SidebarTrigger
						aria-label="Open menu"
						className={FUMADOCS_GHOST_ICON}
					>
						<SidebarIcon />
					</SidebarTrigger>
				</div>

				<SidebarDrawerOverlay className="fixed z-40 inset-0 bg-overlay data-[state=open]:animate-fd-fade-in data-[state=closed]:animate-fd-fade-out" />
				<SidebarDrawerContent className="fixed text-[0.9375rem] flex flex-col shadow-lg inset-e-0 inset-y-0 w-[85%] max-w-[380px] z-40 bg-sidebar text-sidebar-foreground data-[state=open]:animate-fd-sidebar-in data-[state=closed]:animate-fd-sidebar-out">
					<div className="flex flex-col gap-3 p-4 pb-2">
						<div className="flex items-center gap-1.5 text-fd-muted-foreground">
							<div className="flex flex-1">
								<a
									aria-label="Composery on GitHub"
									className={FUMADOCS_GHOST_ICON}
									href={GITHUB_REPO_URL}
									rel="noreferrer"
									target="_blank"
								>
									<GitHubLogo />
								</a>
							</div>
							<FumadocsThemeToggle className="p-0" />
							<SidebarTrigger
								aria-label="Close menu"
								className={FUMADOCS_GHOST_ICON}
							>
								<SidebarIcon />
							</SidebarTrigger>
						</div>
					</div>

					<SidebarViewport>
						{PUBLIC_NAV_LINKS.map(row)}
						<Authenticated>{authedLinks.map(row)}</Authenticated>
					</SidebarViewport>

					<div className="flex flex-col items-start p-4 pt-2 empty:hidden">
						<Authenticated>
							<UserButton appearance={clerkAppearance} />
						</Authenticated>
						<Unauthenticated>
							<AnimatedIconLink
								className={buttonVariants({ className: "w-full" })}
								href="/sign-in"
								icon="login"
								iconPosition="start"
							>
								Sign in
							</AnimatedIconLink>
						</Unauthenticated>
					</div>
				</SidebarDrawerContent>
			</SidebarProvider>
		</NextProvider>
	);
}
