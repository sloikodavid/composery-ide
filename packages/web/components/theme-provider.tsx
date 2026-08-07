"use client";

import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import type { ComponentProps } from "react";
import { useEffect } from "react";
import { syncBrowserThemeColor } from "@/lib/browser-theme";

export function ThemeProvider({
	children,
	...props
}: ComponentProps<typeof NextThemesProvider>) {
	return (
		<NextThemesProvider {...props}>
			<ResolvedThemeSync />
			{children}
		</NextThemesProvider>
	);
}

// The two things outside React's tree that have to follow the resolved theme:
// the tab icon and the browser chrome's colour. One effect, because they are one
// event - the theme settled on light or dark - and two subscriptions to the same
// value were two chances for one of them to be left behind.
//
// Nothing here watches `prefers-color-scheme`. next-themes already does, and
// re-resolves on its own while the stored choice is "system"; a second listener
// that called `setTheme("dark")` would write an explicit choice, which is both
// "stop following the system" and "discard whatever the visitor picked with the
// toggle" - the OS flipping at sunrise undid their choice.
//
// The tab icon follows the theme the moment it changes, the way github.com and
// polar.sh do it - no reload. The declared /icon.svg carries its own
// prefers-color-scheme rule, but Chromium rasterizes a favicon once per URL and
// never re-runs that query, so on its own the icon only ever catches up across a
// reload - and it could never follow a theme picked here that disagrees with the
// OS. Pointing a link at a scheme-pinned file is a new URL, which every browser
// does re-render.
//
// The page carries exactly one SVG icon link - the one Next renders from
// app/icon.svg - and this owns its href. Repointing that link rather than adding
// a second one leaves nothing to arbitrate: two candidates of the same type and
// the browser picks, which is not a thing to guess about a tab icon. The
// adaptive file it starts on is what the pre-hydration frame and a JS-less
// client get.
function ResolvedThemeSync() {
	const { resolvedTheme } = useTheme();

	useEffect(() => {
		if (resolvedTheme !== "light" && resolvedTheme !== "dark") return;

		syncBrowserThemeColor(document, resolvedTheme);

		const selector = 'link[rel="icon"][type="image/svg+xml"]';
		const link =
			document.head.querySelector<HTMLLinkElement>(selector) ??
			document.head.appendChild(
				Object.assign(document.createElement("link"), {
					rel: "icon",
					type: "image/svg+xml"
				})
			);
		// Written out rather than interpolated: these are two files in `public/`,
		// and a path assembled from a value is one no grep and no stale-path check
		// can follow back to them.
		link.href = resolvedTheme === "dark" ? "/icon-dark.svg" : "/icon-light.svg";
	}, [resolvedTheme]);

	return null;
}
