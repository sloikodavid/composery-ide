import { clerkMiddleware } from "@clerk/nextjs/server";
import { isMarkdownPreferred, rewritePath } from "fumadocs-core/negotiation";
import { NextResponse } from "next/server";
import { parseAuthorizedParties } from "@/lib/auth-routing";
import { docsContentRoute, docsRoute } from "@/lib/docs/routes";
import { nextEnv } from "@/lib/env";

const authorizedParties = parseAuthorizedParties(
	nextEnv.CLERK_AUTHORIZED_PARTIES
);

// Serve a docs page as raw markdown to LLMs and tools: an explicit `/docs/x.md`
// suffix, or any /docs request that prefers text/markdown, rewrites to the
// generated content route. Both derive from docsRoute, so the docs base stays
// defined in exactly one place (ui/lib/docs.ts).
const { rewrite: rewriteDocs } = rewritePath(
	`${docsRoute}{/*path}`,
	`${docsContentRoute}{/*path}/content.md`
);
const { rewrite: rewriteSuffix } = rewritePath(
	`${docsRoute}{/*path}.md`,
	`${docsContentRoute}{/*path}/content.md`
);

export default clerkMiddleware(
	(_auth, request) => {
		const suffix = rewriteSuffix(request.nextUrl.pathname);
		if (suffix) {
			return NextResponse.rewrite(new URL(suffix, request.nextUrl));
		}

		if (isMarkdownPreferred(request)) {
			const result = rewriteDocs(request.nextUrl.pathname);
			if (result) {
				return NextResponse.rewrite(new URL(result, request.nextUrl));
			}
		}
	},
	{
		authorizedParties:
			authorizedParties.length > 0 ? authorizedParties : undefined
	}
);

export const config = {
	matcher: [
		"/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
		"/(api|trpc)(.*)",
		"/__clerk/(.*)"
	]
};
