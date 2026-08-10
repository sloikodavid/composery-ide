export type PlaneResult = {
	name: string;
	example: string;
	missing: string[];
	extra: string[];
};

export function envNames(contents: string, source: string): Set<string>;
export function nameLines(contents: string, source: string): Set<string>;

export function compareNames(options: {
	expected: Set<string>;
	actual: Set<string>;
}): Pick<PlaneResult, "missing" | "extra">;

export function listConvexNames(options?: {
	run?: (
		command: string,
		args: string[],
		options: Record<string, unknown>
	) => {
		error?: Error;
		status: number | null;
		stdout: string | Buffer;
	};
}): Set<string>;

export function checkDeployment(options: {
	environment: NodeJS.ProcessEnv | Record<string, unknown>;
	convexNames: Set<string>;
	read?: (file: string) => string;
}): PlaneResult[];

export function formatResult(result: PlaneResult): string;

export function main(options?: {
	environment?: NodeJS.ProcessEnv | Record<string, unknown>;
	convexNames?: Set<string>;
	read?: (file: string) => string;
	write?: (message: string) => void;
	writeError?: (message: string) => void;
}): { blocked: boolean; results: PlaneResult[] };
