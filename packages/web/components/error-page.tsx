"use client";

import { TriangleAlertIcon } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/base/button";
import { PageTemplate } from "@/components/page-template";

// What Next hands an `error.tsx`.
export type ErrorBoundaryProps = {
	error: Error & { digest?: string };
	reset: () => void;
};

// What a route boundary shows for a failure it has nothing specific to say
// about.
//
// Shared because a boundary that recognises one particular error still has to
// handle every other one, and `app/(site)/boxes/error.tsx` handled them by
// pasting this page - down to the console.error and the sentence - which is how
// the two came to be two things that have to be kept the same.
export function ErrorPage({ error, reset }: ErrorBoundaryProps) {
	useEffect(() => {
		console.error(error);
	}, [error]);

	return (
		<PageTemplate
			actions={<Button onClick={reset}>Try again</Button>}
			breadcrumbs={[{ icon: TriangleAlertIcon, label: "Something went wrong" }]}
		>
			<p className="text-sm text-muted-foreground">
				The page failed to load. Try again, or come back in a moment.
			</p>
		</PageTemplate>
	);
}
