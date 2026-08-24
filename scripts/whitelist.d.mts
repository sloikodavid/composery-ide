export type WhitelistEntry = string;

export type WhitelistSource =
	| { path: string; contents: Uint8Array; gitlink?: never }
	| { path: string; contents?: never; gitlink: string };

export function createWhitelist(input: {
	sources: WhitelistSource[];
	existing?: WhitelistEntry[];
	patterns?: string[];
}): WhitelistEntry[];

export function checkWhitelist(input: {
	entries: WhitelistEntry[];
	sources: WhitelistSource[];
	patterns?: string[];
}): string[];

export function checkRepository(root: string): string[];
export function writeRepositoryWhitelist(
	root: string,
	options?: { acceptNew?: boolean }
): {
	changed: boolean;
	blocked: boolean;
	additions: string[];
	removals: string[];
};
