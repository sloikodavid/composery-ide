import type { OperationItem } from "fumadocs-openapi";
import { openapi, SPEC_ID } from "@/lib/docs/openapi";
import { OpenAPIPage } from "./openapi-page";

// Renders one operation from the spec inline, where the prose that introduces it
// already is - there is one endpoint, so a generated page tree would be a folder
// holding a single page.
export async function APIOperation(props: OperationItem) {
	const { bundled } = await openapi.getSchema(SPEC_ID);

	return <OpenAPIPage payload={{ bundled }} operations={[props]} />;
}
