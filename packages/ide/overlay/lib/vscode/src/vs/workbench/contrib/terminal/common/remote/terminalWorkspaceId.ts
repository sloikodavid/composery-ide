/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The workspace fields this identity is built from; IWorkspace supplies them. */
export interface ITerminalWorkspace {
	readonly configuration?: { readonly path: string } | null;
	readonly folders: readonly { readonly uri: { readonly path: string } }[];
}

/**
 * The name a workspace's terminals are filed under on the server.
 *
 * Upstream uses IWorkspace.id, which for a single folder is a hash of the folder
 * URI in full - scheme, authority and path. The authority is the address this
 * browser reached the server through, so opening the same folder over localhost
 * and over the LAN produced two workspaces, and terminals started in one were
 * invisible in the other. Only the path identifies a folder there, so only
 * the path is used; a multi-root workspace is identified by its .code-workspace
 * file instead, as upstream does.
 *
 * `hash` is a parameter rather than an import because both sides of the wire have
 * to agree on this string exactly, and a module free of upstream imports is one a
 * behaviour test can run.
 */
export function terminalWorkspaceId(workspace: ITerminalWorkspace, hash: (input: string) => number): string {
	const identity = workspace.configuration
		? { configuration: workspace.configuration.path }
		: { folders: workspace.folders.map(folder => folder.uri.path) };
	return `remote:${hash(JSON.stringify(identity)).toString(16)}`;
}
