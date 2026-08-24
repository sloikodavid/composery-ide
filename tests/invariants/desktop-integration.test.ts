// Opening a link or a text file inside the container. The handler is named in
// `mimeapps.list`, in the `.desktop` files and in `mailcap`, because three
// separate pieces of the desktop stack read three separate files and none of
// them will read ours. The duplication is theirs, so it cannot be removed or
// derived - only kept honest, which is what this does.
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { readRepoFile, repoRoot } from "../support/repo.ts";

const browserHelper =
	"/opt/composery/ide/current/lib/vscode/bin/helpers/browser.sh";

function parseIniEntries(content: string): Map<string, string> {
	return new Map(
		content
			.split(/\r?\n/)
			.filter((line) => line && !line.startsWith("["))
			.map((line) => {
				const separator = line.indexOf("=");
				return [line.slice(0, separator), line.slice(separator + 1)];
			})
	);
}

describe("desktop URL and text editor integration", () => {
	test("uses a dedicated URL handler for HTTP links", () => {
		const entry = parseIniEntries(
			readRepoFile(
				"rootfs/usr/share/applications/composery-url-handler.desktop"
			)
		);

		expect(entry.get("GenericName")).toBe("URL Handler");
		expect(entry.get("Exec")).toBe(`${browserHelper} %U`);
		expect(entry.get("NoDisplay")).toBe("true");
		expect(entry.get("MimeType")).toBe(
			"x-scheme-handler/http;x-scheme-handler/https;"
		);
	});

	test("names the editor desktop file consistently", () => {
		const oldPath = resolve(
			repoRoot,
			"rootfs/usr/share/applications/composery-editor.desktop"
		);
		const newPath = resolve(
			repoRoot,
			"rootfs/usr/share/applications/composery-text-editor.desktop"
		);
		const entry = parseIniEntries(
			readRepoFile(
				"rootfs/usr/share/applications/composery-text-editor.desktop"
			)
		);

		expect(existsSync(oldPath)).toBe(false);
		expect(existsSync(newPath)).toBe(true);
		expect(entry.get("GenericName")).toBe("Text Editor");
		expect(entry.get("Exec")).toBe("code --reuse-window %F");
	});

	test("keeps MIME defaults split between URLs and text editing", () => {
		const defaults = parseIniEntries(
			readRepoFile("rootfs/etc/xdg/mimeapps.list")
		);

		expect(defaults.get("x-scheme-handler/http")).toBe(
			"composery-url-handler.desktop"
		);
		expect(defaults.get("x-scheme-handler/https")).toBe(
			"composery-url-handler.desktop"
		);

		for (const mime of [
			"inode/directory",
			"text/plain",
			"text/markdown",
			"application/json",
			"text/html",
			"application/x-shellscript"
		]) {
			expect(defaults.get(mime)).toBe("composery-text-editor.desktop");
		}

		expect([...defaults.values()]).not.toContain("composery-editor.desktop");
	});

	test("exports BROWSER at image scope instead of only interactive bash startup", () => {
		const dockerfile = readRepoFile("Dockerfile");

		expect(dockerfile).toContain(`BROWSER="${browserHelper}"`);
		expect(dockerfile).not.toContain("export BROWSER");
	});

	// Two editor affordances a finger cannot reach on the settings upstream ships:
	// folding controls are revealed by hover ("mouseover"), so a region can be
	// unfolded on touch but never folded; and the minimap takes a fixed slice of the
	// width off a phone-sized editor to render a view of the file no one is going to
	// drag. Both are plain settings a user can put back.
	test("editor defaults suit the pointer this is used with", () => {
		const settings = JSON.parse(
			readRepoFile("rootfs/home/user/.local/share/composery/User/settings.json")
		) as Record<string, unknown>;

		expect(settings["editor.showFoldingControls"]).toBe("always");
		expect(settings["editor.minimap.enabled"]).toBe(false);
	});

	// The explorer deliberately shows what upstream hides - a `.git` you can see
	// is a `.git` you can delete - but search reads `files.exclude` as well, so
	// turning a pattern off there also sends Go to File and every text search
	// walking through `.git`. `search.exclude` is the only place to put it back,
	// and a settings file cannot derive one list from the other, so the pair is
	// pinned here.
	test("hides from search what the explorer deliberately shows", () => {
		const settings = JSON.parse(
			readRepoFile("rootfs/home/user/.local/share/composery/User/settings.json")
		) as {
			"files.exclude": Record<string, boolean>;
			"search.exclude": Record<string, boolean>;
		};
		const shown = Object.entries(settings["files.exclude"])
			.filter(([, excluded]) => !excluded)
			.map(([pattern]) => pattern);

		expect(shown).toContain("**/.git");
		for (const pattern of shown) {
			expect(settings["search.exclude"][pattern]).toBe(true);
		}
	});

	test("integrated terminal runs a login shell so ~/.profile and ~/.local/bin load", () => {
		const settings = JSON.parse(
			readRepoFile("rootfs/home/user/.local/share/composery/User/settings.json")
		) as {
			"terminal.integrated.defaultProfile.linux"?: string;
			"terminal.integrated.profiles.linux"?: { bash?: { args?: string[] } };
		};

		expect(settings["terminal.integrated.defaultProfile.linux"]).toBe("bash");
		expect(
			settings["terminal.integrated.profiles.linux"]?.bash?.args
		).toContain("-l");
	});
});
