import ssh2 from "ssh2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "@/convex/_generated/api";
import {
	seedBox,
	seedUser,
	stubDeploymentEnv,
	testConvex
} from "../../../../support/convex.ts";
import {
	hetznerRetryDelayMs,
	HetznerApiError,
	isRetryableHetznerError
} from "@/convex/boxes/infra/hetznerVps";

const privateKey = ssh2.utils
	.generateKeyPairSync("ed25519", { comment: "provider-test" })
	.private.replace(/\n/g, "\\n");

function response(body: unknown, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => (body === undefined ? "" : JSON.stringify(body))
	} as Response;
}

// One recorded request, as the arguments fetch was actually called with.
// Indexing `mock.calls` directly types the call as an empty tuple whenever the
// stub was written without parameters, so a test reading the second request
// asks for element one of nothing - which the checker rejects and a reader
// cannot see. Asking through here says which call is missing instead.
function requestAt(fetch: ReturnType<typeof vi.fn>, index: number) {
	const call = fetch.mock.calls[index] as [string, RequestInit] | undefined;
	if (!call) {
		throw new Error(`fetch was called fewer than ${index + 1} times.`);
	}
	return { init: call[1] ?? {}, url: String(call[0]) };
}

function queuedFetch(
	...replies: { body?: unknown; status?: number }[]
): ReturnType<typeof vi.fn> {
	const fetch = vi.fn(async () => {
		const reply = replies.shift();
		if (!reply) throw new Error("The provider received an unexpected request.");
		return response(reply.body, reply.status);
	});
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

function server(status = "running", rescueEnabled = false) {
	return {
		id: 42,
		name: "composery-atlas",
		rescue_enabled: rescueEnabled,
		status,
		created: "2026-08-01T00:00:00Z",
		public_net: {
			ipv4: { ip: "1.2.3.4" },
			ipv6: { ip: "2a01::1/64" }
		},
		server_type: { name: "cx23" },
		location: { name: "nbg1" }
	};
}

function snapshot() {
	return {
		id: 91,
		type: "snapshot",
		status: "creating",
		image_size: null,
		disk_size: 40,
		created: "2026-08-01T00:00:00Z",
		description: "atlas",
		labels: { product: "composery-web", snapshot_ref: "snapshot123" },
		bound_to: null,
		created_from: { id: 42, name: "composery-atlas" }
	};
}

function runPollsImmediately() {
	vi.spyOn(globalThis, "setTimeout").mockImplementation((callback) => {
		if (typeof callback === "function") callback();
		return 0 as unknown as ReturnType<typeof setTimeout>;
	});
}

beforeEach(() => {
	stubDeploymentEnv();
	vi.stubEnv("HETZNER_CLOUD_TOKEN", "token");
	vi.stubEnv("HETZNER_BOX_IMAGE", "ubuntu-24.04");
	vi.stubEnv("HETZNER_FIREWALL_ID", "42");
	vi.stubEnv("HETZNER_SSH_KEYS", "123,456");
	vi.stubEnv("HOST_SSH_PRIVATE_KEY", privateKey);
	vi.stubEnv("HOST_SSH_USER", "root");
	vi.stubEnv("CLOUDFLARE_DNS_TOKEN", "token");
	vi.stubEnv("CLOUDFLARE_ZONE_ID", "zone");
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("the Hetzner response boundary", () => {
	test("uses the official bounded transient-error policy", () => {
		for (const [status, code] of [
			[409, "conflict"],
			[429, "rate_limit_exceeded"],
			[502, undefined],
			[502, "bad_gateway"],
			[504, "timeout"]
		] as const) {
			expect(
				isRetryableHetznerError(new HetznerApiError("transient", status, code))
			).toBe(true);
		}
		expect(
			isRetryableHetznerError(
				new HetznerApiError("operator input", 422, "invalid_input")
			)
		).toBe(false);
	});

	test("backs off exponentially with bounded jitter", () => {
		expect(hetznerRetryDelayMs(0, () => 0)).toBe(1_000);
		expect(hetznerRetryDelayMs(1, () => 0)).toBe(1_000);
		expect(hetznerRetryDelayMs(1, () => 1)).toBe(2_000);
		expect(hetznerRetryDelayMs(20, () => 1)).toBe(60_000);
	});

	test("retries a transient gateway response", async () => {
		runPollsImmediately();
		const fetch = queuedFetch(
			{ body: "upstream unavailable", status: 502 },
			{ body: { action: { id: 7, status: "success", error: null } } }
		);

		await expect(
			testConvex().action(internal.boxes.infra.hetznerVps.getAction, {
				actionId: 7
			})
		).resolves.toEqual({ status: "success" });
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	test("retries a network failure", async () => {
		runPollsImmediately();
		const replies: (Error | Response)[] = [
			new TypeError("fetch failed"),
			response({ action: { id: 7, status: "success", error: null } })
		];
		const fetch = vi.fn(async () => {
			const reply = replies.shift();
			if (reply instanceof Error) throw reply;
			if (reply) return reply;
			throw new Error("The provider received an unexpected request.");
		});
		vi.stubGlobal("fetch", fetch);

		await expect(
			testConvex().action(internal.boxes.infra.hetznerVps.getAction, {
				actionId: 7
			})
		).resolves.toEqual({ status: "success" });
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	test("does not retry an operator error", async () => {
		runPollsImmediately();
		const fetch = queuedFetch({
			body: { error: { code: "invalid_input", message: "bad request" } },
			status: 422
		});

		await expect(
			testConvex().action(internal.boxes.infra.hetznerVps.getAction, {
				actionId: 7
			})
		).rejects.toThrow("bad request");
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	test("decodes a documented action response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				response({ action: { id: 7, status: "success", error: null } })
			)
		);

		await expect(
			testConvex().action(internal.boxes.infra.hetznerVps.getAction, {
				actionId: 7
			})
		).resolves.toEqual({ status: "success" });
	});

	test("rejects a successful response whose consumed id changed", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				response({
					action: { action_id: 7, status: "success", error: null }
				})
			)
		);

		await expect(
			testConvex().action(internal.boxes.infra.hetznerVps.getAction, {
				actionId: 7
			})
		).rejects.toThrow("Invalid Hetzner response at action.id");
	});

	test("creates a server and waits for the provider's authoritative placement", async () => {
		runPollsImmediately();
		const fetch = queuedFetch(
			{ body: { servers: [] } },
			{ body: { server: server("initializing") }, status: 201 },
			{ body: { server: server("initializing") } },
			{ body: { server: server() } }
		);
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, { user_id: owner.clerkUserId });

		await expect(
			t.action(internal.boxes.infra.hetznerVps.createServer, {
				boxId,
				serverType: "cx23",
				slug: "atlas"
			})
		).resolves.toMatchObject({
			serverId: 42,
			serverType: "cx23",
			location: "nbg1"
		});
		expect(fetch).toHaveBeenCalledTimes(4);
		expect(fetch.mock.calls[1][1]).toMatchObject({ method: "POST" });
	});

	test("resumes a prior labelled create without creating another server", async () => {
		const fetch = queuedFetch(
			{ body: { servers: [server()] } },
			{ body: { server: server() } }
		);
		const t = testConvex();
		const owner = await seedUser(t);
		const boxId = await seedBox(t, { user_id: owner.clerkUserId });

		await expect(
			t.action(internal.boxes.infra.hetznerVps.createServer, {
				boxId,
				serverType: "cx23",
				slug: "atlas"
			})
		).resolves.toMatchObject({ serverId: 42 });
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch.mock.calls.every((call) => call[1]?.method !== "POST")).toBe(
			true
		);
	});

	test("waits for a rebuild action and then reads the rebuilt server", async () => {
		runPollsImmediately();
		queuedFetch(
			{
				body: { action: { id: 7, status: "running", error: null } },
				status: 201
			},
			{ body: { action: { id: 7, status: "running", error: null } } },
			{ body: { action: { id: 7, status: "success", error: null } } },
			{ body: { server: server() } }
		);

		await expect(
			testConvex().action(internal.boxes.infra.hetznerVps.rebuildServer, {
				serverId: 42,
				image: "ubuntu-24.04"
			})
		).resolves.toMatchObject({ serverId: 42 });
	});

	test("rejects a successful get that omits its server", async () => {
		queuedFetch(
			{
				body: { action: { id: 7, status: "running", error: null } },
				status: 201
			},
			{ body: { action: { id: 7, status: "success", error: null } } },
			{ body: {} }
		);

		await expect(
			testConvex().action(internal.boxes.infra.hetznerVps.rebuildServer, {
				serverId: 42,
				image: "ubuntu-24.04"
			})
		).rejects.toThrow("Hetzner did not return server 42");
	});

	test("waits until a deleted server returns the provider's not-found error", async () => {
		runPollsImmediately();
		queuedFetch(
			{ body: { server: server() } },
			{
				body: { error: { code: "not_found", message: "Server not found" } },
				status: 404
			}
		);

		await expect(
			testConvex().action(internal.boxes.infra.hetznerVps.waitServerDeleted, {
				serverId: 42
			})
		).resolves.toBeNull();
	});

	test("shuts down a running server and polls until it is off", async () => {
		runPollsImmediately();
		const fetch = queuedFetch(
			{ body: { server: server() } },
			{
				body: { action: { id: 7, status: "running", error: null } },
				status: 201
			},
			{ body: { server: server("running") } },
			{ body: { server: server("off") } }
		);

		await expect(
			testConvex().action(internal.boxes.infra.hetznerVps.stopServer, {
				serverId: 42
			})
		).resolves.toBeNull();
		expect(fetch.mock.calls[1][0]).toContain("/actions/shutdown");
	});

	test("boots the provider rescue OS with the configured recovery keys", async () => {
		runPollsImmediately();
		const fetch = queuedFetch(
			{ body: { server: server("off") } },
			{
				body: { action: { id: 7, status: "running", error: null } },
				status: 201
			},
			{ body: { action: { id: 7, status: "success", error: null } } },
			{
				body: { action: { id: 8, status: "running", error: null } },
				status: 201
			},
			{ body: { action: { id: 8, status: "success", error: null } } },
			{ body: { server: server("running", true) } }
		);

		await expect(
			testConvex().action(internal.boxes.infra.hetznerVps.bootServerInRescue, {
				serverId: 42
			})
		).resolves.toBeNull();
		expect(requestAt(fetch, 1).url).toContain("/actions/enable_rescue");
		expect(JSON.parse(String(requestAt(fetch, 1).init.body))).toEqual({
			type: "linux64",
			ssh_keys: [123, 456]
		});
		expect(requestAt(fetch, 3).url).toContain("/actions/poweron");
	});

	test("accepts a lost rescue-enable response once the provider reports it enabled", async () => {
		runPollsImmediately();
		const replies: (Error | Response)[] = [
			response({ server: server("off") }),
			new TypeError("connection closed after request"),
			response({ server: server("off", true) }),
			response({ action: { id: 8, status: "success", error: null } }, 201),
			response({ action: { id: 8, status: "success", error: null } }),
			response({ server: server("running", true) })
		];
		const fetch = vi.fn(async () => {
			const reply = replies.shift();
			if (reply instanceof Error) throw reply;
			if (reply) return reply;
			throw new Error("The provider received an unexpected request.");
		});
		vi.stubGlobal("fetch", fetch);

		await expect(
			testConvex().action(internal.boxes.infra.hetznerVps.bootServerInRescue, {
				serverId: 42
			})
		).resolves.toBeNull();
		expect(requestAt(fetch, 3).url).toContain("/actions/poweron");
	});

	test("accepts a lost rescue power-on response once the server is running", async () => {
		runPollsImmediately();
		const replies: (Error | Response)[] = [
			response({ server: server("off", true) }),
			new TypeError("connection closed after request"),
			response({ server: server("running", true) })
		];
		const fetch = vi.fn(async () => {
			const reply = replies.shift();
			if (reply instanceof Error) throw reply;
			if (reply) return reply;
			throw new Error("The provider received an unexpected request.");
		});
		vi.stubGlobal("fetch", fetch);

		await expect(
			testConvex().action(internal.boxes.infra.hetznerVps.bootServerInRescue, {
				serverId: 42
			})
		).resolves.toBeNull();
		expect(requestAt(fetch, 1).url).toContain("/actions/poweron");
	});

	test("accepts a power-on whose response was lost once the server is running", async () => {
		runPollsImmediately();
		const replies: (Error | Response)[] = [
			response({ server: server("off") }),
			new TypeError("connection closed after request"),
			response({ server: server("running") })
		];
		const fetch = vi.fn(async () => {
			const reply = replies.shift();
			if (reply instanceof Error) throw reply;
			if (reply) return reply;
			throw new Error("The provider received an unexpected request.");
		});
		vi.stubGlobal("fetch", fetch);

		await expect(
			testConvex().action(internal.boxes.infra.hetznerVps.powerOnServer, {
				serverId: 42
			})
		).resolves.toBeNull();
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(requestAt(fetch, 1).url).toContain("/actions/poweron");
	});

	test("accepts an attach whose response was lost once the volume is attached", async () => {
		const replies: (Error | Response)[] = [
			response({ volume: { server: null } }),
			new TypeError("connection closed after request"),
			response({ volume: { server: 42 } })
		];
		const fetch = vi.fn(async () => {
			const reply = replies.shift();
			if (reply instanceof Error) throw reply;
			if (reply) return reply;
			throw new Error("The provider received an unexpected request.");
		});
		vi.stubGlobal("fetch", fetch);

		await expect(
			testConvex().action(internal.boxes.infra.hetznerVps.attachParkingVolume, {
				serverId: 42,
				volumeId: 9
			})
		).resolves.toBeNull();
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(requestAt(fetch, 1).url).toContain("/actions/attach");
	});

	test("recovers a snapshot whose create response was lost without creating twice", async () => {
		const replies: (Error | Response)[] = [
			response({ images: [] }),
			new TypeError("connection closed after request"),
			response({ images: [snapshot()] })
		];
		const fetch = vi.fn(async () => {
			const reply = replies.shift();
			if (reply instanceof Error) throw reply;
			if (reply) return reply;
			throw new Error("The provider received an unexpected request.");
		});
		vi.stubGlobal("fetch", fetch);

		await expect(
			testConvex().action(internal.boxes.infra.hetznerVps.createSnapshotImage, {
				serverId: 42,
				slug: "atlas",
				snapshotClass: "manual",
				snapshotRef: "snapshot123"
			})
		).resolves.toEqual({ imageId: 91 });
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(requestAt(fetch, 1).init.method).toBe("POST");
		expect(
			JSON.parse(String(requestAt(fetch, 1).init.body)).labels.snapshot_ref
		).toBe("snapshot123");
	});
});

describe("the Cloudflare response boundary", () => {
	const record = (id: string, type: "A" | "AAAA", content: string) => ({
		id,
		name: "atlas.dev.composery.cloud",
		type,
		content
	});

	test("decodes the records used to reconcile both addresses", async () => {
		const replies = [
			{ success: true, result: [record("a", "A", "1.2.3.4")] },
			{ success: true, result: [record("aaaa", "AAAA", "2a01::1")] }
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response(replies.shift()))
		);

		await expect(
			testConvex().action(
				internal.boxes.infra.cloudflareDns.createRuntimeDnsRecords,
				{ ipv4: "1.2.3.4", ipv6: "2a01::1", slug: "atlas" }
			)
		).resolves.toEqual({ aRecordId: "a", aaaaRecordId: "aaaa" });
	});

	test("rejects a record whose consumed id changed", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				response({
					success: true,
					result: [
						{
							record_id: "a",
							name: "atlas.dev.composery.cloud",
							type: "A",
							content: "1.2.3.4"
						}
					]
				})
			)
		);

		await expect(
			testConvex().action(
				internal.boxes.infra.cloudflareDns.createRuntimeDnsRecords,
				{ ipv4: "1.2.3.4", ipv6: "2a01::1", slug: "atlas" }
			)
		).rejects.toThrow("Invalid Cloudflare response at 0.id");
	});

	test("updates a stale address and creates the missing address", async () => {
		const fetch = queuedFetch(
			{ body: { success: true, result: [record("old", "A", "9.9.9.9")] } },
			{ body: { success: true, result: record("a", "A", "1.2.3.4") } },
			{ body: { success: true, result: [] } },
			{
				body: {
					success: true,
					result: record("aaaa", "AAAA", "2a01::1")
				}
			}
		);

		await expect(
			testConvex().action(
				internal.boxes.infra.cloudflareDns.createRuntimeDnsRecords,
				{ ipv4: "1.2.3.4", ipv6: "2a01::1", slug: "atlas" }
			)
		).resolves.toEqual({ aRecordId: "a", aaaaRecordId: "aaaa" });
		expect(fetch.mock.calls[1][1]).toMatchObject({ method: "PATCH" });
		expect(fetch.mock.calls[3][1]).toMatchObject({ method: "POST" });
	});

	test("deletes every recorded address and accepts one already being absent", async () => {
		const fetch = queuedFetch(
			{
				body: { success: false, errors: [{ message: "not found" }] },
				status: 404
			},
			{ body: { result: { id: "aaaa" } } }
		);

		await expect(
			testConvex().action(
				internal.boxes.infra.cloudflareDns.deleteRuntimeDnsRecords,
				{ aRecordId: "a", aaaaRecordId: "aaaa" }
			)
		).resolves.toBeNull();
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});
