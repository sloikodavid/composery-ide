import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadOverlayModule } from "../../../../../support/overlay.ts";

// The only thing standing between the internet and a root-capable HTTP API on
// someone's box. It answers one question - does this secret name a key we
// issued - and every way of getting that wrong is silent: a store it cannot
// parse must not read as "your key is wrong", a missing store must refuse
// everything rather than everything, and the digest it compares has to stay the
// one the Rust CLI writes, because that agreement is what makes a key created
// on the command line work over HTTP.
//
// Driven against a real file rather than a mocked `fs`, so the parts that are
// about the filesystem - a store that is not there, one replaced under it - are
// actually exercised.

type Keystore = { verifyKey: (secret: string) => Promise<string | undefined> };

const digest = (secret: string) =>
	"sha256:" + createHash("sha256").update(secret).digest("hex");

const record = (id: string, secret: string) => ({
	id,
	name: `${id} key`,
	prefix: secret.slice(0, 8),
	hash: digest(secret),
	created_at: 1_700_000_000
});

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

/** A keystore module pointed at a real file, plus a way to rewrite that file. */
function keystore(store?: unknown) {
	const directory = mkdtempSync(join(tmpdir(), "composery-keystore-"));
	directories.push(directory);
	const file = join(directory, "keys.json");
	const write = (contents: unknown) =>
		writeFileSync(
			file,
			typeof contents === "string" ? contents : JSON.stringify(contents)
		);
	if (store !== undefined) write(store);

	const module = loadOverlayModule<Keystore>({
		source: new URL(
			"../../../../../../overlay/src/node/routes/api/keystore.ts",
			import.meta.url
		),
		dependencies: { "./config": { keysPath: () => file } },
		globals: { Buffer, JSON, console }
	}).exports;
	return { ...module, write };
}

describe("recognising an API key", () => {
	test("names the key a matching secret belongs to", async () => {
		const { verifyKey } = keystore({
			version: 1,
			keys: [record("key_one", "secret-one"), record("key_two", "secret-two")]
		});

		expect(await verifyKey("secret-two")).toBe("key_two");
	});

	test("refuses a secret no record hashes to", async () => {
		const { verifyKey } = keystore({
			version: 1,
			keys: [record("key_one", "secret-one")]
		});

		expect(await verifyKey("secret-two")).toBeUndefined();
	});

	// The cross-language contract: `composery api key create` writes this digest
	// from Rust. Storing the bare hex instead - the obvious near-miss - has to
	// fail, or the prefix is decoration and the two sides can drift apart.
	test("compares the prefixed digest the CLI writes, not a bare hash", async () => {
		const bare = createHash("sha256").update("secret-one").digest("hex");
		const { verifyKey } = keystore({
			version: 1,
			keys: [{ ...record("key_one", "secret-one"), hash: bare }]
		});

		expect(await verifyKey("secret-one")).toBeUndefined();
	});

	test("refuses an empty secret", async () => {
		const { verifyKey } = keystore({
			version: 1,
			keys: [record("key_one", "secret-one")]
		});

		expect(await verifyKey("")).toBeUndefined();
	});

	// No file is the state every box starts in, and it has to mean "no keys
	// issued" rather than an error the caller might treat as anything else.
	test("refuses everything when no store has been written", async () => {
		const { verifyKey } = keystore();

		expect(await verifyKey("secret-one")).toBeUndefined();
	});

	test("refuses everything when the store holds no keys", async () => {
		const { verifyKey } = keystore({ version: 1, keys: [] });

		expect(await verifyKey("secret-one")).toBeUndefined();
	});
});

// A store that cannot be read is not the same answer as a key that is wrong.
// `authenticate` turns the throw into a 503, and an owner who sees 401 for a
// corrupt file goes looking for the wrong problem - or worse, reissues a key
// that was never the issue.
describe("a store that cannot be trusted", () => {
	test("refuses to answer at all rather than answering no", async () => {
		for (const contents of [
			"not json",
			"[]",
			'"a string"',
			JSON.stringify({ keys: [] }),
			JSON.stringify({ version: 1 }),
			JSON.stringify({ version: "1", keys: [] }),
			JSON.stringify({ version: 1, keys: [{ id: "key_one" }] }),
			JSON.stringify({
				version: 1,
				keys: [{ ...record("key_one", "secret-one"), created_at: "yesterday" }]
			}),
			JSON.stringify({ version: 1, keys: [null] })
		]) {
			const { verifyKey } = keystore(contents);

			await expect(verifyKey("secret-one"), contents).rejects.toThrow();
		}
	});
});

// The store is cached between calls, so revocation is the case that matters:
// a key deleted from the file has to stop working without restarting the IDE.
describe("a store that changes under it", () => {
	test("stops accepting a key once it is revoked", async () => {
		const { verifyKey, write } = keystore({
			version: 1,
			keys: [record("key_one", "secret-one"), record("key_two", "secret-two")]
		});
		expect(await verifyKey("secret-one")).toBe("key_one");

		write({ version: 1, keys: [record("key_two", "secret-two")] });

		expect(await verifyKey("secret-one")).toBeUndefined();
		expect(await verifyKey("secret-two")).toBe("key_two");
	});

	test("accepts a key added after the first read", async () => {
		const { verifyKey, write } = keystore({ version: 1, keys: [] });
		expect(await verifyKey("secret-one")).toBeUndefined();

		write({
			version: 1,
			keys: [record("key_one", "secret-one"), record("key_two", "secret-two")]
		});

		expect(await verifyKey("secret-one")).toBe("key_one");
	});
});
