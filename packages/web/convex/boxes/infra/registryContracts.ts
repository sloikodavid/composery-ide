import { z } from "zod";

export const registryDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const registryDescriptorSchema = z.looseObject({
	digest: registryDigestSchema,
	platform: z.looseObject({
		architecture: z.string(),
		os: z.string()
	})
});

export const registryManifestSchema = z.looseObject({
	config: z.looseObject({ digest: registryDigestSchema }).optional(),
	manifests: z.array(z.unknown()).optional()
});

export const registryConfigSchema = z.looseObject({
	config: z
		.looseObject({
			Labels: z.record(z.string(), z.unknown()).optional()
		})
		.optional()
});

export const registryTokenSchema = z.looseObject({
	access_token: z.string().optional(),
	token: z.string().optional()
});
