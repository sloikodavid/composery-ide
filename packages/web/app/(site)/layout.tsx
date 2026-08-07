import type { ReactNode } from "react";
import { fetchQuery } from "convex/nextjs";
import { LAUNCH_DATE } from "shared";
import { Footer } from "@/components/footer";
import { Header } from "@/components/header";
import { api } from "@/convex/_generated/api";
import { ageInWords } from "@/lib/datetime";
import { CountBanner } from "./_components/count-banner";

// The marketing/app chrome: the count strip, the floating Header pill, and the
// width-constrained content column. Lives in this route group (not the root
// layout) so the /docs subtree can render full-width under fumadocs' own chrome
// instead.
export default async function SiteLayout({
	children
}: {
	children: ReactNode;
}) {
	// Read on the server so the total is in the delivered HTML rather than
	// appearing a beat after the page does. `CountBanner` subscribes to the same
	// query from the browser and takes over from here.
	const boxesCreated = await fetchQuery(api.site.stats.boxesCreated, {});
	// Measured here rather than in the browser: both sides would otherwise read
	// their own clock, and a render either side of midnight UTC would disagree on
	// the day count and be reported as a hydration error.
	const age = ageInWords(LAUNCH_DATE);

	return (
		<div className="flex min-h-screen flex-col">
			{/* Above the header, and in normal flow rather than sticky with it: the
			    strip is read once when the page opens, while the header is what a reader needs
			    back at any scroll position. */}
			<CountBanner age={age} initial={boxesCreated} />
			<Header />
			{/* min-h-screen (not flex-1) so the content always fills the viewport
			    and the footer sits below the fold on every page, not just tall ones. */}
			<main className="mx-auto min-h-screen w-full max-w-6xl px-4 py-6 sm:px-6">
				{children}
			</main>
			<Footer />
		</div>
	);
}
