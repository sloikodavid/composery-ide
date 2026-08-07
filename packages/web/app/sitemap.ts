import type { MetadataRoute } from "next";
import { source } from "@/lib/docs/source";
import { WEBSITE_ORIGIN } from "shared";

// Public, indexable routes only; auth-gated surfaces (/boxes, /console) and
// utility pages stay out.
const staticRoutes = [
	"/",
	"/pricing",
	"/brand",
	"/privacy",
	"/terms",
	"/cookies",
	"/licenses"
];

export default function sitemap(): MetadataRoute.Sitemap {
	return [
		...staticRoutes.map((route) => ({ url: `${WEBSITE_ORIGIN}${route}` })),
		...source
			.getPages()
			.map((page) => ({ url: `${WEBSITE_ORIGIN}${page.url}` }))
	];
}
