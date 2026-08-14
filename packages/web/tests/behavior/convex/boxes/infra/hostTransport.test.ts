import { createServer, type AddressInfo } from "node:net";
import ssh2, { type Connection, type ServerChannel } from "ssh2";
import { describe, expect, test } from "vitest";
import { runSsh } from "@/convex/boxes/infra/hostTransport";
import { generateParseableKeyPair } from "../../../../support/ssh.ts";

const { Server } = ssh2;
const hostKey = generateParseableKeyPair().private;
const clientKey = generateParseableKeyPair().private;

type ExecRequest = {
	accept: () => ServerChannel;
	command: string;
	reject: () => void;
};

async function localSshServer(handle: (request: ExecRequest) => void) {
	const clients = new Set<Connection>();
	let reportDisconnect!: () => void;
	const disconnected = new Promise<void>((resolve) => {
		reportDisconnect = resolve;
	});
	const server = new Server({ hostKeys: [hostKey] }, (client) => {
		clients.add(client);
		client.on("close", () => {
			clients.delete(client);
			reportDisconnect();
		});
		client.on("authentication", (context) => context.accept());
		client.on("ready", () => {
			client.on("session", (accept) => {
				const session = accept();
				session.on("exec", (acceptExec, rejectExec, info) => {
					handle({
						accept: () => acceptExec(),
						command: info.command,
						reject: rejectExec
					});
				});
			});
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const port = (server.address() as AddressInfo).port;

	return {
		close: async () => {
			for (const client of clients) client.end();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		},
		disconnected,
		target: {
			host: "127.0.0.1",
			port,
			privateKey: clientKey,
			username: "composery"
		}
	};
}

async function withServer<T>(
	handle: (request: ExecRequest) => void,
	run: (
		target: Awaited<ReturnType<typeof localSshServer>>["target"],
		disconnected: Promise<void>
	) => Promise<T>
) {
	const peer = await localSshServer(handle);
	try {
		return await run(peer.target, peer.disconnected);
	} finally {
		await peer.close();
	}
}

describe("the SSH transport", () => {
	test.each([0, undefined] as const)(
		"returns both streams when a real SSH channel exits with %s",
		async (code) => {
			let command = "";
			const result = await withServer(
				(request) => {
					command = request.command;
					const channel = request.accept();
					channel.write("answer");
					channel.stderr.write("warning");
					if (code !== undefined) channel.exit(code);
					channel.end();
				},
				async (target, disconnected) => {
					const output = await runSsh(target, "printf answer");
					await disconnected;
					return output;
				}
			);

			expect(result).toEqual({ stderr: "warning", stdout: "answer" });
			expect(command).toBe("printf answer");
		}
	);

	test("reports the real channel's stderr for a non-zero exit", async () => {
		await expect(
			withServer(
				(request) => {
					const channel = request.accept();
					channel.stderr.write("disk full");
					channel.exit(1);
					channel.end();
				},
				async (target) => await runSsh(target, "repair")
			)
		).rejects.toThrow("disk full");
	});

	test("rejects a server that refuses to open the command", async () => {
		await expect(
			withServer(
				(request) => request.reject(),
				async (target) => await runSsh(target, "true")
			)
		).rejects.toThrow("Unable to exec");
	});

	test("reports a real SSH connection failure", async () => {
		const listener = createServer();
		await new Promise<void>((resolve) =>
			listener.listen(0, "127.0.0.1", resolve)
		);
		const port = (listener.address() as AddressInfo).port;
		await new Promise<void>((resolve, reject) =>
			listener.close((error) => (error ? reject(error) : resolve()))
		);

		await expect(
			runSsh(
				{
					host: "127.0.0.1",
					port,
					privateKey: clientKey,
					username: "composery"
				},
				"true"
			)
		).rejects.toThrow(/connect/i);
	});

	test("times out a real channel that stops answering", async () => {
		await expect(
			withServer(
				(request) => {
					request.accept();
				},
				async (target) => await runSsh(target, "true", { timeoutMs: 10 })
			)
		).rejects.toThrow("SSH command timed out");
	});

	test.each(["stdout", "stderr"] as const)(
		"enforces the byte boundary on real %s data",
		async (stream) => {
			const write = (channel: ServerChannel, value: string) => {
				if (stream === "stdout") channel.write(value);
				else channel.stderr.write(value);
			};
			await expect(
				withServer(
					(request) => {
						const channel = request.accept();
						write(channel, "x".repeat(1024));
						channel.exit(0);
						channel.end();
					},
					async (target) =>
						await runSsh(target, "true", { maxOutputBytes: 1024 })
				)
			).resolves.toMatchObject({ [stream]: "x".repeat(1024) });

			await expect(
				withServer(
					(request) => {
						const channel = request.accept();
						write(channel, "x".repeat(1025));
						channel.exit(0);
						channel.end();
					},
					async (target) =>
						await runSsh(target, "true", { maxOutputBytes: 1024 })
				)
			).rejects.toThrow("SSH command output exceeded its limit");
		}
	);

	test("shares one byte budget across both real channel streams", async () => {
		await expect(
			withServer(
				(request) => {
					const channel = request.accept();
					channel.write("x".repeat(600));
					channel.stderr.write("y".repeat(600));
					channel.exit(0);
					channel.end();
				},
				async (target) => await runSsh(target, "true", { maxOutputBytes: 1024 })
			)
		).rejects.toThrow("SSH command output exceeded its limit");
	});
});
