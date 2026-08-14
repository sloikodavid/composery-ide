import { describe, expect, test } from "vitest";
import {
	RUNTIME_CONFIG_FIELDS,
	RUNTIME_CONFIG_KEYS,
	RuntimeConfigError,
	SECRET_CONFIG_KEYS,
	applySecretIntent,
	normalizeRuntimeConfig,
	configurationField
} from "@/convex/boxes/configuration";
import { renderComposeryEnv } from "@/convex/boxes/infra/artifacts";

describe("normalizeRuntimeConfig", () => {
	// The allowlist is the security boundary, not a convenience. If an unknown key
	// were dropped instead of refused, the interface would report a save that did
	// nothing; if it were accepted, it would be written into the box's env file.
	test("refuses a key that is not configurable", () => {
		expect(() =>
			normalizeRuntimeConfig({ COMPOSERY_HASHED_PASSWORD: "x" })
		).toThrow(RuntimeConfigError);
		expect(() => normalizeRuntimeConfig({ PORT: "9000" })).toThrow(
			/not a configurable variable/
		);
		expect(() =>
			normalizeRuntimeConfig({ COMPOSERY_REMOVE_PASSWORD: "1" })
		).toThrow(RuntimeConfigError);
	});

	// The box turns a COMPOSERY_DISABLE_* surface off unless the value is exactly
	// 1 or true. Storing "yes" would read as enabled in the interface and disabled
	// on the box.
	test("stores booleans in the spelling the box actually reads", () => {
		expect(
			normalizeRuntimeConfig({ COMPOSERY_DISABLE_FILE_UPLOADS: "true" })
		).toEqual({ COMPOSERY_DISABLE_FILE_UPLOADS: "1" });
		expect(
			normalizeRuntimeConfig({ COMPOSERY_DISABLE_FILE_UPLOADS: "false" })
		).toEqual({ COMPOSERY_DISABLE_FILE_UPLOADS: "0" });
		expect(() =>
			normalizeRuntimeConfig({ COMPOSERY_DISABLE_FILE_UPLOADS: "yes" })
		).toThrow(/must be true or false/);
	});

	test("bounds numbers and rejects non-integers", () => {
		expect(normalizeRuntimeConfig({ COMPOSERY_API_RATE_RPS: " 60 " })).toEqual({
			COMPOSERY_API_RATE_RPS: "60"
		});
		expect(() =>
			normalizeRuntimeConfig({ COMPOSERY_API_RATE_RPS: "0" })
		).toThrow(/between/);
		expect(() =>
			normalizeRuntimeConfig({ COMPOSERY_API_RATE_RPS: "1e3" })
		).toThrow(/whole number/);
		expect(() =>
			normalizeRuntimeConfig({ COMPOSERY_API_RATE_RPS: "0x10" })
		).toThrow(/whole number/);
	});

	test("accepts only the log levels the editor understands", () => {
		expect(normalizeRuntimeConfig({ COMPOSERY_LOG_LEVEL: "debug" })).toEqual({
			COMPOSERY_LOG_LEVEL: "debug"
		});
		expect(() =>
			normalizeRuntimeConfig({ COMPOSERY_LOG_LEVEL: "verbose" })
		).toThrow(/must be one of/);
	});

	test("accepts only server-enforced IDE session lifetimes", () => {
		expect(
			normalizeRuntimeConfig({ COMPOSERY_SESSION_LIFETIME: "browser" })
		).toEqual({ COMPOSERY_SESSION_LIFETIME: "browser" });
		expect(
			normalizeRuntimeConfig({ COMPOSERY_SESSION_LIFETIME: "30d" })
		).toEqual({ COMPOSERY_SESSION_LIFETIME: "30d" });
		expect(() =>
			normalizeRuntimeConfig({ COMPOSERY_SESSION_LIFETIME: "forever" })
		).toThrow(/must be one of/);
	});

	// The env file is single-quoted shell. A value containing a quote or newline
	// would close its own line and let the remainder become a separate assignment
	// - a way to set a variable that is not on the allowlist at all.
	test("refuses values that could break out of an env-file line", () => {
		expect(() =>
			normalizeRuntimeConfig({
				COMPOSERY_COOKIE_SUFFIX: "a'\nCOMPOSERY_DISABLE_AUTH='1"
			})
		).toThrow(/quotes or line breaks/);
	});

	test("treats an empty optional value as unset rather than as an empty string", () => {
		expect(normalizeRuntimeConfig({ COMPOSERY_PROXY_URI: "  " })).toEqual({});
		expect(normalizeRuntimeConfig({ COMPOSERY_DISABLE_PROXY: "" })).toEqual({
			COMPOSERY_DISABLE_PROXY: "0"
		});
	});

	test("has no duplicate keys and never offers a managed variable", () => {
		expect(new Set(RUNTIME_CONFIG_KEYS).size).toBe(RUNTIME_CONFIG_KEYS.length);
		for (const managed of [
			"COMPOSERY_HASHED_PASSWORD",
			"COMPOSERY_PASSWORD",
			"COMPOSERY_CLOUD_BOX_ID",
			"COMPOSERY_CLOUD_ORIGIN",
			"COMPOSERY_INIT",
			"PORT",
			"COMPOSERY_IDE_PORT",
			"COMPOSERY_DOCKER_VOLUME_PATH",
			"COMPOSERY_PERSISTENCE",
			"COMPOSERY_CONFIG",
			"COMPOSERY_REMOVE_PASSWORD"
		]) {
			expect(RUNTIME_CONFIG_KEYS).not.toContain(managed);
		}
	});

	test("describes every field it offers", () => {
		for (const field of RUNTIME_CONFIG_FIELDS) {
			expect(field.description.length).toBeGreaterThan(0);
			if (field.kind === "enum") {
				for (const option of field.options) {
					expect(option.label.length).toBeGreaterThan(0);
					expect(option.value.length).toBeGreaterThan(0);
				}
			}
		}
	});
});

describe("applySecretIntent", () => {
	const stored = {
		COMPOSERY_GITHUB_TOKEN: "ghp_existing",
		LANG: "en_GB.UTF-8"
	};

	// The page is never sent a secret, so a save from a browser that never held
	// one arrives without the key. Reading that as "clear" would delete the
	// owner's token every time they changed an unrelated field, and they would
	// only discover it when something that used the token stopped working.
	test("keeps a secret the page did not submit", () => {
		expect(
			applySecretIntent({
				normalized: { LANG: "en_GB.UTF-8" },
				stored,
				submittedKeys: ["LANG"]
			})
		).toEqual({ LANG: "en_GB.UTF-8", COMPOSERY_GITHUB_TOKEN: "ghp_existing" });
	});

	// Clearing is deliberate: the page sends the key with an empty value, which
	// `normalizeRuntimeConfig` has already dropped. Keeping it dropped is what
	// removes it.
	test("clears a secret submitted empty", () => {
		expect(
			applySecretIntent({
				normalized: {},
				stored,
				submittedKeys: ["COMPOSERY_GITHUB_TOKEN"]
			})
		).toEqual({});
	});

	test("replaces a secret submitted with a new value", () => {
		expect(
			applySecretIntent({
				normalized: { COMPOSERY_GITHUB_TOKEN: "ghp_new" },
				stored,
				submittedKeys: ["COMPOSERY_GITHUB_TOKEN"]
			})
		).toEqual({ COMPOSERY_GITHUB_TOKEN: "ghp_new" });
	});

	test("has nothing to restore for a box that never set one", () => {
		expect(
			applySecretIntent({
				normalized: { LANG: "C.UTF-8" },
				stored: undefined,
				submittedKeys: ["LANG"]
			})
		).toEqual({ LANG: "C.UTF-8" });
	});

	// Only secrets get this treatment. A non-secret the page omitted is genuinely
	// being removed, because the page round-trips those values and can say so.
	test("never restores a non-secret the page left out", () => {
		expect(
			applySecretIntent({
				normalized: {},
				stored,
				submittedKeys: []
			})
		).toEqual({ COMPOSERY_GITHUB_TOKEN: "ghp_existing" });
	});

	test("derives its secret set from the fields, and it is not empty", () => {
		expect(SECRET_CONFIG_KEYS).toContain("COMPOSERY_GITHUB_TOKEN");
		expect(SECRET_CONFIG_KEYS).not.toContain("LANG");
	});
});

describe("renderComposeryEnv with owner configuration", () => {
	const managed = {
		cloudBoxId: "box_123",
		cloudOrigin: "https://www.composery.io",
		runtimeAuthHash: "$argon2id$v=19$m=1,t=1,p=1$salt$hash"
	};

	test("writes the owner's variables alongside the managed ones", () => {
		const env = renderComposeryEnv({
			...managed,
			config: normalizeRuntimeConfig({
				COMPOSERY_LOG_LEVEL: "debug",
				COMPOSERY_DISABLE_FILE_UPLOADS: "true"
			})
		});

		expect(env).toContain("COMPOSERY_CLOUD_BOX_ID='box_123'");
		expect(env).toContain("COMPOSERY_LOG_LEVEL='debug'");
		expect(env).toContain("COMPOSERY_DISABLE_FILE_UPLOADS='1'");
	});

	// Compose decides whether to recreate a container partly from this file, so an
	// unchanged configuration has to render byte-identically. Otherwise a password
	// change or a repair would look like a configuration change.
	test("renders a stable file for the same configuration", () => {
		const first = renderComposeryEnv({
			...managed,
			config: { COMPOSERY_LOG_LEVEL: "debug", LANG: "en_GB.UTF-8" }
		});
		const second = renderComposeryEnv({
			...managed,
			config: { LANG: "en_GB.UTF-8", COMPOSERY_LOG_LEVEL: "debug" }
		});

		expect(first).toBe(second);
	});

	// The allowlist already prevents this, so reaching the throw means the
	// allowlist was widened carelessly. Failing loudly here is the difference
	// between a caught mistake and a box that silently loses its password or its
	// link to the control plane on the next render.
	test("refuses to render a configuration that shadows a managed variable", () => {
		expect(() =>
			renderComposeryEnv({
				...managed,
				config: { COMPOSERY_HASHED_PASSWORD: "attacker" }
			})
		).toThrow(/managed by Composery/);
	});

	test("still renders without any owner configuration", () => {
		expect(renderComposeryEnv(managed)).toContain("COMPOSERY_CLOUD_BOX_ID=");
		expect(renderComposeryEnv({ ...managed, config: {} })).toBe(
			renderComposeryEnv(managed)
		);
	});
});

// The lookup the Configuration page uses to turn a stored key back into the
// field that describes it. A key with no field renders no control, so this is
// what decides whether a saved setting is visible to its owner at all.
describe("looking a runtime setting up by its key", () => {
	test("finds the field for every key the allowlist offers", () => {
		for (const field of RUNTIME_CONFIG_FIELDS) {
			expect(configurationField(field.key)).toBe(field);
		}
	});

	test("finds nothing for a key Composery does not offer", () => {
		expect(configurationField("COMPOSERY_NOT_A_SETTING")).toBeUndefined();
		expect(configurationField("")).toBeUndefined();
	});
});
