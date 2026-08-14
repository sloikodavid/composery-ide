import { utils } from "ssh2";
import { describe, expect, test } from "vitest";

import { generateParseableKeyPair, envPrivateKey } from "../../support/ssh.ts";

// The helper every test that stubs HOST_SSH_PRIVATE_KEY goes through, and the one
// thing it promises: the key it hands back parses.
//
// `utils.generateKeyPairSync` alone does not promise that - measured at 77
// malformed keys per 20,000 on ssh2 1.17.0. That rate is invisible in a single
// test and constant across a suite this size, and it took `check:mutants` down
// outright, because one failure in its initial run aborts the whole sweep.
describe("generating a key a test can stub", () => {
	// Enough samples that the unguarded generator would fail here far more often
	// than not, and few enough to stay a fast test.
	test("hands back a key the product's own parser accepts, every time", () => {
		for (let index = 0; index < 500; index += 1) {
			expect(
				utils.parseKey(generateParseableKeyPair().private)
			).not.toBeInstanceOf(Error);
		}
	});

	test("carries the comment it was given", () => {
		expect(generateParseableKeyPair("composery-test").public).toContain(
			"composery-test"
		);
	});

	// The form a Convex environment variable holds: single line, so the escape is
	// undone by `sshKeys.privateKey()` when the deployment reads it back. The two
	// have to be exact inverses or a valid key becomes an unreadable one.
	test("survives the escaping the environment variable needs", () => {
		const pair = generateParseableKeyPair();
		const stored = envPrivateKey(pair.private);

		expect(stored).not.toContain("\n");
		expect(stored.replace(/\\n/g, "\n")).toBe(pair.private);
	});
});
