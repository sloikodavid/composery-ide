import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "@/convex/_generated/api";
import {
	parseImageReference,
	pickLinuxManifest,
	registryTokenUrl,
	resolveRelease,
	runtimeImageManifestUrl
} from "@/convex/boxes/infra/registry";
import { testConvex } from "../../../../support/convex.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;
const CONFIG = `sha256:${"c".repeat(64)}`;
const CHILD = `sha256:${"d".repeat(64)}`;
const challenge =
	'Bearer realm="https://auth.test/token",service="registry.test",scope="repository:team/image:pull"';

type Reply = {
	body?: unknown;
	digest?: string | null;
	jsonError?: boolean;
	status?: number;
	wwwAuthenticate?: string;
};

function response({
	body,
	digest = DIGEST,
	jsonError = false,
	status = 200,
	wwwAuthenticate
}: Reply = {}) {
	const headers = new Headers();
	if (digest) headers.set("Docker-Content-Digest", digest);
	if (wwwAuthenticate) headers.set("www-authenticate", wwwAuthenticate);
	return {
		ok: status >= 200 && status < 300,
		status,
		headers,
		json: async () => {
			if (jsonError) throw new SyntaxError("invalid JSON");
			return body;
		}
	} as Response;
}

function queuedFetch(...replies: Reply[]) {
	let nextReply = 0;
	const fetch = vi.fn(
		async (_input: RequestInfo | URL, _init?: RequestInit) => {
			const reply = replies[nextReply++];
			if (!reply)
				throw new Error("The registry received an unexpected request.");
			return response(reply);
		}
	);
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

const configManifest = { config: { digest: CONFIG } };
const labelledConfig = (version: unknown = "1.4.0") => ({
	config: { Labels: { "org.opencontainers.image.version": version } }
});
const index = (os = "linux", architecture = "amd64") => ({
	manifests: [{ digest: CHILD, platform: { architecture, os } }]
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("an image reference", () => {
	test.each([
		[
			"a bare Docker Hub name",
			"nginx",
			{
				registry: "docker.io",
				repository: "library/nginx",
				reference: "latest"
			}
		],
		[
			"a Docker Hub namespace",
			"team/image:edge",
			{ registry: "docker.io", repository: "team/image", reference: "edge" }
		],
		[
			"a registry with a port",
			"registry.test:5000/team/image:edge",
			{
				registry: "registry.test:5000",
				repository: "team/image",
				reference: "edge"
			}
		],
		[
			"localhost",
			"localhost/image",
			{ registry: "localhost", repository: "image", reference: "latest" }
		],
		[
			"an immutable digest",
			`ghcr.io/team/image@${DIGEST}`,
			{ registry: "ghcr.io", repository: "team/image", reference: DIGEST }
		]
	] as const)("parses %s", (_name, image, expected) => {
		expect(parseImageReference(image)).toEqual(expected);
	});

	test("builds the Registry V2 manifest URL", () => {
		expect(runtimeImageManifestUrl("nginx:edge")).toBe(
			"https://registry-1.docker.io/v2/library/nginx/manifests/edge"
		);
		expect(runtimeImageManifestUrl(`ghcr.io/team/image@${DIGEST}`)).toBe(
			`https://ghcr.io/v2/team/image/manifests/${DIGEST}`
		);
	});
});

describe("a multi-platform manifest", () => {
	test("selects Linux deterministically and ignores malformed entries", () => {
		expect(
			pickLinuxManifest([
				null,
				{ digest: DIGEST },
				{
					digest: "not-a-digest",
					platform: { os: "linux", architecture: "amd64" }
				},
				{ digest: DIGEST, platform: { os: "windows", architecture: "amd64" } },
				{ digest: CHILD, platform: { os: "linux", architecture: "arm64" } },
				{ digest: DIGEST, platform: { os: "linux", architecture: "amd64" } }
			])
		).toBe(DIGEST);
		expect(pickLinuxManifest(index("linux", "arm64").manifests)).toBe(CHILD);
		expect(pickLinuxManifest(index("windows").manifests)).toBeUndefined();
		expect(pickLinuxManifest(undefined)).toBeUndefined();
	});
});

describe("a registry authentication challenge", () => {
	test("preserves the realm, service, scope, and quoted equals signs", () => {
		const url = registryTokenUrl(
			'Bearer   realm="https://auth.test/token?seed=a=b",service="registry.test",scope="repository:team/say-\\"hi\\":pull"'
		);

		expect(url.origin + url.pathname).toBe("https://auth.test/token");
		expect(url.searchParams.get("seed")).toBe("a=b");
		expect(url.searchParams.get("service")).toBe("registry.test");
		expect(url.searchParams.get("scope")).toBe('repository:team/say-"hi":pull');
	});

	test("accepts unquoted parameters and omits absent parameters", () => {
		const full = registryTokenUrl(
			"Bearer realm=https://auth.test/token,service=registry.test,scope=repository:team/image:pull"
		);
		expect(full.searchParams.get("service")).toBe("registry.test");
		expect(full.searchParams.get("scope")).toBe("repository:team/image:pull");

		const realmOnly = registryTokenUrl(
			'Bearer realm="https://auth.test/token"'
		);
		expect(realmOnly.search).toBe("");
	});

	test.each([
		[null, "Registry did not return auth challenge"],
		[
			'Basic realm="https://auth.test"',
			"Registry auth challenge is not Bearer"
		],
		[
			'Basic Bearer realm="https://auth.test"',
			"Registry auth challenge is not Bearer"
		],
		['Bearer service="registry.test"', "Registry auth challenge missing realm"]
	] as const)("rejects an unusable challenge", (value, message) => {
		expect(() => registryTokenUrl(value)).toThrow(message);
	});
});

describe("resolving a registry release", () => {
	test("pins a tag and reads its multi-platform version label", async () => {
		const fetch = queuedFetch(
			{},
			{ body: index() },
			{ body: configManifest },
			{ body: labelledConfig(" 1.4.0\n") }
		);

		await expect(resolveRelease("ghcr.io/team/image:edge")).resolves.toEqual({
			image: `ghcr.io/team/image@${DIGEST}`,
			version: "1.4.0"
		});
		expect(fetch).toHaveBeenCalledTimes(4);
		expect(fetch.mock.calls.map((call) => String(call[0]))).toEqual([
			"https://ghcr.io/v2/team/image/manifests/edge",
			`https://ghcr.io/v2/team/image/manifests/${DIGEST}`,
			`https://ghcr.io/v2/team/image/manifests/${CHILD}`,
			`https://ghcr.io/v2/team/image/blobs/${CONFIG}`
		]);
		expect(fetch.mock.calls[0][1]).toMatchObject({
			headers: expect.objectContaining({
				Accept: expect.stringContaining(
					"application/vnd.oci.image.index.v1+json"
				)
			})
		});
		expect(fetch.mock.calls[3][1]).toMatchObject({
			headers: expect.objectContaining({ Accept: "*/*" })
		});
	});

	test("does not resolve an already pinned digest again", async () => {
		const fetch = queuedFetch(
			{ body: configManifest },
			{ body: labelledConfig() }
		);

		await expect(
			resolveRelease(`ghcr.io/team/image@${DIGEST}`)
		).resolves.toEqual({
			image: `ghcr.io/team/image@${DIGEST}`,
			version: "1.4.0"
		});
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	test.each([
		[
			"the manifest is refused",
			[{ status: 500, body: configManifest }, { body: labelledConfig() }]
		],
		["the manifest is not JSON", [{ jsonError: true }]],
		["the manifest has the wrong shape", [{ body: { config: { digest: 7 } } }]],
		["the index has no Linux image", [{ body: index("windows") }]],
		[
			"the platform manifest is refused",
			[
				{ body: index() },
				{ status: 404, body: configManifest },
				{ body: labelledConfig() }
			]
		],
		[
			"the platform manifest is malformed",
			[{ body: index() }, { jsonError: true }]
		],
		["the platform manifest has no config", [{ body: index() }, { body: {} }]],
		[
			"the config blob is refused",
			[{ body: configManifest }, { status: 403, body: labelledConfig() }]
		],
		[
			"the config blob is malformed",
			[{ body: configManifest }, { jsonError: true }]
		],
		[
			"the config blob has no config object",
			[{ body: configManifest }, { body: {} }]
		],
		[
			"the config object has no labels",
			[{ body: configManifest }, { body: { config: {} } }]
		],
		[
			"the version label is absent",
			[{ body: configManifest }, { body: { config: { Labels: {} } } }]
		],
		[
			"the version label is blank",
			[{ body: configManifest }, { body: labelledConfig("  ") }]
		]
	] as const)("keeps the digest when %s", async (_name, versionReplies) => {
		queuedFetch({}, ...versionReplies);
		await expect(resolveRelease("ghcr.io/team/image:edge")).resolves.toEqual({
			image: `ghcr.io/team/image@${DIGEST}`,
			version: null
		});
	});

	test.each([
		[{ status: 404 }, "Unable to resolve runtime image digest: 404"],
		[{ digest: null }, "Registry returned an invalid Docker-Content-Digest"],
		[
			{ digest: "sha256:not-a-digest" },
			"Registry returned an invalid Docker-Content-Digest"
		]
	] as const)("rejects a tag it cannot pin", async (reply, message) => {
		queuedFetch(reply);
		await expect(resolveRelease("ghcr.io/team/image:edge")).rejects.toThrow(
			message
		);
	});

	test("authenticates each registry walk and accepts access_token", async () => {
		const fetch = queuedFetch(
			{ status: 401, wwwAuthenticate: challenge },
			{ body: { access_token: "issued" }, digest: null },
			{},
			{ status: 401, wwwAuthenticate: challenge },
			{ body: { access_token: "issued" }, digest: null },
			{ body: configManifest },
			{ body: labelledConfig() }
		);

		await expect(resolveRelease("ghcr.io/team/image:edge")).resolves.toEqual({
			image: `ghcr.io/team/image@${DIGEST}`,
			version: "1.4.0"
		});
		expect(fetch.mock.calls[2][1]).toMatchObject({
			headers: expect.objectContaining({ Authorization: "Bearer issued" })
		});
		expect(fetch.mock.calls[6][1]).toMatchObject({
			headers: expect.objectContaining({ Authorization: "Bearer issued" })
		});
	});

	test.each([
		[
			[{ status: 401, wwwAuthenticate: challenge }, { status: 403 }],
			"Unable to fetch registry auth token"
		],
		[
			[{ status: 401, wwwAuthenticate: challenge }, { body: {} }],
			"Registry token response did not contain a token"
		],
		[
			[
				{ status: 401, wwwAuthenticate: challenge },
				{ jsonError: true, digest: null }
			],
			"Invalid registry token response"
		]
	] as const)(
		"rejects an unusable token response",
		async (replies, message) => {
			queuedFetch(...replies);
			await expect(resolveRelease("ghcr.io/team/image:edge")).rejects.toThrow(
				message
			);
		}
	);
});

describe("the Convex registry actions", () => {
	test("resolve an explicit image and the configured channel", async () => {
		vi.stubEnv("RUNTIME_IMAGE", "ghcr.io/team/image:edge");
		queuedFetch(
			{},
			{ body: configManifest },
			{ body: labelledConfig() },
			{},
			{ body: configManifest },
			{ body: labelledConfig() }
		);
		const t = testConvex();

		await expect(
			t.action(internal.boxes.infra.image.resolveRuntimeRelease, {
				image: "ghcr.io/team/image:edge"
			})
		).resolves.toMatchObject({ image: `ghcr.io/team/image@${DIGEST}` });
		await expect(
			t.action(internal.boxes.infra.image.resolveConfiguredRuntimeRelease, {})
		).resolves.toMatchObject({ image: `ghcr.io/team/image@${DIGEST}` });
	});
});
