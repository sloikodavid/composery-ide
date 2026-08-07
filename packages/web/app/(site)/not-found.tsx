import { SearchXIcon } from "lucide-react";
import { PageTemplate } from "@/components/page-template";

export default function NotFound() {
	return (
		<PageTemplate breadcrumbs={[{ icon: SearchXIcon, label: "Not found" }]}>
			<p className="text-sm text-muted-foreground">This page does not exist.</p>
		</PageTemplate>
	);
}
