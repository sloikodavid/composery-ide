"use node";

import ssh2 from "ssh2";
import { requiredEnv } from "../../env";

const { utils } = ssh2;

export function privateKey() {
	return requiredEnv("HOST_SSH_PRIVATE_KEY").replace(/\\n/g, "\n");
}

export function authorizedPublicKey() {
	const parsedKey = utils.parseKey(privateKey());
	if (parsedKey instanceof Error) {
		throw new Error(
			`HOST_SSH_PRIVATE_KEY could not be parsed: ${parsedKey.message}`
		);
	}

	return `${parsedKey.type} ${parsedKey.getPublicSSH().toString("base64")} composery-web`;
}
