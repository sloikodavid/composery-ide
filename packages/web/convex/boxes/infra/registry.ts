import {
	registryConfigSchema,
	registryDescriptorSchema,
	registryDigestSchema,
	registryManifestSchema,
	registryTokenSchema
} from "./registryContracts.ts";
import { decodeProviderResponse } from "./providerResponse.ts";

export type RuntimeRelease = {
	image: string;
	version: string | null;
};

export type ParsedImageReference = {
	registry: string;
	repository: string;
	reference: string;
};

export function parseImageReference(image: string): ParsedImageReference {
	const slash = image.indexOf("/");
	const firstSegment = image.slice(0, slash);
	const hasRegistry =
		slash !== -1 &&
		(firstSegment.includes(".") ||
			firstSegment.includes(":") ||
			firstSegment === "localhost");
	const registry = hasRegistry ? firstSegment : "docker.io";
	const remainder = hasRegistry ? image.slice(slash + 1) : image;

	const at = remainder.lastIndexOf("@");
	const colon = remainder.lastIndexOf(":");
	let reference: string;
	let path: string;
	if (at !== -1) {
		reference = remainder.slice(at + 1);
		path = remainder.slice(0, at);
	} else if (colon === -1) {
		reference = "latest";
		path = remainder;
	} else {
		reference = remainder.slice(colon + 1);
		path = remainder.slice(0, colon);
	}

	const repository =
		registry === "docker.io" && !path.includes("/") ? `library/${path}` : path;

	return { registry, repository, reference };
}

function registryHost(registry: string) {
	return registry === "docker.io" ? "registry-1.docker.io" : registry;
}

export function runtimeImageManifestUrl(image: string) {
	const parsed = parseImageReference(image);
	return `https://${registryHost(parsed.registry)}/v2/${parsed.repository}/manifests/${parsed.reference}`;
}

// prettier-ignore
// Stryker disable next-line StringLiteral: this module-scope mutant is not re-evaluated per worker; applying it by hand fails image.test.ts.
const MANIFEST_ACCEPT = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";

function registryRequests(image: string) {
	const parsed = parseImageReference(image);
	const host = registryHost(parsed.registry);
	let token: string | undefined;

	async function get(path: string, accept: string) {
		const url = `https://${host}/v2/${parsed.repository}/${path}`;
		const headers = () => ({
			Accept: accept,
			...(token ? { Authorization: `Bearer ${token}` } : {})
		});

		let response = await fetch(url, { headers: headers() });
		if (response.status === 401) {
			token = await fetchRegistryToken(
				response.headers.get("www-authenticate")
			);
			response = await fetch(url, { headers: headers() });
		}
		return response;
	}

	return { get, parsed };
}

export async function resolveRelease(image: string): Promise<RuntimeRelease> {
	const resolved = image.includes("@sha256:")
		? image
		: await resolveImageDigest(image);
	return { image: resolved, version: await resolveImageVersion(resolved) };
}

async function resolveImageDigest(image: string) {
	const { get, parsed } = registryRequests(image);
	const response = await get(`manifests/${parsed.reference}`, MANIFEST_ACCEPT);

	if (!response.ok) {
		throw new Error(
			`Unable to resolve runtime image digest: ${response.status}.`
		);
	}

	const digest = registryDigestSchema.safeParse(
		response.headers.get("Docker-Content-Digest")
	);
	if (!digest.success) {
		throw new Error("Registry returned an invalid Docker-Content-Digest.");
	}

	return `${parsed.registry}/${parsed.repository}@${digest.data}`;
}

// Stryker disable next-line StringLiteral: this module-scope mutant is not re-evaluated per worker; applying it by hand fails image.test.ts.
const VERSION_LABEL = "org.opencontainers.image.version";

export function pickLinuxManifest(manifests: unknown): string | undefined {
	if (!Array.isArray(manifests)) return undefined;
	const linux = [];
	for (const entry of manifests) {
		const decoded = registryDescriptorSchema.safeParse(entry);
		if (decoded.success && decoded.data.platform.os === "linux") {
			linux.push(decoded.data);
		}
	}
	const preferred = linux.find(
		(entry) => entry.platform.architecture === "amd64"
	);
	return (preferred ?? linux[0])?.digest;
}

async function responseJson(response: Response) {
	return await response.json().catch(() => undefined);
}

async function resolveImageVersion(image: string): Promise<string | null> {
	const { get, parsed } = registryRequests(image);

	const manifestResponse = await get(
		`manifests/${parsed.reference}`,
		MANIFEST_ACCEPT
	);
	if (!manifestResponse.ok) return null;
	const manifest = registryManifestSchema.safeParse(
		await responseJson(manifestResponse)
	);
	if (!manifest.success) return null;

	let config = manifest.data.config;
	if (!config) {
		const child = pickLinuxManifest(manifest.data.manifests);
		if (!child) return null;
		const childResponse = await get(`manifests/${child}`, MANIFEST_ACCEPT);
		if (!childResponse.ok) return null;
		const childManifest = registryManifestSchema.safeParse(
			await responseJson(childResponse)
		);
		if (!childManifest.success) return null;
		config = childManifest.data.config;
	}

	if (!config) return null;
	const blobResponse = await get(`blobs/${config.digest}`, "*/*");
	if (!blobResponse.ok) return null;

	const blob = registryConfigSchema.safeParse(await responseJson(blobResponse));
	if (!blob.success) return null;
	const version = blob.data.config?.Labels?.[VERSION_LABEL];
	return typeof version === "string" && version.trim() ? version.trim() : null;
}

export function registryTokenUrl(challenge: string | null) {
	if (!challenge) throw new Error("Registry did not return auth challenge.");
	const separator = challenge.indexOf(" ");
	const scheme = challenge.slice(0, separator).toLowerCase();
	const parameters = challenge.slice(separator + 1);
	if (scheme !== "bearer" || !parameters) {
		throw new Error("Registry auth challenge is not Bearer.");
	}

	const params: Record<string, string> = {};
	const pattern =
		/(?:^|,)\s*([A-Za-z][\w-]*)\s*=\s*(?:"((?:\\.|[^"])*)"|([^,\s]+))/g;
	for (const match of parameters.matchAll(pattern)) {
		params[match[1]] = (match[2] ?? match[3]).replace(/\\(.)/g, "$1");
	}

	if (!params.realm) throw new Error("Registry auth challenge missing realm.");

	const url = new URL(params.realm);
	if (params.service) url.searchParams.set("service", params.service);
	if (params.scope) url.searchParams.set("scope", params.scope);
	return url;
}

async function fetchRegistryToken(challenge: string | null) {
	const response = await fetch(registryTokenUrl(challenge));
	if (!response.ok) throw new Error("Unable to fetch registry auth token.");
	const body = decodeProviderResponse(
		"registry token",
		registryTokenSchema,
		await responseJson(response)
	);
	const token = body.token ?? body.access_token;
	if (!token)
		throw new Error("Registry token response did not contain a token.");
	return token;
}
