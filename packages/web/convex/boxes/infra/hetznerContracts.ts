import { z } from "zod";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ip = z.looseObject({ id: id.optional(), ip: z.string() });
const location = z.looseObject({ name: z.string() });
const serverType = z.looseObject({ name: z.string() });

export const hetznerActionSchema = z.looseObject({
	id,
	status: z.string(),
	error: z.looseObject({ code: z.string(), message: z.string() }).nullable()
});

export const hetznerServerSchema = z.looseObject({
	id,
	name: z.string(),
	rescue_enabled: z.boolean().optional(),
	status: z.string(),
	created: z.string(),
	// Bytes this server has sent, and bytes its plan includes, for the provider's
	// current billing period. Optional because every other reader of this schema
	// wants an address or a status and must not start failing if the provider ever
	// stops sending a counter - the usage sweep is the one caller that needs
	// them, and it says so by refusing to record a sample without both.
	//
	// Whole bytes, as the provider declares them. `int` rather than `number` is
	// what `system:providers` compares: it reads both schemas as JSON Schema and
	// matches type names, where Hetzner's "integer" is not the "number" a bare
	// `z.number()` emits. It also states the safe-integer ceiling this side has
	// and their int64 does not.
	outgoing_traffic: z.number().int().nullable().optional(),
	included_traffic: z.number().int().nullable().optional(),
	public_net: z.looseObject({
		ipv4: ip.nullable(),
		ipv6: ip.nullable()
	}),
	server_type: serverType,
	location
});

export const hetznerImageSchema = z.looseObject({
	id,
	type: z.string(),
	status: z.string(),
	image_size: z.number().nullable(),
	disk_size: z.number(),
	created: z.string(),
	description: z.string(),
	labels: z.record(z.string(), z.string()),
	bound_to: id.nullable(),
	created_from: z.looseObject({ id, name: z.string() }).nullable()
});

export const hetznerPrimaryIpSchema = z.looseObject({
	id,
	created: z.string(),
	ip: z.string().optional(),
	assignee_id: id.nullable()
});

const paginationSchema = z.looseObject({
	meta: z.looseObject({
		pagination: z.looseObject({
			next_page: id.nullable()
		})
	})
});

export const hetznerServerResponseSchema = z.looseObject({
	server: hetznerServerSchema.optional()
});
export const hetznerServerListResponseSchema = z.looseObject({
	servers: z.array(hetznerServerSchema)
});
export const hetznerPagedServerListResponseSchema = z.intersection(
	hetznerServerListResponseSchema,
	paginationSchema
);
const hetznerServerSummarySchema = z.looseObject({
	id,
	name: z.string().optional(),
	created: z.string(),
	// The machine's type and what it includes, for the daily audit that asks
	// whether a plan sells more traffic than the machine under it comes with.
	// Optional for the same reason the server schema's counters are: every other
	// reader of this feed wants an id and an age, and reconciliation must not stop
	// reclaiming leaked resources because the provider changed a field the audit
	// wanted.
	server_type: z.looseObject({ name: z.string() }).optional(),
	included_traffic: z.number().int().nullable().optional()
});
export const hetznerPagedServerSummariesResponseSchema = z.intersection(
	z.looseObject({ servers: z.array(hetznerServerSummarySchema) }),
	paginationSchema
);
export const hetznerCreateServerResponseSchema = z.looseObject({
	server: hetznerServerSchema
});
export const hetznerActionResponseSchema = z.looseObject({
	action: hetznerActionSchema
});
// The two endpoints that hand back a root password - rebuild and enable rescue -
// and the only two whose response Hetzner documents without a `required` list. So
// the action is theirs to omit, and a runtime that demands it is asking for more
// than the provider promises, which is exactly what `system:providers` fails on.
// One schema for both, because they are one shape and one reason, and a caller
// that must check for the action before waiting on it either way.
export const hetznerOptionalActionResponseSchema = z.looseObject({
	action: hetznerActionSchema.optional()
});

const metricsSeriesSchema = z.looseObject({
	values: z.array(z.tuple([z.number(), z.string()]))
});
export const hetznerMetricsResponseSchema = z.looseObject({
	metrics: z.looseObject({
		time_series: z.record(z.string(), metricsSeriesSchema)
	})
});

export const hetznerCreateImageResponseSchema = z.looseObject({
	action: hetznerActionSchema.optional(),
	image: hetznerImageSchema.optional()
});
export const hetznerImageResponseSchema = z.looseObject({
	image: hetznerImageSchema.optional()
});
export const hetznerFullImagesResponseSchema = z.looseObject({
	images: z.array(hetznerImageSchema)
});
export const hetznerPagedImageSummariesResponseSchema = z.intersection(
	z.looseObject({
		images: z.array(z.looseObject({ id, created: z.string() }))
	}),
	paginationSchema
);

export const hetznerPrimaryIpsResponseSchema = z.looseObject({
	primary_ips: z.array(hetznerPrimaryIpSchema)
});
export const hetznerPagedPrimaryIpsResponseSchema = z.intersection(
	hetznerPrimaryIpsResponseSchema,
	paginationSchema
);

export const hetznerVolumeResponseSchema = z.looseObject({
	volume: z.looseObject({ server: id.nullable() })
});
export const hetznerPagedVolumeSummariesResponseSchema = z.intersection(
	z.looseObject({
		volumes: z.array(
			z.looseObject({
				id,
				name: z.string().optional(),
				created: z.string()
			})
		)
	}),
	paginationSchema
);
export const hetznerCreateVolumeResponseSchema = z.looseObject({
	volume: z.looseObject({ id }),
	action: z.looseObject({ id }),
	next_actions: z.array(z.looseObject({ id }))
});

export type HetznerAction = z.output<typeof hetznerActionSchema>;
export type HetznerImage = z.output<typeof hetznerImageSchema>;
export type HetznerServer = z.output<typeof hetznerServerSchema>;

export const HETZNER_OPENAPI_URL = "https://docs.hetzner.cloud/cloud.spec.json";

export const hetznerResponseContracts = [
	{
		name: "create a server",
		method: "post",
		path: "/servers",
		status: "201",
		schema: hetznerCreateServerResponseSchema
	},
	{
		name: "list servers for create recovery",
		method: "get",
		path: "/servers",
		status: "200",
		schema: hetznerPagedServerListResponseSchema
	},
	{
		name: "list server reconciliation fields",
		method: "get",
		path: "/servers",
		status: "200",
		schema: hetznerPagedServerSummariesResponseSchema
	},
	{
		name: "get a server",
		method: "get",
		path: "/servers/{id}",
		status: "200",
		schema: hetznerServerResponseSchema
	},
	{
		name: "get an action",
		method: "get",
		path: "/actions/{id}",
		status: "200",
		schema: hetznerActionResponseSchema
	},
	{
		name: "rebuild a server",
		method: "post",
		path: "/servers/{id}/actions/rebuild",
		status: "201",
		schema: hetznerOptionalActionResponseSchema
	},
	{
		name: "enable server rescue",
		method: "post",
		path: "/servers/{id}/actions/enable_rescue",
		status: "201",
		schema: hetznerOptionalActionResponseSchema
	},
	{
		name: "power a server on",
		method: "post",
		path: "/servers/{id}/actions/poweron",
		status: "201",
		schema: hetznerActionResponseSchema
	},
	{
		name: "power a server off",
		method: "post",
		path: "/servers/{id}/actions/poweroff",
		status: "201",
		schema: hetznerActionResponseSchema
	},
	{
		name: "reset a server",
		method: "post",
		path: "/servers/{id}/actions/reset",
		status: "201",
		schema: hetznerActionResponseSchema
	},
	{
		name: "shut a server down",
		method: "post",
		path: "/servers/{id}/actions/shutdown",
		status: "201",
		schema: hetznerActionResponseSchema
	},
	{
		name: "read server metrics",
		method: "get",
		path: "/servers/{id}/metrics",
		status: "200",
		schema: hetznerMetricsResponseSchema
	},
	{
		name: "create an image",
		method: "post",
		path: "/servers/{id}/actions/create_image",
		status: "201",
		schema: hetznerCreateImageResponseSchema
	},
	{
		name: "get an image",
		method: "get",
		path: "/images/{id}",
		status: "200",
		schema: hetznerImageResponseSchema
	},
	{
		name: "list image reconciliation fields",
		method: "get",
		path: "/images",
		status: "200",
		schema: hetznerPagedImageSummariesResponseSchema
	},
	{
		name: "list Primary IPs",
		method: "get",
		path: "/primary_ips",
		status: "200",
		schema: hetznerPagedPrimaryIpsResponseSchema
	},
	{
		name: "create a volume",
		method: "post",
		path: "/volumes",
		status: "201",
		schema: hetznerCreateVolumeResponseSchema
	},
	{
		name: "get a volume",
		method: "get",
		path: "/volumes/{id}",
		status: "200",
		schema: hetznerVolumeResponseSchema
	},
	{
		name: "list volume reconciliation fields",
		method: "get",
		path: "/volumes",
		status: "200",
		schema: hetznerPagedVolumeSummariesResponseSchema
	},
	{
		name: "attach a volume",
		method: "post",
		path: "/volumes/{id}/actions/attach",
		status: "201",
		schema: hetznerActionResponseSchema
	},
	{
		name: "detach a volume",
		method: "post",
		path: "/volumes/{id}/actions/detach",
		status: "201",
		schema: hetznerActionResponseSchema
	}
] as const;
