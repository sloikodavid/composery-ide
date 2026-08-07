"use client";

import { UserButton } from "@clerk/nextjs";
import { Authenticated, Unauthenticated } from "convex/react";
import { usePathname } from "next/navigation";
import { AnimatedIconLink } from "@/components/animated-icon";
import { buttonVariants } from "@/components/base/button";
import { FumadocsNarrowHeader } from "@/components/docs/narrow-header";
import { Logo } from "@/components/logo";
import {
	type NavLink,
	PUBLIC_NAV_LINKS,
	useAuthedNavLinks
} from "@/lib/nav-links";
import { ThemeToggle } from "@/components/theme-toggle";
import { headerUserButtonAppearance } from "@/lib/clerk-appearance";
import { cn } from "@/lib/utils";

export function Header() {
	const pathname = usePathname();
	const authedLinks = useAuthedNavLinks();

	// `fade` eases the auth-only links in once auth resolves, so they don't pop.
	const pill = (link: NavLink, fade: boolean) => (
		<AnimatedIconLink
			className={cn(
				buttonVariants({ size: "nav", variant: "ghost" }),
				pathname.startsWith(link.href)
					? "bg-selected text-selected-foreground"
					: "text-muted-foreground",
				fade && "header-auth-fade-in"
			)}
			href={link.href}
			icon={link.icon}
			iconPosition="start"
			key={link.href}
		>
			{link.label}
		</AnimatedIconLink>
	);

	return (
		<header className="sticky top-0 z-40 bg-header text-header-foreground">
			{/* Desktop: the full-width bar. */}
			{/* Three columns rather than a flex row: the equal `1fr` sides centre the
			    nav on the bar itself, so it stays put no matter how much wider the
			    auth cluster is than the logo. `justify-between` would only centre it
			    if the two sides happened to match. */}
			<div className="mx-auto hidden h-14 w-full max-w-7xl grid-cols-[1fr_auto_1fr] items-center gap-6 px-4 sm:px-6 md:grid">
				{/* Grid items stretch by default, which would leave the logo's link box
				    spanning the whole column. */}
				<Logo className="justify-self-start" />

				<nav className="flex min-w-0 items-center gap-1">
					{PUBLIC_NAV_LINKS.map((link) => pill(link, false))}
					<Authenticated>
						{authedLinks.map((link) => pill(link, true))}
					</Authenticated>
				</nav>

				<div className="flex items-center justify-end gap-2">
					<ThemeToggle />
					<Authenticated>
						{/* Fixed footprint so the row displaces once when auth resolves;
						    Clerk mounting inside it a beat later can't shift it again. */}
						<div className="header-auth-fade-in size-8">
							<UserButton appearance={headerUserButtonAppearance} />
						</div>
					</Authenticated>
					<Unauthenticated>
						<AnimatedIconLink
							className={cn("header-auth-fade-in", buttonVariants())}
							href="/sign-in"
							icon="login"
							iconPosition="start"
						>
							Sign in
						</AnimatedIconLink>
					</Unauthenticated>
				</div>
			</div>

			{/* Narrow screens: the bar that replaces this pill, matching the docs'
			    own narrow header. Isolated in its own component. */}
			<FumadocsNarrowHeader />
		</header>
	);
}
