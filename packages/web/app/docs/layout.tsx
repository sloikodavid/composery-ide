import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";
import { Footer } from "@/components/footer";
import { baseOptions } from "@/lib/docs/layout";
import { source } from "@/lib/docs/source";

// The docs subtree gets fumadocs' own chrome (sidebar, TOC, search) instead of
// the marketing Header that wraps the (site) group. RootProvider supplies the
// search/sidebar context; its theme switching is disabled so the site-wide
// next-themes provider in the root layout stays the single source of theme.
export default function Layout({ children }: { children: ReactNode }) {
	return (
		<RootProvider theme={{ enabled: false }}>
			<DocsLayout tree={source.getPageTree()} {...baseOptions()}>
				{children}
			</DocsLayout>
			<Footer />
		</RootProvider>
	);
}
