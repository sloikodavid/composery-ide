import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import { readRepoFile } from "../support/repo.ts";

// ---------------------------------------------------------------------------
// The API key store is one file written by Rust and read by TypeScript, and
// both sides say so in a header comment - `keystore.rs` opens with "store path,
// JSON shape, and hex SHA-256 hashing must stay identical both sides", and
// `keystore.ts` repeats it. Neither enforced it.
//
// Each side is thoroughly unit-tested on its own, which is exactly why the
// divergence would be silent: rename a field, move the file, or change the
// prefix on one side and every unit test stays green. The only thing that
// exercised the agreement was tests/system/smoke.mjs, which needs a built image
// and runs nightly - so the first report of a broken `composery api key create`
// would be an operator holding a key the server rejects.
//
// Duplication, and why it cannot be removed: the two are separate programs in
// separate languages compiled by separate toolchains, with no shared type to
// derive from. That is the last rung of the ladder in AGENTS.md, and this is the
// test that earns it.
// ---------------------------------------------------------------------------

const rust = readRepoFile("packages/cli/crates/composery/src/keystore.rs");
const rustPaths = readRepoFile("packages/cli/crates/persistence/src/paths.rs");
const ts = readRepoFile("packages/ide/overlay/src/node/routes/api/keystore.ts");
const tsConfig = readRepoFile(
	"packages/ide/overlay/src/node/routes/api/config.ts"
);

// `pub id: String,` -> "id", in declaration order. Order is not part of the
// contract, but the set is, and reading it this way means a renamed field shows
// up as one added and one removed rather than as nothing.
function rustFields(struct: string): string[] {
	const body = new RegExp(`pub struct ${struct} \\{([^}]*)\\}`).exec(rust)?.[1];
	if (body === undefined) throw new Error(`No struct ${struct} in keystore.rs`);
	return [...body.matchAll(/pub (\w+):/g)].map((match) => match[1] ?? "");
}

function tsFields(name: string): string[] {
	const body = new RegExp(`interface ${name} \\{([^}]*)\\}`).exec(ts)?.[1];
	if (body === undefined)
		throw new Error(`No interface ${name} in keystore.ts`);
	return [...body.matchAll(/^\s*(\w+)\??:/gm)].map((match) => match[1] ?? "");
}

describe("the API key store is the same file on both sides", () => {
	test("the sweep found both sides", () => {
		// Every assertion below compares two parsed lists, and two empty lists are
		// equal. This is what stops a moved file from reading as agreement.
		expect(rustFields("KeyRecord").length).toBeGreaterThan(3);
		expect(tsFields("KeyRecord").length).toBeGreaterThan(3);
	});

	test("the record has the same fields in both languages", () => {
		// serde serialises Rust field names verbatim - no rename attributes here -
		// so these are the JSON keys on the wire.
		expect(rust).not.toContain("#[serde(rename");
		expect([...tsFields("KeyRecord")].sort()).toEqual(
			[...rustFields("KeyRecord")].sort()
		);
	});

	test("the envelope has the same fields in both languages", () => {
		expect([...tsFields("KeyStore")].sort()).toEqual(
			[...rustFields("KeyStore")].sort()
		);
	});

	test("both sides write and expect the same store version", () => {
		// Rust's `Default` writes it; TS falls back to it for a missing file. A
		// mismatch means the reader rejects a store the writer just created.
		//
		// Read out of the `Default` impl rather than matched anywhere in the file:
		// `keystore.rs` also contains `{"version":1,...}` as a test fixture, so a
		// loose match would keep passing after the real default changed.
		const rustDefault =
			/impl Default for KeyStore \{[\s\S]*?version:\s*(\d+)/.exec(rust)?.[1];
		const tsFallback = /\{\s*version:\s*(\d+),\s*keys:\s*\[\]\s*\}/.exec(
			ts
		)?.[1];

		expect(rustDefault).toBe("1");
		expect(tsFallback).toBe(rustDefault);
	});

	test("the secret prefix stays Rust's alone", () => {
		// The prefix is minted by Rust, stored per record, and displayed from that
		// record - authentication is by hash, so nothing on the TS side needs to
		// know the spelling. That is why there is no second copy to pin, and this
		// asserts it stays that way: a hardcoded `composery_` in the server or the
		// extension would be a copy that could drift silently, since a wrong one
		// would only ever affect what a user is shown.
		const prefix = /const KEY_PREFIX: &str = "([^"]+)"/.exec(rust)?.[1];
		expect(prefix).toBe("composery_");

		const consumers = [
			"packages/ide/overlay/src/node/routes/api/auth.ts",
			"packages/ide/overlay/src/node/routes/api/keystore.ts",
			"packages/ide/overlay/lib/vscode/extensions/composery-api/extension.js"
		];
		for (const file of consumers) {
			expect(
				readRepoFile(file),
				`${file} hardcodes the key prefix`
			).not.toContain(prefix ?? "");
		}
	});

	test("both sides hash a secret to the same string", () => {
		// Not "both say sha256" - the actual digest. Rust pins the empty-string
		// hash in its own unit test; this recomputes it here, so the two
		// implementations are compared through a value rather than through prose.
		const rustEmptyHash = /hash_secret\(""\),\s*\n\s*"([^"]+)"/.exec(rust)?.[1];
		const tsFormula = '"sha256:" + crypto.createHash("sha256")';

		expect(ts).toContain(tsFormula);
		expect(rust).toContain('format!("sha256:{}"');
		expect(rustEmptyHash).toBe(
			`sha256:${createHash("sha256").update("").digest("hex")}`
		);
	});

	test("both sides resolve the store to the same path", () => {
		// Same volume root, same two segments under it. `keysPath()` and
		// `keystore_path()` are what a key written by the CLI is read back from.
		expect(rustPaths).toContain('PathBuf::from("/data")');
		expect(rustPaths).toContain(
			'std::env::var("COMPOSERY_DOCKER_VOLUME_PATH")'
		);
		// The TypeScript side reads the volume root from one module both surfaces
		// share, so the API and SSH cannot end up looking in different places
		// after somebody sets COMPOSERY_DOCKER_VOLUME_PATH.
		expect(readRepoFile("packages/ide/overlay/src/node/volume.ts")).toContain(
			'process.env.COMPOSERY_DOCKER_VOLUME_PATH?.trim() || "/data"'
		);

		expect(rust).toContain('volume_root().join("api").join("keys.json")');
		expect(tsConfig).toContain('path.join(volumeRoot(), "api", "keys.json")');
	});
});

// ---------------------------------------------------------------------------
// The SSH enrollment store is the second file with two writers, and it exists
// *because* it has two: the editor's extension host mints a token by running the
// Rust CLI, and the instance's server process redeems it in TypeScript. Anything
// held in one process's memory would mint tokens the other could never redeem -
// a feature that looks implemented and works for nobody.
//
// Same duplication, same last rung, and one more field to get wrong than the key
// store has: `expires_at` is milliseconds on both sides. Rust's own `now_secs`
// helper sits one import away, so seconds is the plausible mistake, and it would
// produce tokens that expired in 1970 rather than an error anybody could see.
// ---------------------------------------------------------------------------

const rustEnrollments = readRepoFile(
	"packages/cli/crates/composery/src/enrollments.rs"
);
const tsCertificates = readRepoFile(
	"packages/ide/overlay/src/node/ssh/certificates.ts"
);

describe("the SSH enrollment store both languages write", () => {
	test("is the same path under the volume root", () => {
		expect(rustEnrollments).toContain(
			'volume_root().join("ssh").join("enrollments.json")'
		);
		expect(tsCertificates).toContain('path.join(sshDir(), "enrollments.json")');
		expect(tsCertificates).toContain('path.join(sshConfig.dataRoot, "ssh")');
	});

	test("carries the same record fields", () => {
		const rustBody = /pub struct EnrollmentRecord \{([^}]*)\}/.exec(
			rustEnrollments
		)?.[1];
		const tsBody =
			/interface EnrollmentRecord extends Enrollment \{([^}]*)\}/.exec(
				tsCertificates
			)?.[1];
		const tsBase = /interface Enrollment \{([^}]*)\}/.exec(tsCertificates)?.[1];
		if (!rustBody || !tsBody || tsBase === undefined) {
			throw new Error("enrollment record shape not found on both sides");
		}

		const rustNames = [...rustBody.matchAll(/pub (\w+):/g)]
			.map((match) => match[1] ?? "")
			.sort();
		const tsNames = [...`${tsBase}${tsBody}`.matchAll(/^\s*(\w+)\??:/gm)]
			.map((match) => match[1] ?? "")
			.sort();

		expect(rustNames).toEqual(["expires_at", "hash", "name"]);
		expect(tsNames).toEqual(rustNames);
	});

	test("hashes the token the same way, and stores only the hash", () => {
		expect(rustEnrollments).toContain("hash: hash_secret(&token)");
		expect(tsCertificates).toContain(
			'return "sha256:" + crypto.createHash("sha256").update(token).digest("hex")'
		);
		// The prefix has to match or every token minted by one side is unknown to
		// the other, with no error to read - just a rejected enrollment.
		expect(rustEnrollments).toContain(
			'const TOKEN_PREFIX: &str = "composery_ssh_"'
		);
		expect(tsCertificates).toContain("`composery_ssh_${crypto.randomBytes(24)");
	});

	test("expires in milliseconds on both sides", () => {
		expect(rustEnrollments).toContain("now_ms + ttl_secs() * 1000");
		expect(rustEnrollments).toContain("elapsed.as_millis() as u64");
		expect(tsCertificates).toContain("now + sshConfig.enrollmentTtlSec * 1000");
	});

	test("agrees on the default and the ceiling for how long a token lives", () => {
		const tsSshConfig = readRepoFile(
			"packages/ide/overlay/src/node/ssh/config.ts"
		);
		expect(rustEnrollments).toContain("const DEFAULT_TTL_SECS: u64 = 600");
		expect(rustEnrollments).toContain("const MAX_TTL_SECS: u64 = 3600");
		expect(rustEnrollments).toContain(
			'std::env::var("COMPOSERY_SSH_ENROLLMENT_TTL")'
		);
		expect(tsSshConfig).toContain(
			'int("COMPOSERY_SSH_ENROLLMENT_TTL", 600, MAX_ENROLLMENT_TTL_SEC)'
		);
		expect(tsSshConfig).toContain("const MAX_ENROLLMENT_TTL_SEC = 60 * 60");
	});

	test("writes a bare array, not the key store's versioned object", () => {
		expect(rustEnrollments).toContain("serde_json::to_vec(records)");
		expect(tsCertificates).toContain("JSON.stringify(records)");
	});
});

// The certificate store has two writers for a reason that cannot be designed
// away: enrollment is an HTTP route and must issue inline, while listing and
// revoking need no network and belong on the instance. So TypeScript appends and
// Rust revokes, over one file, in two languages with no shared type.
describe("the SSH certificate store both languages write", () => {
	const rustCertificates = readRepoFile(
		"packages/cli/crates/composery/src/certificates.rs"
	);

	test("is the same path under the volume root", () => {
		expect(rustCertificates).toContain(
			'volume_root().join("ssh").join("certificates.json")'
		);
		expect(tsCertificates).toContain(
			'path.join(sshDir(), "certificates.json")'
		);
	});

	test("carries the same record fields", () => {
		const rustBody = /pub struct CertificateRecord \{([^}]*)\}/.exec(
			rustCertificates
		)?.[1];
		const tsBody = /export interface CertificateRecord \{([^}]*)\}/.exec(
			tsCertificates
		)?.[1];
		if (!rustBody || !tsBody) {
			throw new Error("certificate record shape not found on both sides");
		}
		const rustNames = [...rustBody.matchAll(/pub (\w+):/g)]
			.map((match) => match[1] ?? "")
			.sort();
		const tsNames = [...tsBody.matchAll(/^\s*(\w+)\??:/gm)]
			.map((match) => match[1] ?? "")
			.sort();

		expect(rustNames).toEqual([
			"created_at",
			"expires_at",
			"name",
			"revoked_at",
			"serial"
		]);
		expect(tsNames).toEqual(rustNames);
	});

	test("wraps the records in the same versioned object", () => {
		expect(rustCertificates).toContain("pub struct CertificateStore");
		expect(rustCertificates).toContain(
			"pub certificates: Vec<CertificateRecord>"
		);
		expect(tsCertificates).toContain("interface CertificateStore");
		expect(tsCertificates).toContain("certificates: CertificateRecord[]");
	});

	// A serial revoked in the records but absent from the list sshd reads is a
	// certificate the interface calls dead and the server still accepts.
	test("revokes by the serial TypeScript allocated", () => {
		expect(tsCertificates).toContain("nextSerial(store.certificates)");
		expect(tsCertificates).toContain('"-z",');
		expect(rustCertificates).toContain('format!("serial: {}", record.serial)');
	});
});
