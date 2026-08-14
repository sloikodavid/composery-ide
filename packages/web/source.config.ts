import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { SHIKI_THEMES } from "shared";

// `dir` points to the repo's sibling `docs/`; next.config turbopack.root must widen to match.
// `docs/developing/` is contributor runbooks, not product documentation - it stays in the repo
// and renders on GitHub, and is excluded here so it never reaches the site, sidebar, or indexes.
export const docs = defineDocs({
	dir: "../../docs",
	docs: {
		files: ["**/*.{md,mdx}", "!developing/**"],
		schema: pageSchema,
		postprocess: {
			includeProcessedMarkdown: true
		}
	},
	meta: {
		files: ["**/*.json", "!developing/**"],
		schema: metaSchema
	}
});

// The code-highlight themes come from shared, derived from the same palette the
// site's surfaces are built on, so docs code wears the brand colours instead of
// shiki's stock github pair. See packages/shared/shiki.ts.
export default defineConfig({
	mdxOptions: {
		rehypeCodeOptions: {
			themes: SHIKI_THEMES
		}
	}
});
