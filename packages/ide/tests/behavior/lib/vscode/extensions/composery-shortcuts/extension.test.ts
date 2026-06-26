import { posix } from "node:path";
import { TextDecoder, TextEncoder } from "node:util";

import { describe, expect, test } from "vitest";

import { loadOverlayModule } from "../../../../../support/overlay.ts";

function loadShortcutStorage(
	env: Record<string, string>,
	stored?: { version: number; shortcuts: unknown[] }
): { read(): Promise<Array<{ file?: string; type: string }>> } {
	class FileSystemError extends Error {
		code: string;

		constructor(code: string) {
			super(code);
			this.code = code;
		}
	}
	const uri = (value: string) => ({
		path: value,
		toString: () => `file://${value}`
	});
	const vscode = {
		FileSystemError,
		TreeItem: class {},
		Uri: {
			file: uri,
			joinPath(base: { path: string }, ...segments: string[]) {
				return uri(posix.join(base.path, ...segments));
			}
		},
		workspace: {
			fs: {
				createDirectory() {
					return Promise.resolve();
				},
				readFile() {
					if (stored === undefined) {
						throw new FileSystemError("FileNotFound");
					}
					return Promise.resolve(
						new TextEncoder().encode(JSON.stringify(stored))
					);
				}
			}
		}
	};
	const loaded = loadOverlayModule<Record<string, never>>({
		source: new URL(
			"../../../../../../overlay/lib/vscode/extensions/composery-shortcuts/extension.js",
			import.meta.url
		),
		dependencies: {
			"node:crypto": { randomUUID: () => "generated-id" },
			"node:path": { posix },
			"node:util": { TextDecoder, TextEncoder },
			vscode
		},
		globals: { process: { env } }
	});
	const Storage = loaded.binding<
		new (context: { globalStorageUri: ReturnType<typeof uri> }) => {
			read(): Promise<Array<{ file?: string; type: string }>>;
		}
	>("ShortcutStorage");

	return new Storage({ globalStorageUri: uri("/global-storage") });
}

describe("shortcuts extension storage", () => {
	test.each([
		[{}, "file:///data/persistence/config.json"],
		[
			{ COMPOSERY_DOCKER_VOLUME_PATH: "/mnt/composery-data" },
			"file:///mnt/composery-data/persistence/config.json"
		]
	])(
		"starts a missing store with the persistence config for its volume",
		async (env, expected) => {
			const defaults = await loadShortcutStorage(env).read();

			expect(defaults).toEqual([
				expect.objectContaining({ type: "file", file: expected })
			]);
		}
	);

	test("preserves an empty store the user explicitly saved", async () => {
		const shortcuts = await loadShortcutStorage(
			{},
			{ version: 1, shortcuts: [] }
		).read();

		expect(shortcuts).toEqual([]);
	});
});
