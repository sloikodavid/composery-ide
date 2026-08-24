export const GIT_FILE_ARGS: string[];

export const MODES: {
	executable: string;
	file: string;
	submodule: string;
	symlink: string;
};

export type IndexEntry = { mode: string; object: string; path: string };

export function gitFiles(): IndexEntry[];

export type Entry = { name: string; type: "directory" | "file" };

export function compareEntries(left: Entry, right: Entry): number;

export function linkTarget(
	path: string,
	target: string,
	paths: Set<string>
): string;

export function entryLabel(
	entry: Entry & { mode?: string; target?: string }
): string;

export function dropStrayTrees(current: string): string;

export function renderTree(): string;

export function renderAgentsFile(current: string, tree: string): string;

export function syncTick(): boolean;
