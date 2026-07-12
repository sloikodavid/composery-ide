import { v } from "convex/values";
import type { z } from "zod";
import { internalAction } from "../../_generated/server";
import { requiredEnv, runtimeDomain } from "../../env";
import {
	cloudflareDeleteResultSchema,
	cloudflareDnsRecordSchema,
	cloudflareEnvelopeSchema,
	type CloudflareDnsRecord
} from "./cloudflareContracts";
import { decodeProviderResponse } from "./providerResponse";

export class CloudflareApiError extends Error {
	constructor(
		message: string,
		public readonly status: number
	) {
		super(message);
		this.name = "CloudflareApiError";
	}
}

function cloudflareHeaders() {
	return {
		Authorization: `Bearer ${requiredEnv("CLOUDFLARE_DNS_TOKEN")}`,
		"Content-Type": "application/json"
	};
}

async function cloudflareRequest<Schema extends z.ZodType>(
	path: string,
	schema: Schema,
	init?: RequestInit
): Promise<z.output<Schema>> {
	const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		...init,
		headers: {
			...cloudflareHeaders(),
			...init?.headers
		}
	});
	const text = await response.text();
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		// A gateway can return HTML. The HTTP status remains the useful error.
	}

	const envelope = cloudflareEnvelopeSchema.safeParse(body);
	if (!response.ok || (envelope.success && envelope.data.success === false)) {
		throw new CloudflareApiError(
			cloudflareErrorMessage(
				envelope.success ? envelope.data.errors : undefined,
				response.status
			),
			response.status
		);
	}

	if (!envelope.success) {
		return decodeProviderResponse("Cloudflare", schema, undefined);
	}
	return decodeProviderResponse("Cloudflare", schema, envelope.data.result);
}

// What a Cloudflare failure is called. It reports every error it was given
// because Cloudflare returns them as a list and the second one is regularly the
// one that explains the first, and it falls back to the status rather than an
// empty string: a thrown error with no message is one nobody can act on.
export function cloudflareErrorMessage(
	errors: { message?: string }[] | undefined,
	status: number
) {
	return (
		errors
			?.map((error) => error.message)
			.filter(Boolean)
			.join("; ") || `Cloudflare API ${status}.`
	);
}

export function isCloudflareNotFound(error: unknown) {
	return error instanceof CloudflareApiError && error.status === 404;
}

export type DnsRecordAction =
	| { type: "keep"; record: CloudflareDnsRecord }
	| { type: "update"; id: string }
	| { type: "create" };

// What to do about a name that may already exist, decided from what Cloudflare
// answered and nothing else.
//
// Three outcomes, and the middle one is the reason this is not just
// create-if-absent: a slug that already has an A record pointing at an old
// address must be *moved*, not duplicated. Two records for one name would have
// resolvers alternating between a live box and a dead one. A record that already
// says the right thing is left completely alone, so re-running a create - which
// is what a resumed workflow does - is free rather than another write.
export function dnsRecordAction(
	records: readonly CloudflareDnsRecord[],
	content: string
): DnsRecordAction {
	const matching = records.find((record) => record.content === content);
	if (matching) return { type: "keep", record: matching };
	const reusable = records[0];
	return reusable ? { type: "update", id: reusable.id } : { type: "create" };
}

export function dnsRecordListPath(
	zoneId: string,
	type: "A" | "AAAA",
	name: string
) {
	const params = new URLSearchParams({
		match: "all",
		"name.exact": name,
		per_page: "100",
		type
	});
	return `/zones/${zoneId}/dns_records?${params.toString()}`;
}

// Cloudflare's sentinel for "let the edge pick the TTL", not one second.
const CLOUDFLARE_AUTOMATIC_TTL = 1;

export function dnsRecordPayload(
	type: "A" | "AAAA",
	name: string,
	content: string
) {
	return {
		type,
		name,
		content,
		ttl: CLOUDFLARE_AUTOMATIC_TTL,
		proxied: false
	};
}

async function listDnsRecords(
	zoneId: string,
	type: "A" | "AAAA",
	name: string
) {
	return await cloudflareRequest(
		dnsRecordListPath(zoneId, type, name),
		cloudflareDnsRecordSchema.array()
	);
}

async function ensureDnsRecord(
	zoneId: string,
	type: "A" | "AAAA",
	name: string,
	content: string
) {
	const records = await listDnsRecords(zoneId, type, name);
	const action = dnsRecordAction(records, content);
	if (action.type === "keep") return action.record;

	const body = JSON.stringify(dnsRecordPayload(type, name, content));
	if (action.type === "update") {
		return await cloudflareRequest(
			`/zones/${zoneId}/dns_records/${action.id}`,
			cloudflareDnsRecordSchema,
			{ method: "PATCH", body }
		);
	}

	return await cloudflareRequest(
		`/zones/${zoneId}/dns_records`,
		cloudflareDnsRecordSchema,
		{ method: "POST", body }
	);
}

async function deleteCloudflareRecord(zoneId: string, id: string) {
	try {
		await cloudflareRequest(
			`/zones/${zoneId}/dns_records/${id}`,
			cloudflareDeleteResultSchema,
			{ method: "DELETE" }
		);
	} catch (error) {
		if (!isCloudflareNotFound(error)) throw error;
	}
}

export const createRuntimeDnsRecords = internalAction({
	args: {
		ipv4: v.string(),
		ipv6: v.string(),
		slug: v.string()
	},
	handler: async (_ctx, args) => {
		const zoneId = requiredEnv("CLOUDFLARE_ZONE_ID");
		const name = runtimeDomain(args.slug);
		let aRecordId: string | undefined;

		try {
			const aRecord = await ensureDnsRecord(zoneId, "A", name, args.ipv4);
			aRecordId = aRecord.id;
			const aaaaRecord = await ensureDnsRecord(zoneId, "AAAA", name, args.ipv6);

			return {
				aRecordId: aRecord.id,
				aaaaRecordId: aaaaRecord.id
			};
		} catch (error) {
			if (aRecordId) {
				await deleteCloudflareRecord(zoneId, aRecordId).catch(() => undefined);
			}
			throw error;
		}
	}
});

export const deleteRuntimeDnsRecords = internalAction({
	args: {
		aRecordId: v.optional(v.string()),
		aaaaRecordId: v.optional(v.string())
	},
	handler: async (_ctx, args) => {
		const zoneId = requiredEnv("CLOUDFLARE_ZONE_ID");
		const ids = new Set(
			[args.aRecordId, args.aaaaRecordId].filter((id): id is string =>
				Boolean(id)
			)
		);

		for (const id of ids) {
			await deleteCloudflareRecord(zoneId, id);
		}
	}
});
