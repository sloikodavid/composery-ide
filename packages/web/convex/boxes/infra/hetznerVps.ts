"use node";

import { v } from "convex/values";
import type { z } from "zod";
import { internal } from "../../_generated/api";
import { internalAction } from "../../_generated/server";
import {
	SERVER_LOCATIONS,
	vServerLocation,
	vServerType,
	vSnapshotClass,
	type ServerLocation
} from "../../schema";
import { SERVER_TYPES, type ServerType } from "../../model/box/plan";
import { optionalEnv, requiredEnv } from "../../env";
import {
	hetznerActionResponseSchema,
	hetznerCreateImageResponseSchema,
	hetznerCreateServerResponseSchema,
	hetznerCreateVolumeResponseSchema,
	hetznerFullImagesResponseSchema,
	hetznerImageResponseSchema,
	hetznerMetricsResponseSchema,
	hetznerOptionalActionResponseSchema,
	hetznerPagedImageSummariesResponseSchema,
	hetznerPagedPrimaryIpsResponseSchema,
	hetznerPagedServerSummariesResponseSchema,
	hetznerPagedVolumeSummariesResponseSchema,
	hetznerServerListResponseSchema,
	hetznerServerResponseSchema,
	hetznerVolumeResponseSchema,
	type HetznerAction,
	type HetznerImage,
	type HetznerServer
} from "./hetznerContracts";
import { HOST_SSH_PORT } from "./artifacts";
import { decodeProviderResponse } from "./providerResponse";
import { authorizedPublicKey } from "./hostCredentials";

export type PlacementCandidate = {
	serverType: ServerType;
	location: ServerLocation;
};

// Where to try putting a box, in preference order. The server type is not a
// choice here: it is the box's plan, and a box provisioned on a type other than
// the one its plan advertises would be selling a machine it does not run. Only
// the location varies, so a region with no capacity right now falls through to
// the next one.
// How long each poll is willing to wait, as attempts three seconds apart.
//
// Named rather than inline because they are tuning, not behaviour: what a test
// pins is that the wait ends and says which resource it gave up on, and it reads
// the ceiling from here so a retune moves the test with the code instead of
// failing it. Exported for that and for nothing else.
export const HETZNER_POLL_INTERVAL_MS = 3000;
// A server reports "running" within a minute or two of a create.
export const HETZNER_SERVER_POLL_ATTEMPTS = 30;
// Actions cover volume formats and image captures, which take longer.
export const HETZNER_ACTION_POLL_ATTEMPTS = 60;

// Match the official hcloud clients: one request may be retried five times for
// the provider's documented transient failures. Each attempt has its own
// deadline, so a broken socket cannot consume the whole Convex action forever.
export const HETZNER_REQUEST_RETRIES = 5;
export const HETZNER_REQUEST_TIMEOUT_MS = 15_000;
const HETZNER_RETRY_BASE_MS = 1_000;
const HETZNER_RETRY_CAP_MS = 60_000;

export function placementCandidates(
	serverType: ServerType,
	locations: readonly ServerLocation[] = SERVER_LOCATIONS
): [PlacementCandidate, ...PlacementCandidate[]] {
	const [first, ...rest] = locations;
	if (!first) throw new Error("No Hetzner placement candidates configured.");
	return [first, ...rest].map((location) => ({
		serverType,
		location
	})) as [PlacementCandidate, ...PlacementCandidate[]];
}

function parseAllowedList<const T extends string>(
	value: string | undefined,
	fallback: readonly T[]
) {
	if (!value) return [...fallback];

	const allowed = new Set<string>(fallback);
	const parsed = value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);

	if (parsed.length === 0) return [...fallback];

	for (const part of parsed) {
		if (!allowed.has(part)) {
			throw new Error(`Unsupported provisioning value: ${part}.`);
		}
	}

	return parsed as T[];
}

export function parseLocations(value: string | undefined): ServerLocation[] {
	return parseAllowedList(value, SERVER_LOCATIONS);
}

export type { HetznerAction, HetznerImage };

export class HetznerApiError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly code?: string
	) {
		super(message);
		this.name = "HetznerApiError";
	}
}

class HetznerServerCreatedButNotReadyError extends Error {
	constructor(serverId: number, cause: unknown) {
		super(
			cause instanceof Error
				? cause.message
				: `Hetzner server ${serverId} did not become ready.`
		);
		this.name = "HetznerServerCreatedButNotReadyError";
	}
}

function hetznerHeaders() {
	return {
		Accept: "application/json",
		Authorization: `Bearer ${requiredEnv("HETZNER_CLOUD_TOKEN")}`,
		"Content-Type": "application/json",
		"User-Agent": "composery-web"
	};
}

function hetznerError(body: unknown) {
	if (!body || typeof body !== "object" || !("error" in body)) return undefined;
	const error = body.error;
	if (!error || typeof error !== "object") return undefined;
	return {
		code:
			"code" in error && typeof error.code === "string"
				? error.code
				: undefined,
		message:
			"message" in error && typeof error.message === "string"
				? error.message
				: undefined
	};
}

type HetznerRequestInit = RequestInit & { retry?: boolean };

async function hetznerRequest<Schema extends z.ZodType>(
	path: string,
	schema: Schema,
	init?: HetznerRequestInit
): Promise<z.output<Schema>>;
async function hetznerRequest(
	path: string,
	schema: undefined,
	init?: HetznerRequestInit
): Promise<void>;
async function hetznerRequest(
	path: string,
	schema: z.ZodType | undefined,
	init?: HetznerRequestInit
) {
	const { retry = true, ...requestInit } = init ?? {};
	for (let attempt = 0; ; attempt += 1) {
		let response: Response;
		try {
			response = await fetch(`https://api.hetzner.cloud/v1${path}`, {
				...requestInit,
				headers: {
					...hetznerHeaders(),
					...requestInit.headers
				},
				signal: requestInit.signal
					? AbortSignal.any([
							requestInit.signal,
							AbortSignal.timeout(HETZNER_REQUEST_TIMEOUT_MS)
						])
					: AbortSignal.timeout(HETZNER_REQUEST_TIMEOUT_MS)
			});
		} catch (error) {
			// A caller cancellation is final. A network failure or this boundary's
			// attempt timeout is transient, which is how the official clients read it.
			if (
				requestInit.signal?.aborted ||
				!retry ||
				attempt >= HETZNER_REQUEST_RETRIES
			) {
				throw error;
			}
			await waitForHetznerRetry(attempt);
			continue;
		}

		const text = await response.text();
		let body: unknown = {};
		try {
			body = text ? JSON.parse(text) : {};
		} catch {
			// Gateways can answer with non-JSON (HTML error pages); keep the status
			// instead of surfacing a bare SyntaxError.
		}

		if (response.ok) {
			return schema
				? decodeProviderResponse("Hetzner", schema, body)
				: undefined;
		}

		const providerError = hetznerError(body);
		const error = new HetznerApiError(
			providerError?.message ?? `Hetzner API ${response.status}.`,
			response.status,
			providerError?.code
		);
		if (
			retry &&
			attempt < HETZNER_REQUEST_RETRIES &&
			isRetryableHetznerError(error)
		) {
			await waitForHetznerRetry(attempt);
			continue;
		}

		if (error.code === "resource_limit_exceeded") {
			// Hetzner has no quota endpoint, so this 403 is the only signal that the
			// project's server or snapshot limit is full. Log it loudly (the path
			// says whether it was a server create or a create_image) so the limit
			// gets raised; the caller still handles the throw as a normal failure.
			console.warn(
				`[hetzner] resource limit exceeded on ${path}: ${error.message}`
			);
		}
		throw error;
	}
}

export function isRetryableHetznerError(error: HetznerApiError) {
	return (
		error.status === 502 ||
		error.status === 504 ||
		error.code === "bad_gateway" ||
		error.code === "conflict" ||
		error.code === "rate_limit_exceeded" ||
		error.code === "timeout"
	);
}

export function hetznerRetryDelayMs(attempt: number, random = Math.random) {
	const ceiling = Math.min(
		HETZNER_RETRY_CAP_MS,
		HETZNER_RETRY_BASE_MS * 2 ** Math.max(0, attempt)
	);
	return Math.round(
		HETZNER_RETRY_BASE_MS + random() * (ceiling - HETZNER_RETRY_BASE_MS)
	);
}

// The backoff sleep, behind a seam so a suite can make it immediate.
//
// Everything about the retry that matters in production - how many attempts,
// how long each waits, the jitter - stays here and stays real. Only the waiting
// itself is substitutable, which is the seam docs/developing/testing.md asks for
// around the clock: a test that stubs `fetch` to fail is asking what happens
// after the retries, not how many seconds they take, and on a fake clock the
// timer never fires at all.
export const hetznerBackoff = {
	wait: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
};

async function waitForHetznerRetry(attempt: number) {
	await hetznerBackoff.wait(hetznerRetryDelayMs(attempt));
}

function isNotFound(error: unknown) {
	return error instanceof HetznerApiError && error.status === 404;
}

export { isNotFound as isHetznerNotFound };

// Hetzner reports a box's IPv6 as the /64 it owns; a DNS AAAA record takes an
// address. Publishing the prefix verbatim is a record no resolver can answer.
export function normalizeIpv6ForDns(ip: string) {
	return ip.split("/")[0];
}

// Rescue accepts only SSH key ids. Use that stricter shape for server creation
// too, so a key configuration that cannot recover a server cannot create one.
export function sshKeyIds(value: string | undefined) {
	const parts = (value ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
	const ids = parts.map(Number);
	if (
		ids.length === 0 ||
		parts.some((part) => !/^\d+$/.test(part)) ||
		ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
	) {
		throw new Error("HETZNER_SSH_KEYS must contain positive numeric key ids.");
	}
	return ids;
}

// The one escaping boundary in this file. `renderCloudInitUserData` interpolates
// two operator-set values into a YAML document that becomes the first thing a
// fresh host runs as root, so a value carrying a newline is refused rather than
// escaped: single quotes cannot span lines in YAML, and there is no correct
// reading of an `HOST_SSH_USER` that contains one.
export function yamlSingleQuote(value: string) {
	if (/[\r\n]/.test(value)) {
		throw new Error("Cloud-init values must stay on one line.");
	}
	return `'${value.replace(/'/g, "''")}'`;
}

export function renderCloudInitUserData() {
	return `#cloud-config
disable_root: false
ssh_pwauth: false
users:
  - name: ${yamlSingleQuote(requiredEnv("HOST_SSH_USER"))}
    shell: /bin/bash
    lock_passwd: true
    ssh_authorized_keys:
      - ${yamlSingleQuote(authorizedPublicKey())}
write_files:
  - path: /etc/ssh/sshd_config.d/composery-control.conf
    permissions: '0644'
    content: |
      # Composery's control plane reaches this host here. Port 22 is left for the
      # instance, whose container shares this network stack.
      Port ${HOST_SSH_PORT}
runcmd:
  - [ systemctl, restart, ssh ]
`;
}

// `image` is the snapshot a duplicate is built from, and absent for every other
// new box, which takes the deployment's base image.
//
// A snapshot image is project-scoped at Hetzner rather than location-scoped, so
// a duplicate needs no placement coordination and the candidate list is the
// ordinary one. What a snapshot *is* constrained by is disk: Hetzner cannot
// shrink one, so an image only boots onto a server type whose disk is at least
// the source's. That is why a duplicate is sold on the source's own plan and
// nothing here has to compare sizes - see `assertDuplicableSource`.
export function createServerPayload(
	candidate: PlacementCandidate,
	slug: string,
	boxRef: string,
	image?: number | string
) {
	const sshKeys = sshKeyIds(requiredEnv("HETZNER_SSH_KEYS"));
	const firewallId = requiredEnv("HETZNER_FIREWALL_ID");

	return {
		name: `composery-${slug}`,
		server_type: candidate.serverType,
		image: image ?? requiredEnv("HETZNER_BOX_IMAGE"),
		location: candidate.location,
		ssh_keys: sshKeys,
		user_data: renderCloudInitUserData(),
		// No private network: Hetzner firewalls do not filter private network
		// traffic, so a shared network would let one box reach another.
		firewalls: [{ firewall: Number(firewallId) }],
		public_net: {
			enable_ipv4: true,
			enable_ipv6: true
		},
		labels: {
			product: "composery-web",
			box_ref: boxRef,
			box_slug: slug
		}
	};
}

export function rebuildServerPayload(image: number | string) {
	return {
		image,
		user_data: renderCloudInitUserData()
	};
}

export function rescuePayload() {
	return {
		type: "linux64" as const,
		ssh_keys: sshKeyIds(requiredEnv("HETZNER_SSH_KEYS"))
	};
}

export function composeryServerListPath(boxRef: string) {
	const params = new URLSearchParams({
		label_selector: `product=composery-web,box_ref=${boxRef}`
	});
	return `/servers?${params.toString()}`;
}

function isServerType(value: string | undefined): value is ServerType {
	return SERVER_TYPES.includes(value as ServerType);
}

function isServerLocation(value: string | undefined): value is ServerLocation {
	return SERVER_LOCATIONS.includes(value as ServerLocation);
}

function serverLocation(server: HetznerServer) {
	return server.location.name;
}

function responseServer(
	response: z.output<typeof hetznerServerResponseSchema>,
	serverId: number
) {
	if (!response.server) {
		throw new Error(`Hetzner did not return server ${serverId}.`);
	}
	return response.server;
}

// One Hetzner server response turned into the fields the box row keeps.
//
// The provider's answer is authoritative. A type or location outside our own
// unions is rejected instead of being replaced with what the request asked for.
// Missing addresses are fatal because the box needs both DNS records.
export function materializeServer(server: HetznerServer) {
	const ipv4 = server.public_net.ipv4?.ip;
	const ipv6 = server.public_net.ipv6?.ip;

	if (!ipv4 || !ipv6) {
		throw new Error("Hetzner server is missing public IPv4 or IPv6.");
	}

	const apiServerType = server.server_type?.name;
	const apiLocation = serverLocation(server);
	if (!isServerType(apiServerType) || !isServerLocation(apiLocation)) {
		throw new Error("Hetzner server returned unsupported type or location.");
	}

	return {
		serverId: server.id,
		serverType: apiServerType,
		location: apiLocation,
		ipv4,
		ipv6: normalizeIpv6ForDns(ipv6)
	};
}

async function findExistingServer(boxRef: string) {
	const response = await hetznerRequest(
		composeryServerListPath(boxRef),
		hetznerServerListResponseSchema
	);
	const servers = response.servers;

	return (
		servers.find(
			(server) =>
				server.status === "running" &&
				server.public_net?.ipv4?.ip &&
				server.public_net?.ipv6?.ip
		) ??
		servers.find((server) => server.id) ??
		null
	);
}

async function existingCreatedServer(boxRef: string) {
	const existing = await findExistingServer(boxRef);
	if (!existing) return null;
	const ready = await waitForServer(existing.id);
	return materializeServer(ready);
}

async function waitForServer(serverId: number) {
	for (let attempt = 0; attempt < HETZNER_SERVER_POLL_ATTEMPTS; attempt += 1) {
		const response = await hetznerRequest(
			`/servers/${serverId}`,
			hetznerServerResponseSchema
		);
		const server = responseServer(response, serverId);

		if (
			server.status === "running" &&
			server.public_net.ipv4?.ip &&
			server.public_net.ipv6?.ip
		) {
			return server;
		}

		await new Promise((resolve) =>
			setTimeout(resolve, HETZNER_POLL_INTERVAL_MS)
		);
	}

	throw new Error(`Hetzner server ${serverId} did not become ready.`);
}

async function waitForActionSuccess(actionId: number) {
	for (let attempt = 0; attempt < HETZNER_ACTION_POLL_ATTEMPTS; attempt += 1) {
		const response = await hetznerRequest(
			`/actions/${actionId}`,
			hetznerActionResponseSchema
		);
		const action = response.action;

		if (action?.status === "success") return;
		if (action?.status === "error") {
			throw new Error(
				action.error?.message ?? `Hetzner action ${actionId} failed.`
			);
		}

		await new Promise((resolve) =>
			setTimeout(resolve, HETZNER_POLL_INTERVAL_MS)
		);
	}

	throw new Error(`Hetzner action ${actionId} did not finish in time.`);
}

async function createHetznerServer(
	candidate: PlacementCandidate,
	slug: string,
	boxRef: string,
	image?: number | string
) {
	let createdServerId: number | undefined;

	try {
		const response = await hetznerRequest(
			"/servers",
			hetznerCreateServerResponseSchema,
			{
				method: "POST",
				body: JSON.stringify(createServerPayload(candidate, slug, boxRef)),
				retry: false
			}
		);

		createdServerId = response.server.id;
		const server = await waitForServer(response.server.id);
		return materializeServer(server);
	} catch (error) {
		if (createdServerId) {
			throw new HetznerServerCreatedButNotReadyError(createdServerId, error);
		}
		throw error;
	}
}

// The mean of one Hetzner metrics series, and the reason it is careful: this
// number reaches `recordSample`, which compares it against a threshold that can
// suspend a paying customer's box. A missing series is 0 rather than NaN, and a
// non-numeric point is dropped rather than poisoning the average - either would
// otherwise propagate into a comparison whose answer is somebody's box going
// off the air.
export function seriesMean(
	timeSeries: Record<string, { values?: [number, string][] }>,
	name: string
) {
	const values = (timeSeries[name]?.values ?? [])
		.map(([, value]) => Number(value))
		.filter(Number.isFinite);
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export async function fetchServerMetricsSample(
	serverId: number,
	windowMs: number
) {
	const end = new Date();
	const start = new Date(end.getTime() - windowMs);
	const params = new URLSearchParams({
		type: "cpu,disk,network",
		start: start.toISOString(),
		end: end.toISOString(),
		step: "60"
	});
	const response = await hetznerRequest(
		`/servers/${serverId}/metrics?${params.toString()}`,
		hetznerMetricsResponseSchema
	);
	const timeSeries = response.metrics.time_series;

	return {
		cpuPercent: seriesMean(timeSeries, "cpu"),
		ingressBps: seriesMean(timeSeries, "network.0.bandwidth.in"),
		egressBps: seriesMean(timeSeries, "network.0.bandwidth.out"),
		ingressPps: seriesMean(timeSeries, "network.0.pps.in"),
		egressPps: seriesMean(timeSeries, "network.0.pps.out"),
		diskReadBps: seriesMean(timeSeries, "disk.0.bandwidth.read"),
		diskWriteBps: seriesMean(timeSeries, "disk.0.bandwidth.write")
	};
}

// What this server has sent this billing period.
//
// Read off the server object rather than the metrics endpoint on purpose: the
// metrics series carries bandwidth *rates*, and adding those up over a month to
// guess a total would produce a number that disagrees with the one the provider
// bills on. This field is that number.
//
// Null where the provider did not report one, so a caller cannot mistake "not
// reported" for zero bytes sent - which for a signal measured against an
// allowance is the reading that says everything is fine.
//
// What the machine *includes* is deliberately not read here. That is a fact about
// the server type rather than about this box, and asking it per box per poll
// would be the same question several hundred times an hour; the daily
// reconciliation asks it once per type instead (`boxes/reconcile.ts`).
export async function fetchServerUsage(
	serverId: number
): Promise<{ outgoingBytes: number } | null> {
	const outgoingBytes = (await getServer(serverId)).outgoing_traffic;
	return typeof outgoingBytes === "number" ? { outgoingBytes } : null;
}

export const createServer = internalAction({
	args: {
		boxId: v.id("boxes"),
		// The snapshot a duplicate is provisioned from. Absent for every other new
		// box, which gets the deployment's base image.
		image: v.optional(v.union(v.number(), v.string())),
		serverType: vServerType,
		slug: v.string()
	},
	handler: async (ctx, args) => {
		const boxRef = String(args.boxId);
		// Every placement candidate, always. There was a `location` argument here
		// that pinned the list to one region, documented as serving a plan change
		// that parks a box on a Hetzner Volume - but a box's plan is fixed for
		// life and nothing moves a box between plans, so no caller ever passed it
		// and none could. It is removed rather than left for a future that the
		// plan model rules out; a snapshot image is project-scoped, so Duplicate
		// does not need it either.
		const locations = parseLocations(optionalEnv("HETZNER_BOX_LOCATIONS"));
		const candidates = placementCandidates(args.serverType, locations);
		let lastError: string | undefined;

		const existing = await existingCreatedServer(boxRef);
		if (existing) return existing;

		for (const candidate of candidates) {
			try {
				return await createHetznerServer(
					candidate,
					args.slug,
					boxRef,
					args.image
				);
			} catch (error) {
				if (error instanceof HetznerServerCreatedButNotReadyError) {
					throw error;
				}
				// Account quota is independent of server type and location. Trying the
				// full placement matrix cannot make it pass; let the workflow retry and
				// eventually apply the paid-but-unfulfilled refund path.
				if (
					error instanceof HetznerApiError &&
					error.code === "resource_limit_exceeded"
				) {
					// The provider has authoritatively said another server cannot be
					// created. Stop new payable checkouts so repeated purchases do not
					// become repeated refunds and non-refundable Polar fees. Staff can
					// request the Hetzner increase and re-enable checkout in the console.
					await ctx.runMutation(internal.settings.closeCheckout, {
						by: "system:hetzner_resource_limit_exceeded"
					});
					throw error;
				}

				const recovered = await existingCreatedServer(boxRef);
				if (recovered) return recovered;
				lastError = error instanceof Error ? error.message : String(error);
			}
		}

		throw new Error(lastError ?? "No Hetzner placement candidate succeeded.");
	}
});

export const rebuildServer = internalAction({
	args: {
		serverId: v.optional(v.number()),
		image: v.optional(v.union(v.number(), v.string()))
	},
	handler: async (ctx, args) => {
		if (!args.serverId) {
			throw new Error("Box has no Hetzner server to rebuild.");
		}

		const image = args.image ?? requiredEnv("HETZNER_BOX_IMAGE");

		const response = await hetznerRequest(
			`/servers/${args.serverId}/actions/rebuild`,
			hetznerOptionalActionResponseSchema,
			{
				method: "POST",
				// Always send the current key. Hetzner supports user_data on rebuilds,
				// including snapshot restores; relying only on the key selected when the
				// server was created would make credential rotation ineffective here.
				body: JSON.stringify(rebuildServerPayload(image))
			}
		);
		if (!response.action) {
			throw new Error("Hetzner rebuild did not return an action id.");
		}

		await waitForActionSuccess(response.action.id);
		return materializeServer(await waitForServer(args.serverId));
	}
});

export const deleteServer = internalAction({
	args: {
		serverId: v.optional(v.number())
	},
	handler: async (_ctx, args) => {
		if (!args.serverId) return;

		try {
			await hetznerRequest(`/servers/${args.serverId}`, undefined, {
				method: "DELETE"
			});
		} catch (error) {
			if (!isNotFound(error)) throw error;
		}
	}
});

export function primaryIpListPath(page: number) {
	const params = new URLSearchParams({
		per_page: "50",
		page: String(page)
	});
	return `/primary_ips?${params.toString()}`;
}

// A Primary IP with no assignee belongs to no server. Every one of ours is
// created implicitly by `createServerPayload` (`enable_ipv4`/`enable_ipv6` with
// no explicit id), which is exactly the form Hetzner marks `auto_delete` and
// removes along with the server - so in normal operation this is never true for
// more than the few seconds that removal takes.
//
// Hetzner reports an unassigned Primary IP as `assignee_id: null`, and older
// responses omit the field entirely; both mean the same thing here.
export function isUnassignedPrimaryIp(primaryIp: {
	assignee_id?: number | null;
}) {
	return primaryIp.assignee_id === null || primaryIp.assignee_id === undefined;
}

// Reconciliation feed: every Primary IP in the project that is attached to
// nothing, so the cron can report a leak rather than let one bill quietly.
//
// Primary IPs carry none of our labels (Hetzner creates them, not us), so this
// cannot filter by `product=composery-web` the way the server and volume feeds
// do. That is also why reconciliation only ever reports these - an unlabelled
// resource is not provably ours to delete.
export const listUnassignedPrimaryIps = internalAction({
	args: {},
	returns: v.array(
		v.object({
			primaryIpId: v.number(),
			ip: v.optional(v.string()),
			createdAtMs: v.number()
		})
	),
	handler: async () => {
		const unassigned: {
			primaryIpId: number;
			ip?: string;
			createdAtMs: number;
		}[] = [];
		let page: number | null = 1;
		while (page) {
			const body: z.output<typeof hetznerPagedPrimaryIpsResponseSchema> =
				await hetznerRequest(
					primaryIpListPath(page),
					hetznerPagedPrimaryIpsResponseSchema
				);
			for (const primaryIp of body.primary_ips) {
				if (!isUnassignedPrimaryIp(primaryIp)) continue;
				unassigned.push({
					primaryIpId: primaryIp.id,
					ip: primaryIp.ip,
					createdAtMs: parseCreatedMs(primaryIp.created)
				});
			}
			page = body.meta.pagination.next_page;
		}
		return unassigned;
	}
});

async function waitForServerGone(serverId: number) {
	for (let attempt = 0; attempt < HETZNER_SERVER_POLL_ATTEMPTS; attempt += 1) {
		try {
			await hetznerRequest(`/servers/${serverId}`, hetznerServerResponseSchema);
		} catch (error) {
			if (isNotFound(error)) return;
			throw error;
		}
		await new Promise((resolve) =>
			setTimeout(resolve, HETZNER_POLL_INTERVAL_MS)
		);
	}

	throw new Error(`Hetzner server ${serverId} was not deleted in time.`);
}

export const waitServerDeleted = internalAction({
	args: {
		serverId: v.optional(v.number())
	},
	handler: async (_ctx, args) => {
		if (!args.serverId) return;
		await waitForServerGone(args.serverId);
	}
});

async function getServer(serverId: number) {
	const response = await hetznerRequest(
		`/servers/${serverId}`,
		hetznerServerResponseSchema
	);
	return responseServer(response, serverId);
}

async function serverStatus(serverId: number) {
	return (await getServer(serverId)).status;
}

async function waitForServerOff(serverId: number) {
	for (let attempt = 0; attempt < HETZNER_SERVER_POLL_ATTEMPTS; attempt += 1) {
		if ((await serverStatus(serverId)) === "off") return true;
		await new Promise((resolve) =>
			setTimeout(resolve, HETZNER_POLL_INTERVAL_MS)
		);
	}
	return false;
}

export const powerOffServer = internalAction({
	args: {
		serverId: v.optional(v.number())
	},
	handler: async (_ctx, args) => {
		if (!args.serverId) return;
		if ((await serverStatus(args.serverId)) === "off") return;
		let response: z.output<typeof hetznerActionResponseSchema>;
		try {
			response = await hetznerRequest(
				`/servers/${args.serverId}/actions/poweroff`,
				hetznerActionResponseSchema,
				{ method: "POST", retry: false }
			);
		} catch (error) {
			if (await waitForServerOff(args.serverId)) return;
			throw error;
		}
		await waitForActionSuccess(response.action.id);
		if (!(await waitForServerOff(args.serverId))) {
			throw new Error(`Hetzner server ${args.serverId} did not power off.`);
		}
	}
});

export const stopServer = internalAction({
	args: {
		serverId: v.optional(v.number())
	},
	handler: async (_ctx, args) => {
		if (!args.serverId) return;
		if ((await serverStatus(args.serverId)) === "off") return;

		try {
			await hetznerRequest(
				`/servers/${args.serverId}/actions/shutdown`,
				hetznerActionResponseSchema,
				{ method: "POST", retry: false }
			);
		} catch {
			// The state poll below decides whether the request took effect. If it did
			// not, the same path escalates to a provider power-off.
		}
		if (await waitForServerOff(args.serverId)) return;

		let response: z.output<typeof hetznerActionResponseSchema>;
		try {
			response = await hetznerRequest(
				`/servers/${args.serverId}/actions/poweroff`,
				hetznerActionResponseSchema,
				{ method: "POST", retry: false }
			);
		} catch (error) {
			if (await waitForServerOff(args.serverId)) return;
			throw error;
		}
		await waitForActionSuccess(response.action.id);
		if (!(await waitForServerOff(args.serverId))) {
			throw new Error(`Hetzner server ${args.serverId} did not power off.`);
		}
	}
});

export const powerOnServer = internalAction({
	args: {
		serverId: v.optional(v.number())
	},
	handler: async (_ctx, args) => {
		if (!args.serverId) return;
		const status = await serverStatus(args.serverId);
		if (status === "running") return;
		if (status !== "off") {
			await waitForServer(args.serverId);
			return;
		}
		let response: z.output<typeof hetznerActionResponseSchema>;
		try {
			response = await hetznerRequest(
				`/servers/${args.serverId}/actions/poweron`,
				hetznerActionResponseSchema,
				{ method: "POST", retry: false }
			);
		} catch (error) {
			try {
				await waitForServer(args.serverId);
				return;
			} catch {
				throw error;
			}
		}
		await waitForActionSuccess(response.action.id);
		await waitForServer(args.serverId);
	}
});

// Start the provider's independent rescue OS. The installed disk, Docker, and
// configured SSH user are not involved, which makes this the recovery boundary
// for a host that cannot boot or answer normally.
export const bootServerInRescue = internalAction({
	args: { serverId: v.optional(v.number()) },
	handler: async (_ctx, args) => {
		if (!args.serverId) {
			throw new Error("Box has no Hetzner server to rescue.");
		}
		// Repair powers the server off before this step. If a previous attempt lost
		// the power-on response, a running server is the expected result and the
		// following Rescue SSH probe proves which OS answered.
		const server = await getServer(args.serverId);
		if (server.status !== "off") {
			await waitForServer(args.serverId);
			return;
		}

		if (server.rescue_enabled !== true) {
			let enabled:
				z.output<typeof hetznerOptionalActionResponseSchema> | undefined;
			try {
				enabled = await hetznerRequest(
					`/servers/${args.serverId}/actions/enable_rescue`,
					hetznerOptionalActionResponseSchema,
					{
						method: "POST",
						body: JSON.stringify(rescuePayload()),
						retry: false
					}
				);
			} catch (error) {
				if ((await getServer(args.serverId)).rescue_enabled !== true)
					throw error;
			}
			// Nothing to wait on when the provider omits the action, and nothing lost
			// either: the rescue OS is on by the time it answers, and the SSH probe
			// after the power-on is what proves which OS came up.
			if (enabled?.action) await waitForActionSuccess(enabled.action.id);
		}

		let booted: z.output<typeof hetznerActionResponseSchema>;
		try {
			booted = await hetznerRequest(
				`/servers/${args.serverId}/actions/poweron`,
				hetznerActionResponseSchema,
				{ method: "POST", retry: false }
			);
		} catch (error) {
			try {
				await waitForServer(args.serverId);
				return;
			} catch {
				throw error;
			}
		}
		await waitForActionSuccess(booted.action.id);
		await waitForServer(args.serverId);
	}
});

export function createSnapshotImagePayload(
	slug: string,
	description: string,
	snapshotRef: string
) {
	return {
		type: "snapshot" as const,
		description,
		labels: {
			product: "composery-web",
			box_slug: slug,
			snapshot_ref: snapshotRef
		}
	};
}

export function snapshotRefImageListPath(snapshotRef: string) {
	const params = new URLSearchParams({
		type: "snapshot",
		label_selector: `product=composery-web,snapshot_ref=${snapshotRef}`
	});
	return `/images?${params.toString()}`;
}

async function existingSnapshotImage(snapshotRef: string) {
	const response = await hetznerRequest(
		snapshotRefImageListPath(snapshotRef),
		hetznerFullImagesResponseSchema
	);
	return response.images.sort((left, right) =>
		right.created.localeCompare(left.created)
	)[0];
}

export function parseCreateImageResponse(
	body: z.output<typeof hetznerCreateImageResponseSchema>
): {
	actionId: number;
	imageId: number;
} {
	if (!body.action || !body.image) {
		throw new Error(
			"Hetzner create_image did not return an action and image id."
		);
	}
	return { actionId: body.action.id, imageId: body.image.id };
}

// Unknown action statuses are treated as `running` so a transient new status
// does not abort an in-progress snapshot.
export function parseActionStatus(action: HetznerAction): {
	status: "running" | "success" | "error";
	error?: string;
} {
	if (action.status === "success") return { status: "success" };
	if (action.status === "error") {
		return {
			status: "error",
			error: action.error?.message ?? "Hetzner action failed."
		};
	}
	return { status: "running" };
}

// `image_size` is null until the image is `available`, so `imageSizeGb` stays
// optional. The image's own `disk_size` is deliberately not read: every box has
// the same disk for its whole life, so a snapshot always fits the machine it is
// restored onto and there is nothing to compare.
export function parseImageResponse(image: HetznerImage): {
	status: "creating" | "available";
	imageSizeGb?: number;
} {
	return {
		status: image.status === "available" ? "available" : "creating",
		imageSizeGb: image.image_size ?? undefined
	};
}

export const createSnapshotImage = internalAction({
	args: {
		serverId: v.optional(v.number()),
		slug: v.string(),
		snapshotClass: vSnapshotClass,
		snapshotRef: v.string()
	},
	returns: v.object({
		actionId: v.optional(v.number()),
		imageId: v.number()
	}),
	handler: async (ctx, args) => {
		if (!args.serverId) {
			throw new Error("Box has no Hetzner server to snapshot.");
		}

		const existing = await existingSnapshotImage(args.snapshotRef);
		if (existing) return { actionId: undefined, imageId: existing.id };

		// The timestamped description is built here rather than in the workflow
		// handler, which must stay deterministic across replays.
		const description = `composery-web ${args.slug} ${args.snapshotClass} ${new Date().toISOString()}`;
		let response: z.output<typeof hetznerCreateImageResponseSchema>;
		try {
			response = await hetznerRequest(
				`/servers/${args.serverId}/actions/create_image`,
				hetznerCreateImageResponseSchema,
				{
					method: "POST",
					body: JSON.stringify(
						createSnapshotImagePayload(args.slug, description, args.snapshotRef)
					),
					retry: false
				}
			);
		} catch (error) {
			const recovered = await existingSnapshotImage(args.snapshotRef);
			// No action to wait for: the image was already there, so the caller has
			// nothing to poll. Named rather than omitted, so the two returns are one
			// shape and a caller can destructure either.
			if (recovered) return { actionId: undefined, imageId: recovered.id };
			if (
				error instanceof HetznerApiError &&
				error.code === "resource_limit_exceeded"
			) {
				await ctx.runMutation(internal.settings.closeCheckout, {
					by: "system:hetzner_snapshot_resource_limit_exceeded"
				});
			}
			throw error;
		}

		return parseCreateImageResponse(response);
	}
});

export const getAction = internalAction({
	args: { actionId: v.number() },
	returns: v.object({
		status: v.union(
			v.literal("running"),
			v.literal("success"),
			v.literal("error")
		),
		error: v.optional(v.string())
	}),
	handler: async (_ctx, args) => {
		const response = await hetznerRequest(
			`/actions/${args.actionId}`,
			hetznerActionResponseSchema
		);
		return parseActionStatus(response.action);
	}
});

export const getImage = internalAction({
	args: { imageId: v.number() },
	returns: v.object({
		status: v.union(v.literal("creating"), v.literal("available")),
		imageSizeGb: v.optional(v.number())
	}),
	handler: async (_ctx, args) => {
		const response = await hetznerRequest(
			`/images/${args.imageId}`,
			hetznerImageResponseSchema
		);
		if (!response.image) {
			throw new Error(`Hetzner image ${args.imageId} not found.`);
		}
		return parseImageResponse(response.image);
	}
});

// `created` is always present on Hetzner resources; fall back to "now" so an
// unparseable timestamp is treated as freshly created and skipped by the
// reconciliation age guard rather than risking deletion of something we can't
// date.
function parseCreatedMs(created: string | undefined) {
	const parsed = created ? Date.parse(created) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : Date.now();
}

function productImageListPath(page: number) {
	const params = new URLSearchParams({
		type: "snapshot",
		label_selector: "product=composery-web",
		per_page: "50",
		page: String(page)
	});
	return `/images?${params.toString()}`;
}

function productServerListPath(page: number) {
	const params = new URLSearchParams({
		label_selector: "product=composery-web",
		per_page: "50",
		page: String(page)
	});
	return `/servers?${params.toString()}`;
}

// Reconciliation feed: every snapshot image we own, fleet-wide, so the cron can
// delete any whose box_snapshots row is gone.
export const listProductSnapshotImages = internalAction({
	args: {},
	returns: v.array(v.object({ imageId: v.number(), createdAtMs: v.number() })),
	handler: async () => {
		const images: { imageId: number; createdAtMs: number }[] = [];
		let page: number | null = 1;
		while (page) {
			const body: z.output<typeof hetznerPagedImageSummariesResponseSchema> =
				await hetznerRequest(
					productImageListPath(page),
					hetznerPagedImageSummariesResponseSchema
				);
			for (const image of body.images) {
				images.push({
					imageId: image.id,
					createdAtMs: parseCreatedMs(image.created)
				});
			}
			page = body.meta.pagination.next_page;
		}
		return images;
	}
});

// Reconciliation feed: every server we own, fleet-wide, so the cron can flag any
// with no live box pointing at it.
export const listProductServers = internalAction({
	args: {},
	returns: v.array(
		v.object({
			serverId: v.number(),
			name: v.optional(v.string()),
			createdAtMs: v.number(),
			// What the machine is and what it includes, for the catalogue audit in
			// `boxes/reconcile.ts`. Both optional: a server the provider described
			// without them is still a server this feed has to report as ours.
			serverType: v.optional(v.string()),
			includedTrafficBytes: v.optional(v.number())
		})
	),
	handler: async () => {
		const servers: {
			serverId: number;
			name?: string;
			createdAtMs: number;
			serverType?: string;
			includedTrafficBytes?: number;
		}[] = [];
		let page: number | null = 1;
		while (page) {
			const body: z.output<typeof hetznerPagedServerSummariesResponseSchema> =
				await hetznerRequest(
					productServerListPath(page),
					hetznerPagedServerSummariesResponseSchema
				);
			for (const server of body.servers) {
				servers.push({
					serverId: server.id,
					name: server.name,
					createdAtMs: parseCreatedMs(server.created),
					serverType: server.server_type?.name,
					// Null and absent both mean "not reported", and neither may become
					// zero: zero is a machine that includes no traffic at all, which
					// would make every plan look like it oversells.
					includedTrafficBytes: server.included_traffic ?? undefined
				});
			}
			page = body.meta.pagination.next_page;
		}
		return servers;
	}
});

export const deleteImage = internalAction({
	args: { imageId: v.optional(v.number()) },
	handler: async (_ctx, args) => {
		if (!args.imageId) return;
		try {
			await hetznerRequest(`/images/${args.imageId}`, undefined, {
				method: "DELETE"
			});
		} catch (error) {
			if (!isNotFound(error)) throw error;
		}
	}
});

export type CreatedServer = {
	ipv4: string;
	ipv6: string;
	location: ServerLocation;
	serverId: number;
	serverType: ServerType;
};

// -- Parking volumes (Repair) -----------------------------------------------
//
// A Repair ("clean host, current files") parks the box's files on a Hetzner
// Volume for the few minutes it takes to wipe and reboot the server from the
// base image. The Volume is transient by design: Hetzner gives Volumes no
// backups or snapshots and excludes attached volumes from server snapshots, so
// they are never a permanent home for box data - only a short-lived staging
// area, created at the start of a repair and deleted the moment the files are
// safely back on the fresh host.

export function parkingVolumeName(slug: string) {
	return `composery-park-${slug}`;
}

export function createVolumePayload(
	slug: string,
	location: ServerLocation,
	sizeGb: number,
	boxRef: string
) {
	return {
		name: parkingVolumeName(slug),
		size: sizeGb,
		location,
		// Pre-format so the box only ever has to mount it; formatting on the host
		// would risk a resumed repair reformatting a volume that already holds the
		// parked files.
		format: "ext4" as const,
		automount: false,
		labels: {
			product: "composery-web",
			box_ref: boxRef,
			box_slug: slug,
			role: "parking"
		}
	};
}

export function attachVolumePayload(serverId: number) {
	// automount:false - the box scripts mount it deliberately at a known path.
	return { server: serverId, automount: false };
}

export function productVolumeListPath(page: number) {
	const params = new URLSearchParams({
		label_selector: "product=composery-web,role=parking",
		per_page: "50",
		page: String(page)
	});
	return `/volumes?${params.toString()}`;
}

export function parkingVolumeListPath(boxRef: string) {
	const params = new URLSearchParams({
		label_selector: `product=composery-web,role=parking,box_ref=${boxRef}`,
		per_page: "50",
		page: "1"
	});
	return `/volumes?${params.toString()}`;
}

async function existingParkingVolumeId(boxRef: string) {
	const response = await hetznerRequest(
		parkingVolumeListPath(boxRef),
		hetznerPagedVolumeSummariesResponseSchema
	);
	return response.volumes.sort((left, right) =>
		right.created.localeCompare(left.created)
	)[0]?.id;
}

async function waitForVolumeActions(actions: ({ id: number } | undefined)[]) {
	for (const action of actions) {
		if (action?.id) await waitForActionSuccess(action.id);
	}
}

async function getVolume(volumeId: number) {
	const response = await hetznerRequest(
		`/volumes/${volumeId}`,
		hetznerVolumeResponseSchema
	);
	return response.volume;
}

export const createParkingVolume = internalAction({
	args: {
		boxRef: v.string(),
		slug: v.string(),
		location: vServerLocation,
		sizeGb: v.number()
	},
	returns: v.object({ volumeId: v.number(), sizeGb: v.number() }),
	handler: async (_ctx, args) => {
		if (!Number.isSafeInteger(args.sizeGb) || args.sizeGb < 10) {
			throw new Error("A parking volume needs a valid provider disk size.");
		}
		const existing = await existingParkingVolumeId(args.boxRef);
		if (existing) return { volumeId: existing, sizeGb: args.sizeGb };

		let response: z.output<typeof hetznerCreateVolumeResponseSchema>;
		try {
			response = await hetznerRequest(
				"/volumes",
				hetznerCreateVolumeResponseSchema,
				{
					method: "POST",
					body: JSON.stringify(
						createVolumePayload(
							args.slug,
							args.location,
							args.sizeGb,
							args.boxRef
						)
					),
					retry: false
				}
			);
		} catch (error) {
			const recovered = await existingParkingVolumeId(args.boxRef);
			if (recovered) return { volumeId: recovered, sizeGb: args.sizeGb };
			throw error;
		}
		// Wait for create and the format that rides on it, so the box can mount the
		// volume straight away.
		await waitForVolumeActions([response.action, ...response.next_actions]);
		return { volumeId: response.volume.id, sizeGb: args.sizeGb };
	}
});

export const attachParkingVolume = internalAction({
	args: {
		volumeId: v.number(),
		serverId: v.optional(v.number())
	},
	handler: async (_ctx, args) => {
		if (!args.serverId) {
			throw new Error("Box has no Hetzner server to attach the volume to.");
		}
		const volume = await getVolume(args.volumeId);
		// Idempotent: a resumed repair may find it already on this server.
		if (volume.server === args.serverId) return;

		let response: z.output<typeof hetznerActionResponseSchema>;
		try {
			response = await hetznerRequest(
				`/volumes/${args.volumeId}/actions/attach`,
				hetznerActionResponseSchema,
				{
					method: "POST",
					body: JSON.stringify(attachVolumePayload(args.serverId)),
					retry: false
				}
			);
		} catch (error) {
			if ((await getVolume(args.volumeId)).server === args.serverId) return;
			throw error;
		}
		await waitForVolumeActions([response.action]);
	}
});

async function ensureVolumeDetached(volumeId: number) {
	let volume: z.output<typeof hetznerVolumeResponseSchema>["volume"];
	try {
		volume = await getVolume(volumeId);
	} catch (error) {
		if (isNotFound(error)) return;
		throw error;
	}
	if (!volume.server) return;

	let response: z.output<typeof hetznerActionResponseSchema>;
	try {
		response = await hetznerRequest(
			`/volumes/${volumeId}/actions/detach`,
			hetznerActionResponseSchema,
			{ method: "POST", retry: false }
		);
	} catch (error) {
		if (!(await getVolume(volumeId)).server) return;
		throw error;
	}
	await waitForVolumeActions([response.action]);
}

export const detachParkingVolume = internalAction({
	args: { volumeId: v.number() },
	handler: async (_ctx, args) => await ensureVolumeDetached(args.volumeId)
});

export const deleteParkingVolume = internalAction({
	args: { volumeId: v.number() },
	handler: async (_ctx, args) => {
		// Hetzner refuses to delete an attached volume, so detach first (the server
		// may already be gone, in which case it is detached anyway).
		await ensureVolumeDetached(args.volumeId);
		try {
			await hetznerRequest(`/volumes/${args.volumeId}`, undefined, {
				method: "DELETE"
			});
		} catch (error) {
			if (!isNotFound(error)) throw error;
		}
	}
});

// Reconciliation feed: every parking volume we own, fleet-wide, so the cron can
// delete any that no live box still points at.
export const listProductVolumes = internalAction({
	args: {},
	returns: v.array(v.object({ volumeId: v.number(), createdAtMs: v.number() })),
	handler: async () => {
		const volumes: { volumeId: number; createdAtMs: number }[] = [];
		let page: number | null = 1;
		while (page) {
			const body: z.output<typeof hetznerPagedVolumeSummariesResponseSchema> =
				await hetznerRequest(
					productVolumeListPath(page),
					hetznerPagedVolumeSummariesResponseSchema
				);
			for (const volume of body.volumes) {
				volumes.push({
					volumeId: volume.id,
					createdAtMs: parseCreatedMs(volume.created)
				});
			}
			page = body.meta.pagination.next_page;
		}
		return volumes;
	}
});
