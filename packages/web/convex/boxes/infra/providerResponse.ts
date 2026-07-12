import type { z } from "zod";

export function decodeProviderResponse<Schema extends z.ZodType>(
	provider: string,
	schema: Schema,
	value: unknown
): z.output<Schema> {
	const decoded = schema.safeParse(value);
	if (decoded.success) return decoded.data;

	const issue = decoded.error.issues[0];
	const path = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
	throw new Error(
		`Invalid ${provider} response${path}: ${issue?.message ?? "unknown value"}.`
	);
}
