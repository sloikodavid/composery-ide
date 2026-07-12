export const COMPOSERY_COMPOSE_PATH = "/opt/composery-web/compose.yaml";
export const COMPOSERY_ENV_PATH = "/opt/composery-web/composery.env";
export const COMPOSERY_CADDYFILE_PATH = "/opt/composery-web/Caddyfile";
export const COMPOSERY_VOLUME_NAMES = [
	"composery_data",
	"composery_caddy_data",
	"composery_caddy_config"
] as const;
// renovate: datasource=docker depName=caddy
export const CADDY_IMAGE =
	"caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648";

// The port the host's own sshd listens on, which is deliberately not 22.
//
// Port 22 belongs to the instance: a box is meant to be reachable the way any
// server is, and `ssh box.example.com` with no `-p` is most of what that means.
// The control plane has no such need - nobody types it - so it moves out of the
// way. This also has to happen on the very first boot, before the runtime is
// ever brought up, because the container shares the host's network stack and its
// sshd would otherwise find port 22 already taken.
export const HOST_SSH_PORT = 2222;

export type RuntimeArtifacts = {
	caddyfile: string;
	compose: string;
	env: string;
};

// Both containers share the host's network stack, so there is no compose network
// to resolve a service name on - the editor is simply a port on this machine.
//
// A custom domain is served *alongside* the managed one, never instead of it.
// The managed name is how the control plane and the owner always reach a box, so
// a registrar change or an expired domain costs its own certificate and nothing
// else. Caddy obtains one per name in the block.
export function renderCaddyfile(
	domain: string,
	runtimePort: number,
	customDomain?: string
) {
	const names = [domain, customDomain].filter(Boolean).join(", ");
	return `${names} {
\tencode gzip
\treverse_proxy 127.0.0.1:${runtimePort}
}
`;
}

// The box's env file: the three variables the website manages, then whatever the
// owner has configured.
//
// `config` is written last but can never shadow a managed variable, because
// `normalizeRuntimeConfig` only admits keys on its allowlist and none of the
// three below are on it. The ordering is therefore presentational, not a
// precedence mechanism - do not turn it into one.
//
// This function is the reason a saved configuration survives the box's
// lifecycle. Every path that rewrites the env file goes through here from the
// box row: bootstrap, repair, reset, an update, and a password change. If the
// owner's variables were held anywhere but the row - passed once at save time
// and not stored - the next Reset or Repair would render an env file without
// them and quietly revert every setting the owner had made.
export function renderComposeryEnv({
	cloudBoxId,
	cloudOrigin,
	config,
	runtimeAuthHash,
	runtimeImage
}: {
	cloudBoxId?: string;
	cloudOrigin?: string;
	config?: Readonly<Record<string, string>>;
	runtimeAuthHash?: string;
	runtimeImage?: string;
}) {
	if (Boolean(cloudBoxId) !== Boolean(cloudOrigin)) {
		throw new Error("Cloud box id and origin must be configured together.");
	}

	const managed = [
		runtimeAuthHash
			? `COMPOSERY_HASHED_PASSWORD=${quoteEnvFileValue(runtimeAuthHash)}`
			: undefined,
		cloudBoxId
			? `COMPOSERY_CLOUD_BOX_ID=${quoteEnvFileValue(cloudBoxId)}`
			: undefined,
		cloudOrigin
			? `COMPOSERY_CLOUD_ORIGIN=${quoteEnvFileValue(cloudOrigin)}`
			: undefined,
		// The digest this container was started as, told to the box rather than
		// derived by it.
		//
		// An image cannot contain its own digest: the digest is the hash of the
		// manifest, which covers the config holding the image's own environment and
		// labels, so writing the answer in changes it. That fixed point is why the
		// build can only stamp a version *label* (COMPOSERY_BUILD_VERSION), and why
		// the box could otherwise only compare labels while the website compares
		// digests - leaving the editor able to say "current" about a rebuild the
		// box page correctly offered an update for.
		//
		// There is no chicken and egg here though, because the box does not have to
		// work it out. The website resolved this digest and wrote it into the very
		// compose file that starts the container, so it is exactly what Docker
		// pulled. Passing the same string through the env file costs nothing and
		// lets both surfaces answer from the same fact.
		runtimeImage
			? `COMPOSERY_RUNTIME_IMAGE=${quoteEnvFileValue(runtimeImage)}`
			: undefined
	].filter(Boolean) as string[];

	// Sorted so an unchanged configuration renders an identical file every time.
	// Compose decides whether to recreate a container partly from this file, and
	// a stable order keeps a repair or a password change from looking like a
	// configuration change.
	const owner = Object.keys(config ?? {})
		.sort()
		.map((key) => {
			if (MANAGED_ENV_KEYS.has(key)) {
				throw new Error(
					`${key} is managed by Composery and cannot be set as box configuration.`
				);
			}
			return `${key}=${quoteEnvFileValue((config ?? {})[key])}`;
		});

	return [...managed, ...owner].join("\n").concat("\n");
}

// Belt and braces against the allowlist being widened carelessly later. The
// allowlist is the real gate; this makes the consequence of getting it wrong a
// loud failure at render time rather than a box that silently loses its password
// or its link to the control plane.
const MANAGED_ENV_KEYS = new Set([
	"COMPOSERY_HASHED_PASSWORD",
	"COMPOSERY_PASSWORD",
	"COMPOSERY_CLOUD_BOX_ID",
	"COMPOSERY_CLOUD_ORIGIN",
	"COMPOSERY_RUNTIME_IMAGE"
]);

function quoteEnvFileValue(value: string) {
	if (/[\r\n']/.test(value)) {
		throw new Error("Env file values must be single-line shell values.");
	}
	return `'${value}'`;
}

// Both services run on the host's own network stack.
//
// This is what makes a box behave like the server an owner paid for rather than a
// container with three holes in it. A bridged network can only ever publish the
// ports this file names, so running a database, a game server, or anything else
// on an ordinary port was impossible - not discouraged, impossible. On the host
// stack a process an owner starts binds the machine's real interface, and what is
// reachable becomes a firewall decision they can make instead of a compose file
// they cannot edit.
//
// Three consequences, each handled rather than tolerated:
//
//   - There is no compose network, so Caddy reaches the editor at 127.0.0.1
//     rather than by service name (`renderCaddyfile`).
//   - Nothing is published or exposed, because there is no boundary left to
//     publish through: a bind is already on the interface.
//   - The editor's own port would be on that interface too, so COMPOSERY_BIND
//     pins it to loopback. Only Caddy is meant to reach it, and the firewall is
//     no longer the thing keeping that true.
//
// SSH is the reason the ordering matters elsewhere: the instance's sshd takes
// port 22 here, so a host's own sshd has to have moved to the control port
// first. `renderCloudInitUserData` does that on the very first boot.
export function renderCompose(runtimeImage: string, runtimePort: number) {
	const [dataVolume, caddyDataVolume, caddyConfigVolume] =
		COMPOSERY_VOLUME_NAMES;
	return `x-logging: &logging
  driver: local

services:
  caddy:
    image: ${CADDY_IMAGE}
    container_name: caddy
    restart: always
    logging: *logging
    network_mode: host
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ${caddyDataVolume}:/data
      - ${caddyConfigVolume}:/config
    depends_on:
      composery:
        condition: service_healthy

  composery:
    image: ${runtimeImage}
    container_name: composery
    restart: always
    logging: *logging
    init: true
    network_mode: host
    env_file: ./composery.env
    environment:
      - COMPOSERY_BIND=127.0.0.1
      - COMPOSERY_PERSISTENCE=overlay
      - PORT=${runtimePort}
    privileged: true
    stop_grace_period: 1m
    tmpfs:
      - /run
      - /run/lock
      - /tmp
    volumes:
      - ${dataVolume}:/data

volumes:
  ${dataVolume}:
    name: ${dataVolume}
  ${caddyDataVolume}:
    name: ${caddyDataVolume}
  ${caddyConfigVolume}:
    name: ${caddyConfigVolume}
`;
}

export function renderRuntimeArtifacts({
	cloudBoxId,
	cloudOrigin,
	config,
	customDomain,
	domain,
	runtimeAuthHash,
	runtimeImage,
	runtimePort
}: {
	cloudBoxId?: string;
	cloudOrigin?: string;
	config?: Readonly<Record<string, string>>;
	customDomain?: string;
	domain: string;
	runtimeAuthHash?: string;
	runtimeImage: string;
	runtimePort: number;
}): RuntimeArtifacts {
	return {
		caddyfile: renderCaddyfile(domain, runtimePort, customDomain),
		compose: renderCompose(runtimeImage, runtimePort),
		env: renderComposeryEnv({
			cloudBoxId,
			cloudOrigin,
			config,
			runtimeAuthHash,
			runtimeImage
		})
	};
}
