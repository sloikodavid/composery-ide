/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Upstream's own layout types restated, because a module that imports VS Code can
// only be compiled by the image build - the same reason IViewportDimensions is
// declared in terminalClients.ts rather than imported. They are structurally what
// the pty host passes in and hands back (ISetTerminalLayoutInfoArgs and the
// IRawTerminal*LayoutInfo pair at T = number), and a test pins them to those
// declarations so an upstream rename fails in the checkout rather than in Docker.

export interface ITerminalLayoutInstance {
	relativeSize: number;
	terminal: number;
}

export interface ITerminalLayoutTab {
	isActive: boolean;
	activePersistentProcessId: number | undefined;
	terminals: ITerminalLayoutInstance[];
}

export interface ITerminalLayout {
	workspaceId: string;
	tabs: ITerminalLayoutTab[];
	background: number[] | null;
}

/** What the merge reads of a candidate process; the pty host's own class supplies it. */
export interface IMergeableTerminalProcess {
	readonly shellLaunchConfig: { readonly hideFromUser?: boolean };
}

/**
 * Every terminal a client may be shown, in the layout it asked for.
 *
 * Upstream answers a layout request with the last layout that workspace stored,
 * which belongs to whichever client wrote it last. A terminal another window
 * created - or one the API created, which belongs to no window at all - is a pty
 * that exists and is absent from the answer, so it appears nowhere and its output
 * goes unread. The client's own layout is authoritative for placement and
 * ordering; a candidate it does not mention is appended, hidden terminals to the
 * background and the rest each as their own tab.
 *
 * Which processes are candidates is the caller's to decide, because the answer
 * grew a second clause the day the API could own a terminal.
 *
 * A client with no stored layout and nothing to adopt is left undefined rather
 * than an empty layout: upstream reads undefined as "this client has never
 * reported one" and an empty layout as "it reported having no terminals", and the
 * second one discards the session it is being asked to restore.
 */
export function mergeTerminalLayouts(
	workspaceId: string,
	layout: ITerminalLayout | undefined,
	candidates: Iterable<readonly [number, IMergeableTerminalProcess]>
): ITerminalLayout | undefined {
	const tabs = layout?.tabs.map(tab => ({ ...tab, terminals: [...tab.terminals] })) ?? [];
	const background = [...(layout?.background ?? [])];
	const knownIds = new Set([...tabs.flatMap(tab => tab.terminals.map(terminal => terminal.terminal)), ...background]);
	for (const [id, process] of candidates) {
		if (knownIds.has(id)) {
			continue;
		}
		knownIds.add(id);
		if (process.shellLaunchConfig.hideFromUser) {
			background.push(id);
		} else {
			tabs.push({ isActive: false, activePersistentProcessId: id, terminals: [{ terminal: id, relativeSize: 1 }] });
		}
	}
	return !layout && tabs.length === 0 && background.length === 0 ? undefined : { workspaceId, tabs, background };
}
