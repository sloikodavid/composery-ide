import { docs } from "collections/server";
import { loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/lucide-icons";
import { API_OPERATION, openapi, SPEC_ID } from "./openapi";
import { docsContentRoute, docsImageRoute, docsRoute } from "./routes";

export const source = loader({
	baseUrl: docsRoute,
	source: docs.toFumadocsSource(),
	plugins: [lucideIconsPlugin()]
});

export function getPageImage(page: (typeof source)["$inferPage"]) {
	const segments = [...page.slugs, "image.png"];

	return {
		segments,
		url: `${docsImageRoute}/${segments.join("/")}`
	};
}

export function getPageMarkdownUrl(page: (typeof source)["$inferPage"]) {
	const segments = [...page.slugs, "content.md"];

	return {
		segments,
		url: `${docsContentRoute}/${segments.join("/")}`
	};
}

export async function getLLMText(page: (typeof source)["$inferPage"]) {
	let processed = await page.data.getText("processed");

	// The endpoint reference is a rendered component, so a plain-Markdown reader
	// would get a tag where each endpoint should be. Those readers are machines:
	// leave the method and path in place so the prose around them still refers to
	// something, and hand over the whole spec once at the end.
	// `includes` rather than `.test()` - API_OPERATION is global, and a global
	// regex carries `lastIndex` between calls.
	if (processed.includes("<APIOperation")) {
		const { bundled } = await openapi.getSchema(SPEC_ID);
		const body = processed.replace(
			API_OPERATION,
			(_tag, path: string, method: string) =>
				`\`${method.toUpperCase()} ${path}\``
		);

		processed = `${body}\n\n## OpenAPI\n\n\`\`\`json\n${JSON.stringify(bundled, null, 2)}\n\`\`\``;
	}

	return `# ${page.data.title} (${page.url})

${processed}`;
}
