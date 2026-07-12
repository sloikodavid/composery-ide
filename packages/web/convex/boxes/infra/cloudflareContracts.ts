import { z } from "zod";

export const cloudflareErrorSchema = z.looseObject({
	message: z.string()
});

export const cloudflareEnvelopeSchema = z.looseObject({
	success: z.boolean().optional(),
	errors: z.array(cloudflareErrorSchema).optional(),
	result: z.unknown().optional()
});

export const cloudflareDnsRecordSchema = z.looseObject({
	id: z.string(),
	name: z.string(),
	type: z.string(),
	content: z.string()
});

export const cloudflareDnsRecordListResponseSchema = z.looseObject({
	success: z.boolean(),
	result: z.array(cloudflareDnsRecordSchema).optional()
});
export const cloudflareDnsRecordResponseSchema = z.looseObject({
	success: z.boolean(),
	result: cloudflareDnsRecordSchema.optional()
});
export const cloudflareDeleteResultSchema = z.unknown();
export const cloudflareDeleteDnsRecordResponseSchema = z.looseObject({});

export type CloudflareDnsRecord = z.output<typeof cloudflareDnsRecordSchema>;

export const CLOUDFLARE_OPENAPI_URL =
	"https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json";

export const cloudflareResponseContracts = [
	{
		name: "list DNS records",
		method: "get",
		path: "/zones/{zone_id}/dns_records",
		status: "200",
		schema: cloudflareDnsRecordListResponseSchema
	},
	{
		name: "create a DNS record",
		method: "post",
		path: "/zones/{zone_id}/dns_records",
		status: "200",
		schema: cloudflareDnsRecordResponseSchema
	},
	{
		name: "update a DNS record",
		method: "patch",
		path: "/zones/{zone_id}/dns_records/{dns_record_id}",
		status: "200",
		schema: cloudflareDnsRecordResponseSchema
	},
	{
		name: "delete a DNS record",
		method: "delete",
		path: "/zones/{zone_id}/dns_records/{dns_record_id}",
		status: "200",
		schema: cloudflareDeleteDnsRecordResponseSchema
	}
] as const;
