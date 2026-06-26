import { describe, expect, test } from "vitest";

import { loadOverlayModule } from "../../../../../support/overlay.ts";

type Harness = {
	clipboard: string[];
	commands: Map<string, () => Promise<void>>;
	documents: string[];
	errors: string[];
	execCalls: string[][];
	inputs: Array<{ prompt: string | undefined; value: string | undefined }>;
	modalAction: string | undefined;
};

function loadSshExtension({
	env = {},
	answers = [],
	copy = false,
	enrollFails = false
}: {
	env?: Record<string, string>;
	answers?: Array<string | undefined>;
	copy?: boolean;
	enrollFails?: boolean;
}): { run: () => Promise<void>; harness: Harness } {
	const remaining = [...answers];
	const harness: Harness = {
		clipboard: [],
		commands: new Map(),
		documents: [],
		errors: [],
		execCalls: [],
		inputs: [],
		modalAction: copy ? "Copy Prompt" : undefined
	};

	const vscode = {
		commands: {
			registerCommand(name: string, callback: () => Promise<void>) {
				harness.commands.set(name, callback);
				return { dispose() {} };
			}
		},
		env: {
			clipboard: {
				writeText: (value: string) => {
					harness.clipboard.push(value);
					return Promise.resolve();
				}
			}
		},
		window: {
			showInputBox: (options: { prompt?: string; value?: string }) => {
				harness.inputs.push({ prompt: options.prompt, value: options.value });
				return Promise.resolve(remaining.shift());
			},
			showInformationMessage: () => Promise.resolve(harness.modalAction),
			showErrorMessage: (message: string) => {
				harness.errors.push(message);
				return Promise.resolve();
			},
			showTextDocument: () => Promise.resolve(undefined)
		},
		workspace: {
			openTextDocument: ({ content }: { content: string }) => {
				harness.documents.push(content);
				return Promise.resolve({});
			}
		}
	};

	const { exports } = loadOverlayModule<{
		activate: (context: { subscriptions: unknown[] }) => void;
	}>({
		source: new URL(
			"../../../../../../overlay/lib/vscode/extensions/composery-ssh/extension.js",
			import.meta.url
		),
		dependencies: {
			vscode,
			child_process: {
				execFile(
					_file: string,
					args: string[],
					_options: unknown,
					callback: (
						error: Error | null,
						stdout: string,
						stderr: string
					) => void
				) {
					harness.execCalls.push(args);
					if (enrollFails) {
						callback(new Error("no authority"), "", "no authority");
						return;
					}
					callback(
						null,
						JSON.stringify({
							name: "my laptop",
							token: "composery_ssh_testtoken",
							expires_at: 1
						}),
						""
					);
				}
			}
		},
		globals: { process: { env } }
	});

	exports.activate({ subscriptions: [] });
	const run = harness.commands.get("composery.connectOverSsh");
	if (!run) throw new Error("composery.connectOverSsh was never registered");
	return { harness, run };
}

const ANSWERS = ["my laptop", "box.example.com", "22"];

describe("connecting a device over SSH", () => {
	test("mints through the CLI rather than writing the store itself", async () => {
		const { harness, run } = loadSshExtension({ answers: ANSWERS });
		await run();

		// The CLI is the single writer of the enrollment store. An extension that
		// wrote the file itself would be a second implementation of the hashing and
		// expiry the server reads back.
		expect(harness.execCalls).toEqual([
			["ssh", "enroll", "--name", "my laptop", "--json"]
		]);
		expect(harness.errors).toEqual([]);
	});

	test("puts the token and the address into the prompt it opens", async () => {
		const { harness, run } = loadSshExtension({ answers: ANSWERS });
		await run();

		const [prompt] = harness.documents;
		expect(prompt).toContain("composery_ssh_testtoken");
		expect(prompt).toContain("box.example.com/_composery/ssh/enroll");
		expect(prompt).toContain("Port 22");
	});

	// The durable credential is generated on the user's machine and never travels.
	// Only the single-use token is in this text, which is what makes pasting it
	// into somebody else's model acceptable at all.
	test("never asks the agent for a private key", async () => {
		const { harness, run } = loadSshExtension({ answers: ANSWERS });
		await run();

		const [prompt] = harness.documents;
		expect(prompt).toContain("Send ONLY the public half");
		expect(prompt).toContain("Do not read, print, echo, or repeat any");
		expect(prompt).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
	});

	test("offers the cloud's own address as the default when there is one", async () => {
		const { harness, run } = loadSshExtension({
			answers: ANSWERS,
			env: { COMPOSERY_CLOUD_ORIGIN: "https://box.composery.cloud" }
		});
		await run();

		// Scheme stripped: this is an SSH host, not a URL.
		expect(harness.inputs[1]?.value).toBe("box.composery.cloud");
	});

	test("asks for the address on a self-hosted instance rather than guessing", async () => {
		const { harness, run } = loadSshExtension({ answers: ANSWERS });
		await run();

		expect(harness.inputs[1]?.value).toBeUndefined();
	});

	test("copies the prompt only when asked", async () => {
		const quiet = loadSshExtension({ answers: ANSWERS });
		await quiet.run();
		expect(quiet.harness.clipboard).toEqual([]);

		const copied = loadSshExtension({ answers: ANSWERS, copy: true });
		await copied.run();
		expect(copied.harness.clipboard[0]).toContain("composery_ssh_testtoken");
	});

	// Cancelled at each step in turn, not just the first. Backing out of any one
	// of them has to stop the whole thing: a guard that only exists on the first
	// question still passes a test that cancels there, because the next question
	// is cancelled too and something later catches it.
	test.each([0, 1, 2])(
		"mints nothing when the person backs out at step %i",
		async (step) => {
			const answers = ANSWERS.slice(0, step) as Array<string | undefined>;
			answers.push(undefined);
			const { harness, run } = loadSshExtension({ answers });
			await run();

			expect(harness.inputs).toHaveLength(step + 1);
			expect(harness.execCalls).toEqual([]);
			expect(harness.documents).toEqual([]);
		}
	);

	test("reports a failure instead of opening an empty prompt", async () => {
		const { harness, run } = loadSshExtension({
			answers: ANSWERS,
			enrollFails: true
		});
		await run();

		expect(harness.documents).toEqual([]);
		expect(harness.errors[0]).toContain("Could not set up SSH access");
	});
});
