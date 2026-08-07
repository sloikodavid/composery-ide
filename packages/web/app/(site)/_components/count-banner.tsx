"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

// The strip above the header: how old Composery is, and how many boxes it has
// created.
//
// The two facts are printed together because neither says much alone. A count on
// its own invites the reader to decide whether it is a lot, and early on the
// answer is no; beside an age it is a rate, and a young project with boxes on it
// is the thing actually worth reporting. It also means the strip never has to be
// rewritten as the numbers grow - the same sentence reads correctly at three
// days and at three years.
//
// The count is subscribed rather than read once, so it rises while the page is
// open instead of only between visits. The layout already read the same query on
// the server and passes it as `initial`, which is what the delivered HTML
// carries: a visitor with no JavaScript, and a crawler, still get the number,
// and there is no moment where the strip is blank or holds a placeholder.
//
// Deliberately not a link. It is the one thing on the page making a claim rather
// than an offer, and a third call to action above the header would leave the
// strip competing with the two buttons already below it.
export function CountBanner({
	age,
	initial
}: {
	age: string;
	initial: number;
}) {
	const created = useQuery(api.site.stats.boxesCreated) ?? initial;

	return (
		<div className="w-full bg-primary-button text-primary-button-foreground">
			<p className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-x-1.5 px-4 py-2 text-center text-sm font-medium sm:px-6">
				<span>Composery is {age}</span>
				{/* No boxes yet is not a fact worth publishing, and "0 boxes created"
				    is the one reading of this strip that argues against the product.
				    The age alone is still true and still says the right thing. */}
				{created > 0 && (
					<span>
						<span aria-hidden="true">&mdash; </span>
						<span className="tabular-nums">
							{created.toLocaleString("en-US")}
						</span>{" "}
						boxes created
					</span>
				)}
			</p>
		</div>
	);
}
