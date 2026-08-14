import ssh2 from "ssh2";

const { utils } = ssh2;

// An SSH key pair the deployment's own code can read back.
//
// `utils.generateKeyPairSync("ed25519")` in ssh2 1.17.0 emits, roughly four
// times in a thousand, a private key that its own `utils.parseKey` then rejects
// with "Malformed OpenSSH private key". Measured directly: of 20,000 generated
// pairs, 77 failed to parse, and the same 77 failed whether or not the key had
// been through the escape/unescape round trip `HOST_SSH_PRIVATE_KEY` uses - so the
// defect is in the generator, not in anything this repository does with it.
//
// Four in a thousand is invisible in one test and constant in a suite: every
// file that stubs `HOST_SSH_PRIVATE_KEY` calls this, `check:mutants` aborts outright
// when its initial run trips one, and a red build that goes green on re-run is
// the kind nobody trusts or investigates.
//
// The guard is on the observable condition rather than on a version, so it is
// simply inert once the generator stops doing it: generate, ask the same parser
// the product asks, and keep the first pair it accepts. Nothing here detects the
// upstream fix - at four in a thousand, a sample large enough to call the defect
// gone would be slower than the whole suite - so this is deleted when a reader
// checks ssh2 rather than when a test says so.
export function generateParseableKeyPair(comment = "composery-test") {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const pair = utils.generateKeyPairSync("ed25519", { comment });
		if (!(utils.parseKey(pair.private) instanceof Error)) return pair;
	}
	// Twenty consecutive failures is not the defect above - at four in a
	// thousand that is a one-in-10^47 event - so it is something else entirely
	// and has to say so rather than hand back a key nothing can read.
	throw new Error(
		"ssh2 produced no parseable ed25519 key in 20 attempts; this is not the known flake."
	);
}

// The form `HOST_SSH_PRIVATE_KEY` is set in: Convex environment variables are single
// line, so `sshKeys.privateKey()` unescapes `\n` when it reads one back.
export function envPrivateKey(privateKey: string) {
	return privateKey.replace(/\n/g, "\\n");
}
