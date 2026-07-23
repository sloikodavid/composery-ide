"use client";

import { ConstructionIcon } from "lucide-react";
import { PageTemplate } from "@/components/page-template";
import { Card, CardContent } from "@/components/base/card";
import { ErrorPage, type ErrorBoundaryProps } from "@/components/error-page";
import { accountBlock } from "@/lib/error-message";

// Every Convex entry point behind these pages refuses a suspended or
// mid-deletion account the same way, and says why in the same two strings (see
// `convex/users.ts` -> AccountBlock). This draws them; it never writes its own
// wording, so the card and the toast an action raises cannot disagree.
//
// Anything else is not this boundary's business, and it says so by rendering the
// shared page rather than its own copy of it - including the console.error,
// which a blocked account must not reach: it is an expected refusal, not a
// fault, and logging it would fill a support session's console with noise about
// a working system.
export default function BoxesError(props: ErrorBoundaryProps) {
	const blocked = accountBlock(props.error);
	if (!blocked) return <ErrorPage {...props} />;

	return (
		<PageTemplate
			breadcrumbs={[{ icon: ConstructionIcon, label: blocked.title }]}
		>
			<Card className="border-warning/40 bg-warning/5">
				<CardContent className="flex gap-3">
					<ConstructionIcon className="mt-0.5 size-5 shrink-0 text-warning" />
					<div className="space-y-1">
						<p className="font-medium text-foreground">{blocked.title}</p>
						<p className="text-sm text-muted-foreground">{blocked.detail}</p>
					</div>
				</CardContent>
			</Card>
		</PageTemplate>
	);
}
