import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/base/sonner";
import { BROWSER_THEME_COLORS } from "@/lib/browser-theme";
import { cn } from "@/lib/utils";
import { inter } from "./fonts";
import { Providers } from "./providers";
import { APP_DESCRIPTION, WEBSITE_ORIGIN } from "shared";
import "./globals.css";

export const metadata: Metadata = {
	metadataBase: new URL(WEBSITE_ORIGIN),
	title: {
		default: "Composery: like VS Code, but always on",
		template: "%s - Composery"
	},
	description: APP_DESCRIPTION,
	alternates: { canonical: "./" },
	openGraph: {
		siteName: "Composery",
		type: "website",
		url: "./"
	}
};

// The browser chrome meets the structural surface touching the top edge. This
// is derived from the same editable header roles as the rendered headers, so a
// palette save cannot leave mobile Safari/Chrome wearing the previous colour.
export const viewport: Viewport = {
	colorScheme: "light dark",
	themeColor: [
		{
			media: "(prefers-color-scheme: light)",
			color: BROWSER_THEME_COLORS.light
		},
		{
			media: "(prefers-color-scheme: dark)",
			color: BROWSER_THEME_COLORS.dark
		}
	]
};

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html
			className={cn("antialiased", inter.variable)}
			lang="en"
			suppressHydrationWarning
		>
			<body>
				<ThemeProvider
					attribute="class"
					defaultTheme="system"
					disableTransitionOnChange
					enableSystem
				>
					{/* The marketing/app chrome (Header + width-constrained main) lives
					    in the (site) route group; the /docs subtree gets fumadocs' own
					    chrome instead. Everything else here is genuinely app-wide. */}
					<Providers>
						{children}
						<Toaster />
					</Providers>
				</ThemeProvider>
				{/* Both are cookieless and privacy-first, so no consent banner is
				    required (we set only Clerk's strictly-necessary auth cookies).
				    Auto no-op off Vercel; only beacon in production. */}
				<Analytics />
				<SpeedInsights />
			</body>
		</html>
	);
}
