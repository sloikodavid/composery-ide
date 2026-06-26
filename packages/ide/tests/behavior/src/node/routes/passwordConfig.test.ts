import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadOverlayModule } from "../../../../support/overlay.ts";

// Where a password is decided and where one is written down. Two questions with
// different stakes: `isEnvPasswordManaged` decides whether the change and
// recovery flows are offered at all, and `writeHashedPassword` is the only
// thing standing between an unclaimed instance and whoever reaches it first.
//
// `allowExisting` is the whole of that second guard. Registration is reachable
// before anyone has signed in - it has to be, or a fresh instance could never
// be claimed - so the rule that it refuses once a password exists is what makes
// the race safe. The cloud change/recovery flow is the one caller allowed past
// it, having already proved ownership through the website.
//
// Driven against a real config file, because the write is the interesting part:
// it lands atomically, at 0600, and the running process has to start accepting
// the new password without a restart.

type PasswordArgs = {
	config?: string;
	password?: string;
	"hashed-password"?: string;
	usingEnvPassword?: boolean;
	usingEnvHashedPassword?: boolean;
};

type PasswordConfig = {
	hasPassword: (args: PasswordArgs) => boolean;
	isEnvPasswordManaged: (args: PasswordArgs) => boolean;
	isPasswordValid: (args: PasswordArgs, password: string) => Promise<boolean>;
	writeHashedPassword: (
		args: PasswordArgs,
		hashedPassword: string,
		options?: { allowExisting?: boolean }
	) => Promise<boolean>;
};

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

/** How the stubbed argon2 spells a hash, so a match is decidable in a test. */
const hashOf = (password: string) => `$argon2id$${password}`;

function passwordConfig({ cloud = false }: { cloud?: boolean } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "composery-password-"));
	directories.push(directory);
	// Deliberately a path whose parent does not exist yet: a first-run write has
	// to create it rather than fail.
	const file = join(directory, "config", "config.yaml");

	const module = loadOverlayModule<PasswordConfig>({
		source: new URL(
			"../../../../../overlay/src/node/routes/passwordConfig.ts",
			import.meta.url
		),
		dependencies: {
			// JSON is valid YAML, so the real file still round-trips through a real
			// parser's rules while staying readable in an assertion.
			"js-yaml": {
				load: (contents: string) => JSON.parse(contents) as unknown,
				dump: (value: unknown) => JSON.stringify(value)
			},
			"safe-compare": (a: string, b: string) => a === b,
			"../cloud": { cloudConfig: cloud ? { boxId: "j57box" } : undefined },
			"../util": {
				isHashMatch: (password: string, hash: string) =>
					Promise.resolve(hash === hashOf(password))
			}
		},
		globals: { Buffer, JSON, console, process }
	}).exports;

	return {
		...module,
		file,
		read: () =>
			JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>,
		/** An existing config, as an instance that was already set up would have. */
		seed: (contents: Record<string, unknown>) => {
			mkdirSync(join(directory, "config"), { recursive: true });
			writeFileSync(file, JSON.stringify(contents));
		}
	};
}

describe("whether an instance has a password at all", () => {
	test("counts either spelling, and nothing else", () => {
		const { hasPassword } = passwordConfig();

		expect(hasPassword({ password: "hunter2" })).toBe(true);
		expect(hasPassword({ "hashed-password": hashOf("hunter2") })).toBe(true);
		expect(hasPassword({})).toBe(false);
		expect(hasPassword({ password: "" })).toBe(false);
	});
});

// Whether a password written here would be overruled at the next restart. It
// decides whether /change-password is offered, so a wrong answer either hides a
// working flow or offers one that silently reverts.
describe("whether the environment owns the password", () => {
	test("a plaintext environment password outranks anything written here", () => {
		for (const cloud of [false, true]) {
			const { isEnvPasswordManaged } = passwordConfig({ cloud });

			expect(
				isEnvPasswordManaged({ usingEnvPassword: true }),
				`cloud=${cloud}`
			).toBe(true);
		}
	});

	// The one asymmetry, and the reason it exists: the website renders a cloud
	// instance's hashed password into its env file from the hash it holds, and
	// both local write paths record the new hash there first - so the reconcile
	// carries the change back rather than reverting it.
	test("a hashed environment password is the website's on cloud, the owner's elsewhere", () => {
		expect(
			passwordConfig({ cloud: false }).isEnvPasswordManaged({
				usingEnvHashedPassword: true
			})
		).toBe(true);
		expect(
			passwordConfig({ cloud: true }).isEnvPasswordManaged({
				usingEnvHashedPassword: true
			})
		).toBe(false);
	});

	test("nothing in the environment leaves the password ours to change", () => {
		expect(passwordConfig().isEnvPasswordManaged({})).toBe(false);
	});
});

describe("checking a password against the configured one", () => {
	test("prefers the hash when one is configured", async () => {
		const { isPasswordValid } = passwordConfig();
		const args = { "hashed-password": hashOf("hunter2"), password: "other" };

		expect(await isPasswordValid(args, "hunter2")).toBe(true);
		expect(await isPasswordValid(args, "other")).toBe(false);
	});

	test("falls back to the plaintext one when there is no hash", async () => {
		const { isPasswordValid } = passwordConfig();

		expect(await isPasswordValid({ password: "hunter2" }, "hunter2")).toBe(
			true
		);
		expect(await isPasswordValid({ password: "hunter2" }, "nope")).toBe(false);
	});

	test("never lets an empty guess match an unconfigured instance", async () => {
		const { isPasswordValid } = passwordConfig();

		expect(await isPasswordValid({}, "")).toBe(false);
		expect(await isPasswordValid({ password: "" }, "")).toBe(false);
	});
});

describe("claiming an instance that has no password", () => {
	test("writes the hash, and starts accepting it without a restart", async () => {
		const box = passwordConfig();
		const args: PasswordArgs = { config: box.file, usingEnvPassword: true };

		expect(await box.writeHashedPassword(args, hashOf("hunter2"))).toBe(true);

		expect(box.read()).toEqual({
			auth: "password",
			"hashed-password": hashOf("hunter2")
		});
		// The running process, not just the file: the same object the routes read.
		expect(args["hashed-password"]).toBe(hashOf("hunter2"));
		expect(await box.isPasswordValid(args, "hunter2")).toBe(true);
		// ...and it no longer believes the environment owns the password, or the
		// flow it just completed would report itself as unavailable.
		expect(box.isEnvPasswordManaged(args)).toBe(false);
	});

	// A leftover plaintext password beside the new hash would be a second, older
	// credential that still opens the instance.
	test("drops a plaintext password rather than leaving it beside the hash", async () => {
		const box = passwordConfig();
		box.seed({ auth: "password", password: "old" });
		const args: PasswordArgs = { config: box.file, password: "old" };

		await box.writeHashedPassword(args, hashOf("hunter2"), {
			allowExisting: true
		});

		expect(box.read()).not.toHaveProperty("password");
		expect(box.read()["hashed-password"]).toBe(hashOf("hunter2"));
		expect(args.password).toBeUndefined();
		expect(await box.isPasswordValid(args, "old")).toBe(false);
	});

	test("keeps the config file private to its owner", async () => {
		const box = passwordConfig();
		await box.writeHashedPassword({ config: box.file }, hashOf("hunter2"));

		// Windows does not carry POSIX modes, so this asserts where it means
		// something - the box is Linux.
		if (process.platform !== "win32") {
			expect(statSync(box.file).mode & 0o777).toBe(0o600);
		}
		expect(readFileSync(box.file, "utf8")).toContain(hashOf("hunter2"));
	});

	test("refuses when it has nowhere to write", async () => {
		const box = passwordConfig();

		await expect(
			box.writeHashedPassword({}, hashOf("hunter2"))
		).rejects.toThrow(/config path/i);
	});
});

// The guard. Registration stays reachable on an instance that already has a
// password - the page has to be able to say so - and this is what stops it
// being a way to take one over.
describe("claiming an instance that already has one", () => {
	test("refuses, and leaves the existing password alone", async () => {
		const box = passwordConfig();
		const args: PasswordArgs = { config: box.file };
		await box.writeHashedPassword(args, hashOf("first"));

		expect(await box.writeHashedPassword(args, hashOf("second"))).toBe(false);

		expect(box.read()["hashed-password"]).toBe(hashOf("first"));
		expect(args["hashed-password"]).toBe(hashOf("first"));
	});

	test("refuses over a plaintext password too, not only a hashed one", async () => {
		const box = passwordConfig();
		box.seed({ auth: "password", password: "old" });

		expect(
			await box.writeHashedPassword({ config: box.file }, hashOf("second"))
		).toBe(false);
		expect(box.read()).toMatchObject({ password: "old" });
	});

	// The cloud change and recovery flows, which have already proved ownership
	// through the website before they get here.
	test("lets a caller that proved ownership overwrite it", async () => {
		const box = passwordConfig();
		const args: PasswordArgs = { config: box.file };
		await box.writeHashedPassword(args, hashOf("first"));

		expect(
			await box.writeHashedPassword(args, hashOf("second"), {
				allowExisting: true
			})
		).toBe(true);

		expect(box.read()["hashed-password"]).toBe(hashOf("second"));
		expect(await box.isPasswordValid(args, "second")).toBe(true);
		expect(await box.isPasswordValid(args, "first")).toBe(false);
	});
});

// Two registrations landing together is the race the guard exists for, and the
// check and the write are only safe together if nothing interleaves them.
describe("two writes at once", () => {
	test("lets exactly one unclaimed instance be claimed", async () => {
		const box = passwordConfig();
		const args: PasswordArgs = { config: box.file };

		const results = await Promise.all([
			box.writeHashedPassword(args, hashOf("first")),
			box.writeHashedPassword(args, hashOf("second")),
			box.writeHashedPassword(args, hashOf("third"))
		]);

		expect(results.filter(Boolean)).toHaveLength(1);
		// Whichever won, the file and the process agree on it.
		expect(box.read()["hashed-password"]).toBe(args["hashed-password"]);
	});
});
