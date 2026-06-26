import { describe, expect, test, vi } from "vitest";

import { terminalWorkspaceId } from "../../../../../../../../../../../overlay/lib/vscode/src/vs/workbench/contrib/terminal/common/remote/terminalWorkspaceId.ts";

// A stand-in for VS Code's hash: distinct inputs give distinct numbers, so an id
// collision below is a collision in the identity, not in the digest.
const digests = new Map<string, number>();
const hash = (input: string) => {
	if (!digests.has(input)) digests.set(input, digests.size + 1);
	return digests.get(input)!;
};

const folder = (path: string, authority = "localhost:8080") => ({
	uri: { scheme: "vscode-remote", authority, path }
});

describe("terminal workspace id", () => {
	// The whole point of the rule: upstream hashes the folder URI including the
	// authority the browser happened to use, so the same server reached over the LAN
	// filed its terminals under a second workspace and the ones started over
	// localhost were nowhere to be found.
	test("the same folder reached through two addresses is one workspace", () => {
		expect(
			terminalWorkspaceId({ folders: [folder("/home/user/app")] }, hash)
		).toBe(
			terminalWorkspaceId(
				{ folders: [folder("/home/user/app", "10.0.0.4:8080")] },
				hash
			)
		);
	});

	test("two different folders are two workspaces", () => {
		expect(
			terminalWorkspaceId({ folders: [folder("/home/user/app")] }, hash)
		).not.toBe(
			terminalWorkspaceId({ folders: [folder("/home/user/other")] }, hash)
		);
	});

	test("a multi-root workspace is identified by its configuration file alone", () => {
		const id = terminalWorkspaceId(
			{
				configuration: { path: "/home/user/two.code-workspace" },
				folders: [folder("/home/user/app"), folder("/home/user/other")]
			},
			hash
		);

		expect(id).toBe(
			terminalWorkspaceId(
				{
					configuration: { path: "/home/user/two.code-workspace" },
					folders: [folder("/home/user/app")]
				},
				hash
			)
		);
		expect(id).not.toBe(
			terminalWorkspaceId({ folders: [folder("/home/user/app")] }, hash)
		);
	});

	test("folder order distinguishes one workspace from another", () => {
		expect(
			terminalWorkspaceId({ folders: [folder("/a"), folder("/b")] }, hash)
		).not.toBe(
			terminalWorkspaceId({ folders: [folder("/b"), folder("/a")] }, hash)
		);
	});

	// Serialized terminal state on the server carries the workspace id, so this
	// string is what a restart matches a client against: changing how it is built
	// orphans every terminal an existing instance is holding.
	test("the identity hashed is the paths and nothing else", () => {
		const spy = vi.fn(() => 0);

		terminalWorkspaceId({ folders: [folder("/home/user/app")] }, spy);
		expect(spy).toHaveBeenCalledWith('{"folders":["/home/user/app"]}');

		spy.mockClear();
		terminalWorkspaceId(
			{ configuration: { path: "/home/user/two.code-workspace" }, folders: [] },
			spy
		);
		expect(spy).toHaveBeenCalledWith(
			'{"configuration":"/home/user/two.code-workspace"}'
		);
	});

	test("the id is namespaced so it cannot be read as an upstream one", () => {
		expect(terminalWorkspaceId({ folders: [folder("/a")] }, () => 255)).toBe(
			"remote:ff"
		);
	});
});
