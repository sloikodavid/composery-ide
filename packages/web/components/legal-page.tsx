import type { ReactNode } from "react";
import { ScaleIcon } from "lucide-react";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle
} from "@/components/base/card";
import { PageTemplate } from "@/components/page-template";
import { legalUpdatedLabel } from "@/convex/model/legal";

export function LegalPage({
	title,
	children
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<PageTemplate breadcrumbs={[{ icon: ScaleIcon, label: title }]}>
			<article className="space-y-4 text-sm leading-6 text-muted-foreground">
				<p>Last updated: {legalUpdatedLabel()}</p>
				{children}
			</article>
		</PageTemplate>
	);
}

export function LegalSection({
	title,
	children
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>{title}</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3 leading-6 text-muted-foreground">
				{children}
			</CardContent>
		</Card>
	);
}
