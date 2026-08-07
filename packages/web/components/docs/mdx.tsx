import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { APIOperation } from "./openapi-operation";

export function getMDXComponents(components?: MDXComponents) {
	return {
		...defaultMdxComponents,
		APIOperation,
		...components
	} satisfies MDXComponents;
}

declare global {
	type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
