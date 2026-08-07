import type { MetadataRoute } from "next";
import { WEBSITE_ORIGIN } from "shared";

// Allow crawling everything by default; keep auth-gated app surfaces out.
// /docs/developing is deliberately absent: those pages now 404, and a Disallow
// would stop crawlers seeing the 404 that drops them from the index.
export default function robots(): MetadataRoute.Robots {
	return {
		rules: [
			{
				userAgent: "*",
				disallow: ["/boxes", "/console", "/sign-in", "/api/"]
			}
		],
		sitemap: `${WEBSITE_ORIGIN}/sitemap.xml`
	};
}
