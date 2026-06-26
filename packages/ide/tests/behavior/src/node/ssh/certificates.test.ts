import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
	vi
} from "vitest";

import { loadOverlayModule } from "../../../../support/overlay.ts";

type SshCertificates = {
	isValidName: (value: unknown) => boolean;
	isValidPublicKey: (value: unknown) => boolean;
	mintEnrollment: (
		name: string,
		now?: number
	) => Promise<{ token: string; expires_at: number }>;
	nextSerial: (certificates: readonly { serial: number }[]) => number;
	parseStore: (contents: string) => { certificates: unknown[] };
	redeemEnrollment: (
		token: unknown,
		now?: number
	) => Promise<{ name: string } | undefined>;
	liveEnrollments: (
		records: readonly { expires_at: number }[],
		now: number
	) => { expires_at: number }[];
};

// Loaded through the overlay loader rather than imported, for the reason that
// module documents: overlay files compile against the upstream IDE's module
// graph. This one is the certificate authority's whole decision surface, so it is
// run rather than read.
// A real directory, because the token store is a real file - which is the whole
// point of it: the editor's extension host mints a token and the server process
// redeems it, so anything held only in memory would mint tokens nothing could
// redeem.
const DATA_ROOT = mkdtempSync(join(tmpdir(), "composery-ssh-test-"));
// ssh.sh creates this at boot, together with the authority itself. The module
// deliberately does not: an instance whose SSH service never started has no
// authority to sign with, and inventing one here would mint certificates sshd was
// never told to trust.
mkdirSync(join(DATA_ROOT, "ssh"));

const { exports: ssh } = loadOverlayModule<SshCertificates>({
	source: new URL(
		"../../../../../overlay/src/node/ssh/certificates.ts",
		import.meta.url
	),
	// Injected rather than read from the environment, so these tests state the
	// numbers they depend on instead of inheriting whatever the runner was
	// started with.
	dependencies: {
		"./config": {
			sshConfig: {
				dataRoot: DATA_ROOT,
				certificateDays: 90,
				enrollmentTtlSec: 600
			}
		}
	}
});

// Short and obviously fake. A realistic key body is a long base64 run, and the
// only thing a long one would buy these tests is a pile of nonsense words in the
// repository's source-unit baseline.
const ED25519 = "ssh-ed25519 AAAA user@host";
// Joined rather than written inline. An escaped newline inside a string literal
// welds its two halves into a word nobody wrote, which the repository's
// source-unit baseline then has to carry for ever.
const NEWLINE = String.fromCharCode(10);
const PRIVATE_KEY = ["-----BEGIN OPENSSH PRIVATE KEY-----", "body"].join(
	NEWLINE
);
const TWO_LINE_NAME = ["two", "rows"].join(NEWLINE);

describe("public key validation", () => {
	test("accepts the forms OpenSSH writes", () => {
		expect(ssh.isValidPublicKey(ED25519)).toBe(true);
		expect(ssh.isValidPublicKey("ssh-ed25519 AAAA")).toBe(true);
		expect(ssh.isValidPublicKey("ecdsa-sha2-nistp256 AAAA")).toBe(true);
	});

	// The mistake a person actually makes, and the one that would otherwise write
	// their private key into the instance's own state.
	test("refuses a private key", () => {
		expect(ssh.isValidPublicKey(PRIVATE_KEY)).toBe(false);
	});

	test("refuses anything that is not a key", () => {
		expect(ssh.isValidPublicKey("")).toBe(false);
		expect(ssh.isValidPublicKey("hello world")).toBe(false);
		expect(ssh.isValidPublicKey(undefined)).toBe(false);
		expect(ssh.isValidPublicKey(`ssh-ed25519 ${"A".repeat(5000)}`)).toBe(false);
	});
});

describe("certificate name validation", () => {
	test("accepts what a person types for a device", () => {
		expect(ssh.isValidName("My laptop")).toBe(true);
		expect(ssh.isValidName("Claude Code 2026-08-02")).toBe(true);
	});

	test("refuses empty, oversized, and line-breaking names", () => {
		expect(ssh.isValidName("")).toBe(false);
		expect(ssh.isValidName("a".repeat(65))).toBe(false);
		expect(ssh.isValidName(TWO_LINE_NAME)).toBe(false);
	});
});

describe("serial allocation", () => {
	test("starts at one", () => {
		expect(ssh.nextSerial([])).toBe(1);
	});

	// A recycled serial would silently re-revoke a live certificate, or un-revoke a
	// dead one, so the next serial comes from the highest ever seen rather than
	// from how many records are left.
	test("never reuses a serial after a record is removed", () => {
		expect(ssh.nextSerial([{ serial: 1 }, { serial: 7 }])).toBe(8);
	});
});

// Every case here is about a moment, and the module's own default argument reads
// the clock. Pinning it is what keeps "expired" from meaning "whenever this ran".
const NOW = Date.UTC(2026, 7, 2);

afterAll(() => {
	rmSync(DATA_ROOT, { force: true, recursive: true });
});

describe("enrollment tokens", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("redeems once and never again", async () => {
		const { token } = await ssh.mintEnrollment("laptop");
		expect((await ssh.redeemEnrollment(token))?.name).toBe("laptop");
		expect(await ssh.redeemEnrollment(token)).toBeUndefined();
	});

	test("refuses a token past its expiry", async () => {
		const { token, expires_at } = await ssh.mintEnrollment("laptop", NOW);
		expect(await ssh.redeemEnrollment(token, expires_at + 1)).toBeUndefined();
	});

	test("refuses a token nobody minted", async () => {
		expect(
			await ssh.redeemEnrollment("composery_ssh_invented")
		).toBeUndefined();
		expect(await ssh.redeemEnrollment(undefined)).toBeUndefined();
		expect(await ssh.redeemEnrollment("")).toBeUndefined();
	});

	// One process mints, another redeems. A token that only worked inside the
	// process that created it would look implemented and work for nobody.
	test("survives being minted and redeemed through the file", async () => {
		const { token } = await ssh.mintEnrollment("phone", NOW);
		const store = await readFile(
			join(DATA_ROOT, "ssh", "enrollments.json"),
			"utf8"
		);

		// What is written is a hash, never the token itself.
		expect(store).not.toContain(token);
		expect(store).toContain("sha256:");
		expect((await ssh.redeemEnrollment(token, NOW))?.name).toBe("phone");
	});

	test("drops expired records rather than keeping them", () => {
		const records = [{ expires_at: NOW - 1 }, { expires_at: NOW + 1 }];
		expect(ssh.liveEnrollments(records, NOW)).toEqual([
			{ expires_at: NOW + 1 }
		]);
	});
});

describe("certificate store parsing", () => {
	test("reads a well-formed store", () => {
		expect(
			ssh.parseStore('{"version":1,"certificates":[]}').certificates
		).toEqual([]);
	});

	test("refuses a shape it cannot trust", () => {
		expect(() => ssh.parseStore("[]")).toThrow();
		expect(() => ssh.parseStore('{"version":1}')).toThrow();
		expect(() => ssh.parseStore('{"certificates":[]}')).toThrow();
	});
});
