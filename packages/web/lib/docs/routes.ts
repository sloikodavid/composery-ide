// Docs are mounted under /docs on the marketing site (www.composery.io/docs).
// The loader baseUrl, the proxy.ts markdown rewrites, and the app/docs route
// segment all derive from this, so the docs base lives in exactly one place.
//
// Kept apart from lib/docs/source.ts, which these feed: proxy.ts needs the routes and
// must not pull the fumadocs loader into the middleware bundle to get them.
export const docsRoute = "/docs";
export const docsImageRoute = "/og/docs";
export const docsContentRoute = "/llms.mdx/docs";
