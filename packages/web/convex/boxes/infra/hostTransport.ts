"use node";

import ssh2 from "ssh2";
import { MINUTE_MS } from "../../time";
import { sshFailure } from "./hostScripts";

const { Client } = ssh2;

export type SshTarget = {
	host: string;
	port?: number;
	privateKey: string;
	username: string;
};

export async function runSsh(
	target: SshTarget,
	command: string,
	options: { maxOutputBytes?: number; timeoutMs?: number } = {}
) {
	return await new Promise<{ stderr: string; stdout: string }>(
		(resolve, reject) => {
			const client = new Client();
			let outputBytes = 0;
			const maxOutputBytes = options.maxOutputBytes ?? 10 * 1024 * 1024;
			const timeout = setTimeout(
				() => fail(new Error("SSH command timed out.")),
				options.timeoutMs ?? 10 * MINUTE_MS
			);

			function cleanUp() {
				clearTimeout(timeout);
				client.end();
			}
			function fail(error: Error) {
				cleanUp();
				reject(error);
			}
			function succeed(output: { stderr: string; stdout: string }) {
				cleanUp();
				resolve(output);
			}

			client
				.on("ready", () => {
					client.exec(command, (error, stream) => {
						if (error) {
							fail(error);
							return;
						}

						let stdout = "";
						let stderr = "";
						const onStdout = (chunk: Buffer) => {
							outputBytes += chunk.length;
							if (outputBytes > maxOutputBytes) {
								fail(new Error("SSH command output exceeded its limit."));
								return;
							}
							stdout += chunk.toString("utf8");
						};
						const onStderr = (chunk: Buffer) => {
							outputBytes += chunk.length;
							if (outputBytes > maxOutputBytes) {
								fail(new Error("SSH command output exceeded its limit."));
								return;
							}
							stderr += chunk.toString("utf8");
						};
						stream.on("data", onStdout);
						stream.stderr.on("data", onStderr);
						// Stryker disable next-line StringLiteral: ssh2 reports stream errors on this event, but its server protocol cannot emit one to a client test.
						stream.on("error", fail);
						stream.on("close", (code: number | null) => {
							if (code) {
								fail(new Error(sshFailure(stderr, code)));
								return;
							}
							succeed({ stdout, stderr });
						});
					});
				})
				.on("error", fail)
				.connect({
					host: target.host,
					keepaliveCountMax: 6,
					keepaliveInterval: 10_000,
					...(target.port ? { port: target.port } : {}),
					username: target.username,
					privateKey: target.privateKey,
					readyTimeout: MINUTE_MS
				});
		}
	);
}
