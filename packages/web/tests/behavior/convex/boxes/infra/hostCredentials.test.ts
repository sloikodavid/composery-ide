import { afterEach, describe, expect, test, vi } from "vitest";
import { utils } from "ssh2";

import { generateParseableKeyPair } from "../../../../support/ssh.ts";
import {
	authorizedPublicKey,
	privateKey
} from "@/convex/boxes/infra/hostCredentials";

// `vi.stubEnv`, never a module-load snapshot of `process.env`. A snapshot taken
// when the file is imported is only correct if this file has the process to
// itself: with file isolation off - which is how mutation testing runs the suite
// - a sibling that also saves and restores `HOST_SSH_PRIVATE_KEY` captures whatever
// this one happened to leave set, and then restores it over the top. Two files
// hand-rolling the same save/restore is how a key nobody wrote turns up in a
// third test.
afterEach(() => {
	vi.unstubAllEnvs();
});

describe("ssh key helpers", () => {
	test("derives the authorized public key from HOST_SSH_PRIVATE_KEY", () => {
		const keyPair = generateParseableKeyPair("composery-test");
		vi.stubEnv("HOST_SSH_PRIVATE_KEY", keyPair.private.replace(/\n/g, "\\n"));

		const parsedKey = utils.parseKey(keyPair.private);
		if (parsedKey instanceof Error) throw parsedKey;

		expect(privateKey()).toBe(keyPair.private);
		expect(authorizedPublicKey()).toBe(
			`${parsedKey.type} ${parsedKey.getPublicSSH().toString("base64")} composery-web`
		);
	});
});

// The deployment's key is what every box is built to trust. A key that cannot be
// parsed has to stop the create rather than reach a host as the string
// "undefined undefined composery-web", which would be authorized for nothing and
// leave a box nobody can log into.
describe("a private key the deployment cannot use", () => {
	test("says so rather than deriving a public key from nothing", () => {
		vi.stubEnv(
			"HOST_SSH_PRIVATE_KEY",
			"-----BEGIN OPENSSH PRIVATE KEY-----\nnope"
		);

		expect(() => authorizedPublicKey()).toThrow(
			/HOST_SSH_PRIVATE_KEY could not be parsed: /
		);
	});

	test("says so for a value that is not a key at all", () => {
		vi.stubEnv("HOST_SSH_PRIVATE_KEY", "not-a-key");

		expect(() => authorizedPublicKey()).toThrow(
			"HOST_SSH_PRIVATE_KEY could not be parsed:"
		);
	});
});
