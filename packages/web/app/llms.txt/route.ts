import { source } from "@/lib/docs/source";
import { llms } from "fumadocs-core/source";

export const revalidate = false;

// Generated from the docs source so the AI-readable index can't drift from the
// actual pages. Replaces a hand-written index that had to be remembered.
export function GET() {
	return new Response(llms(source).index());
}
