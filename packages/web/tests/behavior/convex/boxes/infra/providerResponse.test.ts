import { z } from "zod";
import { describe, expect, test } from "vitest";
import { decodeProviderResponse } from "@/convex/boxes/infra/providerResponse";

describe("decoding a provider response", () => {
	const schema = z.looseObject({ resource: z.looseObject({ id: z.number() }) });

	test("returns the validated value and allows additive fields", () => {
		expect(
			decodeProviderResponse("Example", schema, {
				resource: { id: 42, added_later: true },
				new_envelope_field: "kept"
			})
		).toMatchObject({ resource: { id: 42, added_later: true } });
	});

	test("names the provider and field when a consumed value changes", () => {
		expect(() =>
			decodeProviderResponse("Example", schema, {
				resource: { resource_id: 42 }
			})
		).toThrow("Invalid Example response at resource.id");
	});
});
