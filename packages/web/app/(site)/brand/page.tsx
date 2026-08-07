import { SwatchBookIcon } from "lucide-react";
import type { Metadata } from "next";
import { BrandKit } from "./_components/brand-kit";
import { PageTemplate } from "@/components/page-template";

export const metadata: Metadata = {
	title: "Brand",
	description:
		"Download the Composery logo and icon as SVG or PNG and copy the brand colours, for articles, videos, and other coverage."
};

export default function BrandPage() {
	return (
		<PageTemplate breadcrumbs={[{ icon: SwatchBookIcon, label: "Brand" }]}>
			<BrandKit />
		</PageTemplate>
	);
}
