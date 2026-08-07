import { createOpenAPI } from "fumadocs-openapi/server";

// The spec sits beside the pages it documents, in the same sibling `docs/` root
// source.config.ts loads them from, so the two move together.
export const openapi = createOpenAPI({
	input: { instance: "../../docs/openapi.yaml" }
});

export const SPEC_ID = "instance";

// A page renders an endpoint by dropping this into the Markdown. It is a
// component, so anything reading the page as plain Markdown - `llms.txt`, the
// copy button, `content.md` - sees an inert tag unless it substitutes something.
// Global: a page carries one of these per operation, and replacing only the
// first leaves the rest as tags nobody renders.
export const API_OPERATION =
	/^<APIOperation path="([^"]+)" method="(\w+)" \/>$/gm;
