import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { posix, resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { readRepoFile, repoRoot } from "../../../../tests/support/repo.ts";
import { addedLines, applyPatch, postImageLines } from "../support/patch.ts";

const PATCHES_DIR = "packages/ide/patches";
// VS Code's own convention for stylesheets beside a module, and the path
// release-contents.diff adds to the build's verbatim-copy list.
const ASSETS =
	"packages/ide/overlay/lib/vscode/src/vs/code/browser/workbench/media";
// The two small-screen gates are whole files we own, so they live in the overlay
// rather than in a /dev/null patch. See "overlay never shadows an upstream file".
const OVERLAY_VSCODE_SRC = "packages/ide/overlay/lib/vscode/src";
// The small-surface shell is a bundled entry point of its own, so it is ordinary
// overlay source that imports the gates rather than a verbatim-copied asset.
const SHELL = `${OVERLAY_VSCODE_SRC}/vs/code/browser/workbench/shell.ts`;

// Selectors are wrapped for readability in one sheet and not the other; compare
// them as the browser does, on whitespace-insensitive text.
const flat = (css: string) => css.replace(/\s+/g, " ");

// Every readable file under a repo-relative directory, as repo-relative paths.
const BINARY = /\.(png|jpe?g|gif|ico|woff2?|ttf|otf|mp4|webm|zip|gz)$/i;
function textFilesUnder(dir: string): string[] {
	return readdirSync(resolve(repoRoot, dir), { withFileTypes: true }).flatMap(
		(entry) => {
			const path = posix.join(dir, entry.name);
			if (entry.isDirectory()) return textFilesUnder(path);
			return entry.isFile() && !BINARY.test(entry.name) ? [path] : [];
		}
	);
}

// Whether a stylesheet hides an element by default and reveals it on hover - the
// upstream shape that makes a touch override necessary. `parts` identifies the
// element loosely enough to survive the extra qualifiers upstream hangs off the
// hover rule (`:hover:not(.highlighted)` and friends).
function hoverGate(css: string, parts: string[]) {
	const reveals = /display:\s*(block|flex|inline-block|inline|initial)/;
	const rules = [...flat(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
		.map((match) => ({ selector: match[1] ?? "", body: match[2] ?? "" }))
		.filter((rule) => parts.every((part) => rule.selector.includes(part)));

	return {
		hidden: rules.some(
			(rule) => /display:\s*none/.test(rule.body) && !reveals.test(rule.body)
		),
		revealedOnHover: rules.some(
			(rule) => rule.selector.includes(":hover") && reveals.test(rule.body)
		)
	};
}

// ---------------------------------------------------------------------------
// Patch stack lint: mechanical validity for every patch in the series.
// ---------------------------------------------------------------------------

const seriesNames = readRepoFile(`${PATCHES_DIR}/series`).trim().split(/\r?\n/);

describe("patch stack lint", () => {
	test("series and patch files match one to one", () => {
		const files = readdirSync(resolve(repoRoot, PATCHES_DIR))
			.filter((name) => name.endsWith(".diff"))
			.sort();
		expect([...seriesNames].sort()).toEqual(files);
		expect(new Set(seriesNames).size).toBe(seriesNames.length);
	});

	// The Docker build clones upstream by commit (no git context after COPY), so
	// the Dockerfile ARG duplicates the submodule pin; keep them from drifting.
	test("Dockerfile pins the same IDE upstream commit as the submodule", () => {
		const dockerfile = readRepoFile("Dockerfile");
		const pinned = /^ARG COMPOSERY_IDE_UPSTREAM_COMMIT=([0-9a-f]{40})$/m.exec(
			dockerfile
		)?.[1];
		const staged = execFileSync(
			"git",
			["ls-files", "-s", "packages/ide/upstream"],
			{ cwd: repoRoot, encoding: "utf8" }
		).match(/[0-9a-f]{40}/)?.[0];

		expect(pinned).toBeDefined();
		expect(pinned).toBe(staged);
	});

	test.each(seriesNames)("%s is pure LF", (name) => {
		const raw = readFileSync(resolve(repoRoot, PATCHES_DIR, name));
		expect(raw.includes("\r")).toBe(false);
	});

	// A truncated or hand-mangled hunk is the classic way a patch silently ships
	// less than it declares. Consume exactly the declared line counts per hunk,
	// then require the next line to leave diff-body territory.
	test.each(seriesNames)("%s hunk counts match their bodies", (name) => {
		const lines = readRepoFile(`${PATCHES_DIR}/${name}`).split("\n");
		let hunks = 0;

		for (let index = 0; index < lines.length; index++) {
			const header = lines[index]?.match(
				/^@@ -\d+(?:,(?<removed>\d+))? \+\d+(?:,(?<added>\d+))? @@/
			);
			if (!header?.groups) continue;

			hunks++;
			const label = `${name} hunk #${hunks}`;
			let removed = Number(header.groups.removed ?? 1);
			let added = Number(header.groups.added ?? 1);

			while (removed > 0 || added > 0) {
				index++;
				const line = lines[index];
				expect(line, `${label} body truncated`).toBeDefined();
				if (line!.startsWith("\\")) continue; // "\ No newline at end of file"
				if (line!.startsWith("+")) added--;
				else if (line!.startsWith("-")) removed--;
				else {
					added--;
					removed--;
				}
				expect(added, `${label} overran added count`).toBeGreaterThanOrEqual(0);
				expect(
					removed,
					`${label} overran removed count`
				).toBeGreaterThanOrEqual(0);
			}

			// After a consumed hunk the only legal continuations are another hunk,
			// a file marker, no-newline, or EOF. Anything else - a stray context
			// or blank line a hand edit left behind - makes GNU patch treat the
			// REST OF THE PATCH as garbage and drop every later hunk while
			// exiting 0. That exact failure shipped: touch-fling-catch's hunk #4
			// under-declared its body by one line and hunks 5-7 (the whole
			// inertia fix) silently never applied, in CI and in the image build.
			const next = lines[index + 1];
			const legal =
				next === undefined ||
				(next === "" && index + 2 === lines.length) || // trailing newline
				next.startsWith("@@ ") ||
				next.startsWith("diff ") ||
				next.startsWith("--- ") ||
				next.startsWith("\\");
			expect(legal, `${label} is followed by stray diff-body lines`).toBe(true);
		}

		expect(hunks).toBeGreaterThan(0);
	});

	// Count lints cannot catch a hunk GNU patch refuses at fuzz=0 (context
	// drift, parser quirks) - only real application can, and the Docker build is
	// a slow place to find out. Rehearse the exact stack the build applies:
	// code-server's own series, then ours, in order, on a shadow tree fed from
	// the pristine upstream working copy.
	//
	// Assemble one patch directory and one series first, exactly as build.sh
	// does, instead of applying the two series from where they live. Reading
	// each patch from its own directory made the rehearsal blind to the whole
	// namespace: ours was called clipboard.diff then, and it overwrote upstream's
	// identically named patch in the build tree and appended a duplicate entry, so the
	// image build died on "already applied" while this test stayed green. Ours
	// go under composery/ for that reason - assert the assembly keeps upstream's
	// patches intact and the series free of duplicates.
	// Timeout sized for what this does - copy a working tree and shell out to
	// patch once per file per patch - not for how long it happens to take on an
	// idle machine. It ran ~45s of a 60s budget here, so a loaded CI runner failed
	// it for being busy rather than for anything wrong with the stack.
	test(
		"the full patch stack applies with GNU patch at fuzz=0",
		{ timeout: 240_000 },
		() => {
			const upstream = resolve(repoRoot, "packages/ide/upstream");
			const shadow = mkdtempSync(resolve(tmpdir(), "composery-stack-"));

			const filesTouched = (patchText: string): string[] => {
				const files = new Set<string>();
				for (const line of patchText.split("\n")) {
					const header = /^(?:---|\+\+\+) (\S+)/.exec(line)?.[1];
					if (!header || header === "/dev/null") continue;
					// mimic -p1: strip the first path component (a/, code-server/, ...)
					const rel = header.split("/").slice(1).join("/");
					if (rel) files.add(rel);
				}
				return [...files];
			};

			const readSeries = (seriesDir: string) =>
				readFileSync(resolve(seriesDir, "series"), "utf8")
					.trim()
					.split(/\r?\n/)
					.filter((line) => line && !line.startsWith("#"));

			// build.sh step 3: upstream's patch directory, ours copied into its
			// composery/ subdirectory, their series lines then ours.
			const assembled = mkdtempSync(resolve(tmpdir(), "composery-patches-"));
			const upstreamPatches = resolve(upstream, "patches");
			const ourPatches = resolve(repoRoot, PATCHES_DIR);
			const upstreamNames = readSeries(upstreamPatches);
			const ourNames = readSeries(ourPatches);

			for (const name of upstreamNames) {
				copyFileSync(resolve(upstreamPatches, name), resolve(assembled, name));
			}
			mkdirSync(resolve(assembled, "composery"));
			for (const name of ourNames) {
				copyFileSync(
					resolve(ourPatches, name),
					resolve(assembled, "composery", name)
				);
			}
			const series = [
				...upstreamNames,
				...ourNames.map((name) => `composery/${name}`)
			];

			try {
				// The assembly above is build.sh step 3 restated in TypeScript, so it
				// is a copy that can drift - and did, in the workflow that used to
				// hold a third copy. Pin it to the script: change the namespace there
				// and this fails here rather than only in the image build.
				expect(readRepoFile("packages/ide/scripts/build.sh")).toContain(
					'cp "$PACKAGE_ROOT/patches/$p" "$BUILD/patches/composery/$p"; ' +
						'printf \'composery/%s\\n\' "$p" >> "$BUILD/patches/series"'
				);

				expect(new Set(series).size, "assembled series has duplicates").toBe(
					series.length
				);
				for (const name of upstreamNames) {
					expect(
						readFileSync(resolve(assembled, name), "utf8"),
						`assembling replaced code-server's ${name}`
					).toBe(readFileSync(resolve(upstreamPatches, name), "utf8"));
				}

				const patchedFiles = new Set<string>();
				for (const name of series) {
					const patchFile = resolve(assembled, name);
					for (const rel of filesTouched(readFileSync(patchFile, "utf8"))) {
						patchedFiles.add(rel);
						const dst = resolve(shadow, rel);
						const src = resolve(upstream, rel);
						if (!existsSync(dst) && existsSync(src)) {
							mkdirSync(posix.dirname(dst.replaceAll("\\", "/")), {
								recursive: true
							});
							copyFileSync(src, dst);
						}
					}
					try {
						applyPatch(patchFile, shadow);
					} catch (error) {
						const output = error as { stdout?: string; stderr?: string };
						expect.fail(
							`${name} does not apply at fuzz=0:\n${output.stdout ?? ""}${output.stderr ?? ""}`
						);
					}
				}

				// Applying cleanly is not the same as compiling. Folding patches
				// merges hunks that each added the same import to a file, and the
				// duplicate only surfaced in the image build's typecheck minutes
				// later ("Duplicate identifier 'isTouch'" in layout.ts/window.ts).
				// The assembled tree is already here - reject the whole class now.
				const duplicateImports = new Map<string, string[]>();
				for (const rel of patchedFiles) {
					// Skip what the stack removes outright, not just what it edits.
					if (!/\.ts$/.test(rel) || !existsSync(resolve(shadow, rel))) continue;
					const seen = new Set<string>();
					const twice = new Set<string>();
					for (const line of readFileSync(resolve(shadow, rel), "utf8").split(
						"\n"
					)) {
						if (!/^import .* from ['"]/.test(line)) continue;
						if (seen.has(line)) twice.add(line.trim());
						seen.add(line);
					}
					if (twice.size) duplicateImports.set(rel, [...twice]);
				}
				expect(Object.fromEntries(duplicateImports)).toEqual({});

				// These security pins live in a patch because the lockfile belongs to
				// the pinned upstream submodule; Renovate cannot update a patch hunk
				// without destroying its coordinates. An upstream bump must apply the
				// stack cleanly and keep the assembled runtime on fixed versions.
				const lock = JSON.parse(
					readFileSync(resolve(shadow, "package-lock.json"), "utf8")
				) as { packages?: Record<string, { version?: string }> };
				expect(lock.packages?.["node_modules/js-yaml"]?.version).toBe("4.3.0");
				expect(lock.packages?.["node_modules/body-parser"]?.version).toBe(
					"2.3.0"
				);

				const routes = readFileSync(
					resolve(shadow, "src/node/routes/index.ts"),
					"utf8"
				);
				const webClient = readFileSync(
					resolve(shadow, "lib/vscode/src/vs/server/node/webClientServer.ts"),
					"utf8"
				);
				expect(
					existsSync(resolve(shadow, "src/node/routes/domainProxy.ts"))
				).toBe(false);
				expect(routes).not.toContain('"/vscode"');
				expect(routes).toContain('app.router.use("/", vscode.router)');
				expect(webClient).not.toContain("x-forwarded-prefix");
				expect(webClient).toContain(
					"process.env.COMPOSERY_PROXY_URI ?? process.env.VSCODE_PROXY_URI ?? rootBase + '/proxy/{{port}}/'"
				);

				// An inline script under a hash-based CSP carries its own sha256, by
				// hand, in the same file. Edit the script and forget the hash and the
				// browser refuses to run it: the webview pre page is the whole webview
				// host, so every webview - markdown preview, notebooks, settings - comes
				// up blank, and nothing before this said a word. The assembled tree is
				// right here; recompute the hashes the way the browser does.
				const hashed = [
					"lib/vscode/src/vs/workbench/contrib/webview/browser/pre/index.html",
					"lib/vscode/src/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html"
				];
				for (const rel of hashed) {
					const html = readFileSync(resolve(shadow, rel), "utf8");
					const csp = /content="([^"]*script-src[^"]*)"/s.exec(html)?.[1];
					expect(csp, `${rel} declares no script-src`).toEqual(
						expect.any(String)
					);

					const scripts = [
						...html.matchAll(
							/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi
						)
					];
					expect(scripts.length, `${rel} has no inline script`).toBeGreaterThan(
						0
					);
					for (const [, body] of scripts) {
						const digest = createHash("sha256")
							// Windows checkouts are CRLF; the served file is LF, and so is
							// what the browser hashes.
							.update(Buffer.from((body ?? "").replaceAll("\r\n", "\n")))
							.digest("base64");
						expect(
							csp,
							`${rel}: inline script is not 'sha256-${digest}'`
						).toContain(`sha256-${digest}`);
					}
				}
			} finally {
				rmSync(shadow, { recursive: true, force: true });
				rmSync(assembled, { recursive: true, force: true });
			}
		}
	);
});

describe("local media preview", () => {
	const patch = () => readRepoFile(`${PATCHES_DIR}/local-media-preview.diff`);

	test("keeps uploaded media binary and outside the workspace", () => {
		const source = addedLines(patch());

		expect(source).toContain("if (getMediaMime(name))");
		expect(source).toContain("scheme: Schemas.tmp");
		expect(source).toContain("await fileService.writeFile(resource, contents)");
		// Media returns a resource and nothing else: contents is what an untitled
		// editor decodes, and text still takes that branch untouched.
		expect(source).toContain("result.complete({ resource });");
		expect(patch()).toContain(
			" \t\t\t\t\tresource: URI.from({ scheme: Schemas.untitled, path: name }),"
		);
	});

	// Both takers of a local file - the unsupported-browser "Open Files..."
	// fallback and a drop onto the workbench - hand extractFileListData's result
	// straight to openEditors. Fixing either call site leaves the other one
	// decoding the same bytes, so the fix has to stay in the helper they share.
	test("fixes the shared helper, not one of its two call sites", () => {
		const touched = patch()
			.split("\n")
			.filter((line) => line.startsWith("--- a/"))
			.map((line) => line.slice("--- a/".length));

		expect(touched).toEqual(["lib/vscode/src/vs/platform/dnd/browser/dnd.ts"]);
	});
});

describe("cloud password setup", () => {
	test("keeps self-hosted registration and gates cloud registration", () => {
		const authPatch = readRepoFile(`${PATCHES_DIR}/auth.diff`);
		const register = readRepoFile(
			"packages/ide/overlay/src/node/routes/register.ts"
		);

		expect(authPatch).toContain(
			'app.router.use("/_composery/cloud", cloudAuthRoute.router)'
		);
		expect(authPatch).toContain(
			'cloudConfig ? "_composery/cloud/authorize" : "register"'
		);
		expect(register).toContain("cloudConfig && hasCloudSetupGrant(req)");
		expect(register).toContain("await installCloudPassword");
	});

	test("binds the cloud callback with PKCE and restricted cookies", () => {
		const cloudAuth = readRepoFile(
			"packages/ide/overlay/src/node/routes/cloudAuth.ts"
		);
		const sessions = postImageLines(
			readRepoFile(`${PATCHES_DIR}/sessions.diff`)
		);

		expect(cloudAuth).toContain('createHash("sha256")');
		expect(cloudAuth).toContain('searchParams.set("code_challenge"');
		expect(cloudAuth).toContain('searchParams.set("state"');
		expect(cloudAuth).toContain("/api/cloud/auth/exchange");
		// Every cookie this route sets or clears takes its attributes from the
		// one helper, so none of them can drift out of step with the session
		// cookie the rest of the auth flow issues.
		expect(cloudAuth).not.toMatch(/httpOnly|sameSite|secure:/);
		for (const attribute of [
			"httpOnly: true",
			'path: "/",',
			'sameSite: "lax"',
			"secure:"
		]) {
			expect(sessions, attribute).toContain(attribute);
		}
	});

	test("renders authorization failures through the shared auth error slot", () => {
		const cloudAuth = readRepoFile(
			"packages/ide/overlay/src/node/routes/cloudAuth.ts"
		);
		const fields = readRepoFile(
			"packages/ide/overlay/src/browser/pages/cloud-error-fields.html"
		);

		expect(cloudAuth).toContain(
			'error: "Cloud authorization could not finish."'
		);
		expect(fields).not.toContain("auth-message");
		expect(fields).toContain('class="submit-button"');
	});
});

describe("soft-keyboard enter", () => {
	test("replays IME line-break commits as cancelable Enter keydowns", () => {
		// ImeEnterFallback is a whole file we own, so it lives in the overlay rather
		// than in a /dev/null hunk in touch.diff.
		const source = readRepoFile(
			`${OVERLAY_VSCODE_SRC}/vs/base/browser/imeEnter.ts`
		);

		// Both commit shapes, touch-gated, real events only, never mid-composition.
		expect(source).toContain(
			"if (!isTouch(window) || !e.isTrusted || e.isComposing) {"
		);
		expect(source).toContain(
			"if (e.inputType !== 'insertLineBreak' && e.inputType !== 'insertParagraph') {"
		);
		// A trusted Enter keydown already reached every listener - no replay.
		expect(source).toContain(
			"e.timeStamp - lastTrustedEnter < TRUSTED_ENTER_WINDOW_MS"
		);
		// xterm feeds the pty from input events itself - replaying would double up.
		expect(source).toContain("target.closest('.xterm')");
		// StandardKeyboardEvent maps from the legacy fields the constructor drops.
		expect(source).toContain("keyCode: { value: 13 }");
		expect(source).toContain("which: { value: 13 }");
		// The line-break insertion is cancelled when a consumer handled the replay - or
		// unconditionally when the keybar armed a modifier, since the synthetic keydown
		// then replaces the commit outright (see the Shift+Enter test).
		expect(source).toContain("const handled = !target.dispatchEvent(keydown);");
		// Installed for the main window and every future auxiliary window.
		expect(source).toContain("Event.runAndSubscribe(onDidRegisterWindow");
		// The construction site stays an upstream edit, so it stays in the patch.
		expect(addedLines(readRepoFile(`${PATCHES_DIR}/touch.diff`))).toContain(
			"this._register(new ImeEnterFallback());"
		);
	});

	test("asks soft keyboards for a newline key on single-line inputs", () => {
		const patch = readRepoFile(`${PATCHES_DIR}/touch.diff`);

		// Must be a key that commits a line break, because that commit is the only
		// thing ImeEnterFallback can replay. An action key ("go"/"send") renders as
		// Gboard's right arrow and emits nothing at all, disabling the fallback.
		expect(addedLines(patch)).toContain(
			"this.input.setAttribute('enterkeyhint', 'enter');"
		);
		for (const actionKey of ["'go'", "'send'", "'done'", "'search'"]) {
			expect(addedLines(patch)).not.toContain(`'enterkeyhint', ${actionKey}`);
		}
		// Only the single-line <input> branch gets the hint - the flexibleHeight
		// textarea keeps its newline return key (context line, not an added one).
		expect(patch).toContain(
			" \t\t\tthis.input.type = this.options.type || 'text';"
		);
	});

	test("quick input text prompts get a tap path that bypasses the IME", () => {
		const source = addedLines(readRepoFile(`${PATCHES_DIR}/touch.diff`));

		// The OK button feeds the same accept emitter Enter does; showing it on
		// touch guarantees submission even when the IME emits no event at all.
		expect(source).toContain("ok: isTouch(dom.getWindow(this.ui.container)),");
	});
});

describe("touch link activation", () => {
	test("terminal taps hit-test detected links and skip word links", () => {
		const source = addedLines(readRepoFile(`${PATCHES_DIR}/touch.diff`));

		// Words are everywhere; a tap must keep meaning "focus the terminal".
		expect(source).toContain("['url', 'localFile', 'localFolder'] as const");
		expect(source).not.toContain("'word'");
		// The same modifier-exempt activation path as the link quick pick.
		expect(source).toContain(
			"link.activate(new TerminalLinkQuickPickEvent(EventType.CLICK), link.text);"
		);
		// Any click that reaches a link on a touch screen is deliberate.
		expect(source).toContain("if (isTouch(getWindow(this._xterm.element))) {");
		// The tapped cell comes from the one place that answers that question, which
		// terminal touch selection asks too - two copies would disagree by a cell.
		expect(source).toContain(
			"const cell = getBufferCellAt(this._xterm, clientX, clientY);"
		);
		expect(
			readRepoFile(
				`${OVERLAY_VSCODE_SRC}/vs/workbench/contrib/terminal/browser/xtermCell.ts`
			)
		).toContain("'.xterm-screen'");
		// Tap listening waits for the terminal DOM and only ever engages on touch.
		expect(source).toContain(
			"this.add(dom.addDisposableListener(element, TouchEventType.Tap, (e: GestureEvent) => {"
		);
		// The link manager is read per tap, never captured while wiring: xtermOpen can run
		// before xtermReady creates it, and capturing it there left every tap inert
		// (device-verified - taps did nothing while the link quick pick still worked).
		expect(source).toContain("this._linkManager?.openLinkAt(");
		// Long-press fallback that reaches every detected link, not just tappable ones.
		expect(source).toContain("MenuId.TerminalInstanceContext");
	});

	test("editor context menu offers Open Link only while the cursor is on one", () => {
		const source = addedLines(readRepoFile(`${PATCHES_DIR}/touch.diff`));

		expect(source).toContain(
			"new RawContextKey<boolean>('composeryCursorOnLink', false)"
		);
		// Bound on touch only, so desktop menus never change.
		expect(source).toContain(
			"if (isTouch(getWindow(editor.getContainerDomNode()))) {"
		);
		expect(source).toContain(
			"this.cursorOnLink?.set(!!this.getLinkOccurrence(this.editor.getPosition()));"
		);
		expect(source).toContain("command: { id: 'editor.action.openLink'");
		expect(source).toContain("when: CURSOR_ON_LINK");
	});

	test("rendered-markdown links activate on Tap inside Gesture targets", () => {
		const source = addedLines(readRepoFile(`${PATCHES_DIR}/touch.diff`));

		expect(source).toContain("if (isTouch(DOM.getWindow(outElement))) {");
		expect(source).toContain("Gesture.addTarget(outElement)");
		expect(source).toContain("TouchEventType.Tap");
		// Tap resolves the anchor from the touched node, not the dispatch target.
		expect(source).toContain("DOM.isHTMLElement(e.initialTarget)");
	});
});

describe("touch inline actions", () => {
	test("lists, tables and trees stand down on taps consumed by inline controls", () => {
		const source = addedLines(readRepoFile(`${PATCHES_DIR}/touch.diff`));

		const guards = source.match(
			/e\.browserEvent\.type === TouchEventType\.Tap && e\.browserEvent\.defaultPrevented/g
		);
		// onViewPointer + onDoubleClick in listWidget, onViewPointer in abstractTree.
		expect(guards).toHaveLength(3);
	});

	test("hover-revealed action bars stay visible on touch", () => {
		const css = readRepoFile(`${ASSETS}/touch.css`);

		for (const surface of [
			".quick-input-list-entry-action-bar",
			".pane-header.expanded > .actions",
			".custom-view-tree-node-item",
			".scm-view",
			".open-editors",
			".debug-pane",
			".markers-panel",
			".comments-panel",
			".keybindings-table-container",
			".setting-toolbar-container"
		]) {
			expect(css).toContain(surface);
		}
		expect(css).toContain(".tabs-list .actions");
	});

	// Forcing an action bar visible is only right while upstream is still hiding it
	// behind a hover a finger cannot produce. Check the pairing against upstream
	// itself: if a bump stops hiding one, the !important below is no longer a fix
	// but a forced state we are imposing, and if the class is renamed the rule is
	// dead while looking exactly as alive as the rest.
	test("every forced action bar is one upstream still hides behind hover", () => {
		const touchCss = flat(readRepoFile(`${ASSETS}/touch.css`));

		for (const { css, parts, forced } of [
			{
				css: "src/vs/workbench/browser/parts/notifications/media/notificationsList.css",
				parts: [".notification-list-item-toolbar-container"],
				forced: ".notification-list-item-toolbar-container"
			},
			{
				css: "src/vs/workbench/contrib/search/browser/media/searchview.css",
				parts: [".search-view", ".monaco-list-row", ".monaco-action-bar"],
				forced: ".search-view .monaco-list .monaco-list-row .monaco-action-bar"
			},
			{
				css: "src/vs/workbench/contrib/preferences/browser/media/settingsWidgets.css",
				parts: [".setting-list-row", ".monaco-action-bar"],
				forced: ".setting-list-row .monaco-action-bar"
			}
		]) {
			const upstream = readRepoFile(`packages/ide/upstream/lib/vscode/${css}`);
			expect({
				forced,
				coveredOnTouch: touchCss.includes(forced),
				...hoverGate(upstream, parts)
			}).toEqual({
				forced,
				coveredOnTouch: true,
				hidden: true,
				revealedOnHover: true
			});
		}
	});

	// The IDE tree is built apart from the workspace, so it cannot import `shared` and
	// every Composery address it ships is a copy: the title-bar logo, the auth page's
	// brand link, product.json's documentation and newsletter URLs, the repository
	// coordinates. Copies drift in silence - shared says of REPO that "a fork repoints
	// these once and every derived URL follows", which is only true of the copies
	// something checks. This is that check.
	test("every Composery address in the IDE is the one shared defines", () => {
		const shared = readRepoFile("packages/shared/index.ts");
		const websiteOrigin = /WEBSITE_ORIGIN = "([^"]+)"/.exec(shared)?.[1];
		const repoOwner = /owner: "([^"]+)"/.exec(shared)?.[1];
		const repoName = /name: "([^"]+)"/.exec(shared)?.[1];
		expect({ websiteOrigin, repoOwner, repoName }).toEqual({
			websiteOrigin: expect.any(String) as string,
			repoOwner: expect.any(String) as string,
			repoName: expect.any(String) as string
		});

		const wrong: string[] = [];
		for (const file of textFilesUnder("packages/ide/patches").concat(
			textFilesUnder("packages/ide/overlay")
		)) {
			for (const match of readRepoFile(file).matchAll(
				/https?:\/\/[^"'\s)`]+/g
			)) {
				let url: URL;
				try {
					url = new URL(match[0]);
				} catch {
					continue; // a template literal, not an address
				}

				if (
					url.hostname.includes("composery") &&
					url.origin !== websiteOrigin
				) {
					wrong.push(`${file}: ${match[0]}`);
				}
				// Only addresses that name this project. Links to code-server and VS Code
				// are upstream provenance and belong to their owners.
				const repo = url.pathname.split("/")[2]?.replace(/\.git$/, "");
				if (
					url.hostname === "github.com" &&
					repo?.toLowerCase().includes("composery") &&
					!url.pathname.startsWith(`/${repoOwner}/${repoName}`)
				) {
					wrong.push(`${file}: ${match[0]}`);
				}
			}
		}

		expect(wrong).toEqual([]);
	});

	test("notebook insert-cell toolbars are reachable on touch", () => {
		const css = readRepoFile(`${ASSETS}/touch.css`);

		// The two hover-only insert affordances: the per-notebook top bar and the
		// focused cell's insert-below bar. The title toolbar and run button already
		// reveal on .focused, so they are deliberately not forced here.
		expect(css).toContain(".cell-list-top-cell-toolbar-container");
		expect(css).toContain(
			"> .monaco-list-row.focused\n\t\t.cell-bottom-toolbar-container"
		);
	});
});

// ---------------------------------------------------------------------------
// Mobile viewport contract: every top-level HTML surface we serve declares the
// same viewport capabilities.
//
// Top-level only, and that is the whole rule. Chromium processes a viewport meta
// and exposes env(safe-area-inset-*) for the main frame alone - measured on
// Android Chrome 134, a subframe declaring `width=500, viewport-fit=cover` laid
// out at its parent's 411px, exactly like a subframe declaring nothing, and read
// every inset as 0 while the top frame read a real 24px bottom inset. So a
// viewport meta on webview content (the pre page, the QR extension) is decoration
// that reads as configuration, and none of those surfaces belongs in this list.
// ---------------------------------------------------------------------------

const VIEWPORT_PARTS = [
	"viewport-fit=cover",
	"interactive-widget=resizes-content"
];

// Every viewport meta declared in a source, whatever surrounds it - the pages
// wrap the attributes over several lines and the patch keeps them on one.
const viewportMetas = (source: string) =>
	[...source.matchAll(/<meta\b[^>]*\bname="viewport"[^>]*>/g)]
		.map((meta) => /\bcontent="([^"]*)"/.exec(meta[0])?.[1])
		.filter((content) => content !== undefined);

describe("mobile viewport contract", () => {
	// Read the metas, not the file. Asserting the two parts appear *somewhere* in
	// the text passes just as happily on a file that declares three viewports and
	// fixes one - and workbench-page.diff is exactly that shape, since a patch also
	// carries the upstream lines it replaces.
	const surfaces: [path: string, read: (text: string) => string][] = [
		["packages/ide/overlay/src/browser/pages/error.html", (text) => text],
		["packages/ide/overlay/src/browser/pages/auth.html", (text) => text],
		["packages/ide/overlay/src/node/persistence/readiness.ts", (text) => text],
		[`${PATCHES_DIR}/workbench-page.diff`, addedLines]
	];

	test.each(surfaces)("%s declares the shared viewport parts", (path, read) => {
		const metas = viewportMetas(read(readRepoFile(path)));

		// A surface with no viewport meta at all would otherwise pass vacuously.
		expect(metas.length).toBeGreaterThan(0);
		for (const meta of metas) {
			for (const part of VIEWPORT_PARTS) {
				expect(meta, `${path}: ${meta}`).toContain(part);
			}
		}
	});

	// The other half of the rule: nothing we render into a webview declares one,
	// because it would do nothing there while reading as though it did.
	test("webview content declares no viewport of its own", () => {
		expect(
			viewportMetas(
				readRepoFile(
					"packages/ide/overlay/lib/vscode/extensions/composery-qr/extension.js"
				)
			)
		).toEqual([]);

		// One added viewport meta in the whole stack - the workbench page. The
		// webview page is the one that must never grow one back: Chromium ignores
		// a viewport meta in a nested browsing context, so declaring one there
		// only looks like it does something. Its styles live in narrow.diff, so
		// check both patches, not just the page that is allowed the meta.
		const patch = readRepoFile(`${PATCHES_DIR}/workbench-page.diff`);
		expect(viewportMetas(addedLines(patch))).toHaveLength(1);
		expect(patch).not.toContain("pre/fake.html");
		expect(
			viewportMetas(addedLines(readRepoFile(`${PATCHES_DIR}/narrow.diff`)))
		).toEqual([]);
	});
});

describe("adaptive favicon", () => {
	test.each([
		"packages/ide/overlay/src/browser/pages/auth.html",
		"packages/ide/overlay/src/browser/pages/error.html",
		`${PATCHES_DIR}/workbench-page.diff`
	])(
		"%s declares the sized ICO fallback before the adaptive SVG favicon",
		(path) => {
			const raw = readRepoFile(path);
			const content = path.endsWith(".diff") ? addedLines(raw) : raw;

			// ICO first with an explicit sizes attribute, adaptive SVG last with
			// sizes="any": Chromium picks an unsized or later-listed ICO over the
			// SVG and the tab icon stops following the colour scheme. The ICO
			// stays declared for browsers, webviews and bookmark/crawler services
			// without SVG-favicon support.
			const ico = content.indexOf("favicon.ico");
			const svg = content.indexOf("favicon.svg");
			expect(ico).toBeGreaterThan(-1);
			expect(svg).toBeGreaterThan(ico);
			expect(content).toContain('type="image/x-icon"');
			expect(content).toContain('sizes="32x32"');
			expect(content).toContain('type="image/svg+xml"');
			expect(content).toContain('sizes="any"');
			expect(content).not.toContain("alternate icon");
		}
	);

	test("generated adaptive favicon uses an internal color-scheme media query", () => {
		const favicon = readRepoFile(
			"packages/ide/overlay/src/browser/media/favicon.svg"
		);

		expect(favicon).toContain("@media (prefers-color-scheme:dark)");
		expect(favicon).toContain("currentColor");
		expect(favicon).not.toContain('media="(prefers-color-scheme');
	});

	test.each([
		[
			"packages/ide/overlay/src/browser/pages/auth.html",
			"src/browser/pages/favicon.js"
		],
		[
			"packages/ide/overlay/src/browser/pages/error.html",
			"src/browser/pages/favicon.js"
		],
		[`${PATCHES_DIR}/workbench-page.diff`, "src/browser/pages/favicon.js"]
	])(
		"%s hands the SVG favicon the scheme-pinned pair and the script that swaps it",
		(path, script) => {
			const raw = readRepoFile(path);
			const content = path.endsWith(".diff") ? addedLines(raw) : raw;

			// The adaptive file alone only ever caught up across a reload: Chromium
			// rasterizes a favicon once per URL and never re-runs the embedded
			// media query. The swap itself is driven by
			// `packages/ide/overlay/src/browser/pages/favicon.js`, which nothing
			// executes here: it is DOM code and the ide projects are
			// `environment: "node"` (see the `src/browser/pages/**` exclusion in
			// vitest.config.ts). This asserts only that each page still declares
			// both files and loads that script.
			expect(content).toContain("favicon-light.svg");
			expect(content).toContain("favicon-dark.svg");
			expect(content).toContain(script);
		}
	);

	// One script for every surface, so the workbench and the auth pages cannot
	// drift into two behaviours. It lives with the pages because that is the path
	// all three can reach, and upstream's release step ships that directory as
	// templates only - *.html and *.css - so the script reaching the release at
	// all is something release-contents.diff does. Pin that, or the page loads a
	// 404 and nothing fails until someone opens it.
	test("there is exactly one favicon script, and the release ships it", () => {
		expect(
			existsSync(resolve(repoRoot, `${ASSETS}/favicon.js`)),
			"a second favicon script under the workbench media"
		).toBe(false);
		expect(
			addedLines(readRepoFile(`${PATCHES_DIR}/release-contents.diff`))
		).toContain(
			'rsync src/browser/pages/*.js "$RELEASE_PATH/src/browser/pages"'
		);
	});
});

describe("custom editors", () => {
	// The service that registers every contributed editor (Image Preview,
	// notebooks, anything an extension contributes) is built by one startup
	// contribution that never touches it. Delayed hands that contribution a proxy
	// backed by a timeout-less requestIdleCallback, which a window started in a
	// hidden tab never gets - so nothing registers for that window's whole life.
	test("the contributed-editor service is built at startup, not on idle", () => {
		const patch = readRepoFile(`${PATCHES_DIR}/custom-editors.diff`);

		expect(patch).toContain(
			"-registerSingleton(ICustomEditorService, CustomEditorService, InstantiationType.Delayed);"
		);
		expect(patch).toContain(
			"+registerSingleton(ICustomEditorService, CustomEditorService, InstantiationType.Eager);"
		);
	});

	// Eager only helps because a BlockStartup contribution depends on the service.
	// If upstream ever drops that argument, the service goes back to being built
	// by whoever happens to ask first - which is the bug, one step removed.
	test("a startup contribution still depends on the service", () => {
		const factory = readRepoFile(
			"packages/ide/upstream/lib/vscode/src/vs/workbench/contrib/customEditor/browser/customEditorInputFactory.ts"
		);
		const contribution = readRepoFile(
			"packages/ide/upstream/lib/vscode/src/vs/workbench/contrib/customEditor/browser/customEditor.contribution.ts"
		);

		expect(factory).toContain("@ICustomEditorService _customEditorService");
		expect(contribution).toContain(
			"registerWorkbenchContribution2(ComplexCustomWorkingCopyEditorHandler.ID, ComplexCustomWorkingCopyEditorHandler, WorkbenchPhase.BlockStartup)"
		);
	});
});

describe("default color theme", () => {
	const themeServiceRel =
		"lib/vscode/src/vs/workbench/services/themes/common/workbenchThemeService.ts";

	const themeColors = (file: string): Record<string, string> =>
		(
			JSON.parse(
				readRepoFile(
					`packages/ide/overlay/lib/vscode/extensions/composery-themes/themes/${file}`
				)
			) as { colors: Record<string, string> }
		).colors;

	// Apply the patch's theme-service section alone onto the pristine upstream
	// file, so the assertions run against exactly what the build tree contains
	// after quilt. brand.diff spans many files; only this one is seeded.
	const patchedThemeService = (): string => {
		const shadow = mkdtempSync(resolve(tmpdir(), "composery-theme-"));
		try {
			const dst = resolve(shadow, themeServiceRel);
			mkdirSync(posix.dirname(dst.replaceAll("\\", "/")), { recursive: true });
			copyFileSync(
				resolve(repoRoot, "packages/ide/upstream", themeServiceRel),
				dst
			);
			const section = readRepoFile(`${PATCHES_DIR}/brand.diff`)
				.split(/^(?=--- a\/)/m)
				.filter((part) => part.startsWith(`--- a/${themeServiceRel}`))
				.join("");
			expect(section).not.toBe("");
			const sectionFile = resolve(shadow, "theme-section.diff");
			writeFileSync(sectionFile, section);
			applyPatch(sectionFile, shadow);
			return readFileSync(dst, "utf8").replaceAll("\r\n", "\n");
		} finally {
			rmSync(shadow, { recursive: true, force: true });
		}
	};

	const patched = patchedThemeService();

	test("Composery themes are the ThemeSettingDefaults", () => {
		expect(patched).toContain(
			"export const COLOR_THEME_DARK = 'Composery Dark';"
		);
		expect(patched).toContain(
			"export const COLOR_THEME_LIGHT = 'Composery Light';"
		);
	});

	// The INITIAL_COLORS blocks are upstream's synchronous first-paint snapshot
	// of the default themes (themes load async from extension JSON). The patch
	// retints them by hand; this keeps the retint honest against the theme
	// JSONs. Keys the themes do not define keep upstream's values.
	test.each([
		["COLOR_THEME_DARK_INITIAL_COLORS", "composery-dark.json"],
		["COLOR_THEME_LIGHT_INITIAL_COLORS", "composery-light.json"]
	])("%s first paint agrees with %s", (constant, themeFile) => {
		const block = new RegExp(
			`export const ${constant} = \\{\\n([\\s\\S]*?)\\n\\};`
		).exec(patched)?.[1];
		expect(block).toBeDefined();

		const colors = themeColors(themeFile);
		let compared = 0;
		for (const line of block!.split("\n")) {
			const entry = /^\t'([^']+)': '([^']*)',?$/.exec(line);
			if (!entry) continue;
			const key = entry[1]!;
			if (!(key in colors)) continue;
			compared++;
			expect(entry[2], key).toBe(colors[key]);
		}
		expect(compared).toBeGreaterThan(100);
	});

	// The theme JSONs are generated; only where they genuinely share the
	// brand palette must they match it (a check instead of a generator). The
	// palette is read from the generated web brand.css, which sync.mjs --check
	// pins to packages/shared/index.ts.
	const brandTokens = (selector: string): Record<string, string> => {
		const block = new RegExp(`${selector} \\{([\\s\\S]*?)\\}`).exec(
			readRepoFile("packages/web/app/brand.css")
		)?.[1];
		expect(block).toBeDefined();
		return Object.fromEntries(
			[...block!.matchAll(/--([\w-]+): ([^;]+);/g)].map((entry) => [
				entry[1]!,
				entry[2]!
			])
		);
	};

	// Every theme colour that is one of ours by name, not by coincidence. Several
	// palette entries share a hex - `foreground`, `link` and `control` are the
	// same colour today - so a check written by matching values would pass on the
	// wrong token and stop meaning anything the moment one of them moved. The
	// workbench is layered, not uniform: the editor is the page background and
	// the chrome around it (activity bar, side bar, status bar) is the header
	// surface, so the shared tokens are the pair, not one colour.
	const SHARED_TOKENS: Record<string, string> = {
		"editor.background": "background",
		"editor.foreground": "foreground",
		"activityBar.background": "header",
		"activityBar.foreground": "foreground",
		"sideBar.background": "header",
		"sideBar.foreground": "foreground",
		"statusBar.background": "header",
		"button.secondaryBackground": "secondary-button",
		"button.secondaryForeground": "secondary-button-foreground",
		"button.secondaryHoverBackground": "secondary-button-hover",
		"badge.background": "badge",
		"badge.foreground": "badge-foreground"
	};

	test.each([
		["composery-dark.json", "\\.dark"],
		["composery-light.json", ":root"]
	])("%s matches the brand palette where they overlap", (file, selector) => {
		const colors = themeColors(file);
		const brand = brandTokens(selector);

		for (const [color, token] of Object.entries(SHARED_TOKENS)) {
			expect(brand[token], `--${token}`).toBeDefined();
			expect(colors[color], color).toBe(brand[token]);
		}
	});

	// The prominent button is the one place the IDE deliberately does not take a
	// palette entry. `--button` is the website's soft surface button; VS Code's
	// `button.background` is its call to action ("Install", "Trust the authors"),
	// and a soft surface reads there as a disabled control. It inverts the page
	// instead - which is still ours, and still pinned, because an inversion that
	// drifts to an arbitrary pair is exactly what this check exists to catch.
	test.each([
		["composery-dark.json", "\\.dark"],
		["composery-light.json", ":root"]
	])("%s inverts the page for the prominent button", (file, selector) => {
		const colors = themeColors(file);
		const brand = brandTokens(selector);

		expect(colors["button.background"]).toBe(brand["foreground"]);
		expect(colors["button.foreground"]).toBe(brand["background"]);
	});
});

describe("terminal edge padding", () => {
	// The padding patch only works because upstream's row fit subtracts the
	// xterm element's computed CSS padding (the same mechanism as the built-in
	// 20px gutter). If a bump drops that, the padding would clip the grid
	// instead of reserving space.
	test("upstream row fit still subtracts computed padding", () => {
		const instance = readRepoFile(
			"packages/ide/upstream/lib/vscode/src/vs/workbench/contrib/terminal/browser/terminalInstance.ts"
		);
		expect(instance).toContain(
			"parseInt(computedStyle.paddingTop) + parseInt(computedStyle.paddingBottom)"
		);
	});

	test("patch pads the shared .xterm rule top and bottom", () => {
		const added = addedLines(readRepoFile(`${PATCHES_DIR}/defaults.diff`));
		expect(added).toContain("padding-top: 4px;");
		expect(added).toContain("padding-bottom: 4px;");
	});
});

// The keyboard-open signal the keybar reads (it reserves its row out of the grid
// only while a keyboard is up) is published by shell.js, and is deliberately NOT
// the existing inset var - that one means "overlap the viewport has not already
// excluded" and reads 0 under interactive-widget=resizes-content.
describe("soft-keyboard open signal", () => {
	test("shell.js publishes the keyboard-open signal from a viewport baseline", () => {
		const narrow = readRepoFile(SHELL);

		expect(narrow).toContain("'--composery-touch-keyboard-open'");
		expect(narrow).toContain(
			"keyboardBaselineHeight - height >= KEYBOARD_MIN_INSET"
		);
		// A collapsing URL bar must not read as a keyboard.
		expect(narrow).toContain("const KEYBOARD_MIN_INSET = 120;");
		// Rotation resets the baseline.
		expect(narrow).toContain("if (width !== keyboardBaselineWidth) {");
	});
});

// A terminal is not prose: the on-screen keyboard must offer no dictionary
// suggestions and no autocorrect over shell input. xterm already sets autocorrect,
// autocapitalize and spellcheck off on its helper textarea, but on Android those
// three do not remove the suggestion strip - Chromium maps that strip (and the
// autocorrect it also overrides, via TYPE_TEXT_FLAG_NO_SUGGESTIONS) off only from
// autocomplete="off", which xterm omits. The patch sets it on the terminal's own
// textarea; harmless on desktop, where the attribute drives no soft keyboard.
describe("terminal soft-keyboard suggestions", () => {
	test("the terminal textarea opts out of suggestions and autocorrect", () => {
		const source = addedLines(readRepoFile(`${PATCHES_DIR}/touch.diff`));

		expect(source).toContain(
			"xterm.raw.textarea.setAttribute('autocomplete', 'off')"
		);
	});
});

describe("persistence readiness cache", () => {
	test("uses monotonic elapsed time instead of the adjustable wall clock", () => {
		const source = readRepoFile(
			"packages/ide/overlay/src/node/persistence/readiness.ts"
		);
		expect(source.match(/performance\.now\(\)/g)).toHaveLength(2);
		expect(source).not.toMatch(/(?:cached\.at|at:)\s*Date\.now\(\)/);
	});
});

// Modified upstream files are patches, so quilt at fuzz=0 fails loudly when
// upstream moves under them. Whole files we own are copied over the tree
// instead, which has no such tripwire: if upstream ever ships a file at one of
// our overlay paths, the copy would silently replace it and the loss would look
// exactly like nothing happening. This is that tripwire, and it covers the whole
// overlay - it used to guard lib/vscode/src alone, which is the half where the
// rule was never at risk. The half it missed, src/browser/pages, is the half that
// really does take upstream paths.
describe("the overlay never shadows an upstream file", () => {
	const OVERLAY = "packages/ide/overlay";
	const UPSTREAM = "packages/ide/upstream";

	function filesUnder(dir: string, base = ""): string[] {
		const root = resolve(repoRoot, dir);
		if (!existsSync(root)) return [];
		return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
			const relative = base ? posix.join(base, entry.name) : entry.name;
			return entry.isDirectory()
				? filesUnder(posix.join(dir, entry.name), relative)
				: [relative];
		});
	}

	// Paths the series deletes outright (`+++ /dev/null`). Quilt runs first, so
	// upstream no longer owns these by the time the overlay lands and replacing
	// them wholesale is the intended move - auth.diff removes code-server's login
	// and error pages, and ours arrive here. Read from the patches rather than
	// listed, so the exception cannot outlive the deletion that earns it.
	const deletedByPatch = new Set(
		seriesNames.flatMap((name) =>
			[
				...readRepoFile(`${PATCHES_DIR}/${name}`).matchAll(
					/^--- a\/(\S+)\r?\n\+\+\+ \/dev\/null/gm
				)
			].map((match) => match[1]!)
		)
	);

	test("a patch deletion is what lets an overlay file take an upstream path", () => {
		// The set is the exception list, so an empty one would silently turn the
		// test below into the narrower check it replaced.
		expect(deletedByPatch).toContain("src/browser/pages/login.html");
		expect(deletedByPatch).toContain("src/browser/pages/error.html");
	});

	// The other way an overlay file may take an upstream path, and the only one:
	// upstream's own brand assets, replaced in place. This is what rebranding a
	// binary means - rebrand.mjs owns every rename in the assembled tree, but it
	// rewrites text and cannot repaint an icon, and a deletion patch is not
	// available either, because quilt applies with GNU patch and that cannot take
	// a git binary diff.
	//
	// The four PWA icons are not even a choice: vscode.ts builds the manifest's
	// icon list by interpolating `pwa-icon-${size}.png` and `-maskable-`, so those
	// filenames are upstream's API for our branding. Renaming ours to dodge the
	// collision would ship code-server's icons on the installed app.
	//
	// Pinned as an exact set rather than a `media/**` rule: replacing an asset is
	// intended, replacing code never is, and a wildcard would stop telling the
	// difference the first time a .ts landed there.
	const REPLACED_BRAND_ASSETS = [
		"src/browser/media/favicon.ico",
		"src/browser/media/favicon.svg",
		"src/browser/media/pwa-icon-192.png",
		"src/browser/media/pwa-icon-512.png",
		"src/browser/media/pwa-icon-maskable-192.png",
		"src/browser/media/pwa-icon-maskable-512.png"
	];

	test("every overlaid file is one upstream does not have, or one we knowingly replace", () => {
		const files = filesUnder(OVERLAY);

		// A green run here must mean the check ran, not that the tree was empty.
		expect(files.length).toBeGreaterThan(0);

		const shadowed = files.filter(
			(file) =>
				existsSync(resolve(repoRoot, UPSTREAM, file)) &&
				!deletedByPatch.has(file)
		);

		// Equality, not a subset: an entry that stops shadowing anything is a
		// stale exception granting cover it no longer needs, and would hide the
		// next real collision at that path.
		expect(shadowed.sort()).toEqual([...REPLACED_BRAND_ASSETS].sort());
	});

	test("nothing we knowingly replace is code", () => {
		// The exception exists because a binary cannot be patched or deleted. A
		// text file has both routes open, so it never qualifies.
		for (const asset of REPLACED_BRAND_ASSETS) {
			expect(asset, `${asset} could be a patch`).toMatch(
				/\.(png|ico|svg|woff2?)$/
			);
		}
	});

	test("the build installs the overlay in one unconditional mirror", () => {
		// An overlay file nothing installs is a documented no-op: it would read as
		// shipped while never reaching the build. One mirror of the whole tree is
		// what makes that unrepresentable rather than merely checked - a
		// per-subtree enumeration would silently skip whatever it forgot to name.
		expect(readRepoFile("packages/ide/scripts/build.sh")).toContain(
			'cp -r "$PACKAGE_ROOT/overlay/." "$BUILD/"'
		);
	});

	test("nothing is copied into the built tree after the build", () => {
		// The overlay has no timing dimension, and that is load-bearing: it is why
		// an overlay path needs no phase attached to it and why AGENTS.md has no
		// rule to state. Getting our files into the release is upstream's copy
		// lists (release-contents.diff), never a step here reaching into $BUILD's
		// output - a copy that landed at the wrong moment would be undone by the
		// build with nothing failing.
		const build = readRepoFile("packages/ide/scripts/build.sh");
		const afterBuild = build.slice(build.indexOf("npm run release"));
		expect(afterBuild).not.toMatch(/^\s*(cp|rsync|install)\s/m);
	});

	test("every workbench asset is one the page loads", () => {
		// An asset nobody references is dead weight that still ships, and this is
		// the only subtree whose files reach the browser without a module import
		// to make an unused one obvious.
		const page = addedLines(readRepoFile(`${PATCHES_DIR}/workbench-page.diff`));
		const fonts = readRepoFile(`${ASSETS}/fonts.css`);
		const assets = readdirSync(resolve(repoRoot, ASSETS));

		expect(assets.length).toBeGreaterThan(0);
		for (const asset of assets) {
			expect(
				page.includes(asset) || fonts.includes(asset),
				`${asset} is shipped but nothing loads it`
			).toBe(true);
		}
	});
});

// The installed PWA is the mobile product, so the
// values that decide how it looks on a home screen are worth pinning: they live
// in an upstream file none of us reads by accident, and a wrong one is only
// visible after installing the app.
describe("PWA install metadata", () => {
	const patch = readRepoFile(`${PATCHES_DIR}/workbench-page.diff`);
	const added = addedLines(patch);
	const removed = patch
		.split(/\r?\n/)
		.filter((line) => line.startsWith("-") && !line.startsWith("---"))
		.join("\n");

	const background = (file: string): string =>
		(
			JSON.parse(
				readRepoFile(
					`packages/ide/overlay/lib/vscode/extensions/composery-themes/themes/${file}`
				)
			) as { colors: Record<string, string> }
		).colors["editor.background"]!;

	const chrome = (file: string): string =>
		(
			JSON.parse(
				readRepoFile(
					`packages/ide/overlay/lib/vscode/extensions/composery-themes/themes/${file}`
				)
			) as { colors: Record<string, string> }
		).colors["titleBar.activeBackground"]!;

	test("installs as a standalone window, not fullscreen", () => {
		expect(added).toContain('display: "standalone"');
		// Fullscreen hides the clock and battery; window-controls-overlay would
		// put the OS controls over a titlebar that reserves no room for them.
		expect(removed).toContain('display: "fullscreen"');
		expect(removed).toContain("display_override:");
		// The key, not the word: the patch's own comment explains the removal.
		expect(added).not.toContain("display_override:");
	});

	test("names the app what shared names it", () => {
		const brandName = /BRAND_NAME = "([^"]+)"/.exec(
			readRepoFile("packages/shared/index.ts")
		)?.[1];
		expect(brandName).toEqual(expect.any(String));

		// iOS writes this under the home-screen icon in preference to the
		// manifest's short_name, so it is the name most phones actually show.
		expect(added).toContain(
			`<meta name="apple-mobile-web-app-title" content="${brandName}">`
		);
		expect(removed).toContain('content="Code"');
	});

	test("describes the app the way the website does", () => {
		const description = /APP_DESCRIPTION =\s*"([^"]+)"/.exec(
			readRepoFile("packages/shared/index.ts")
		)?.[1];
		expect(description).toEqual(expect.any(String));
		expect(added).toContain(`"${description}"`);
	});

	test("splash and status bar are the theme backgrounds", () => {
		const darkChrome = chrome("composery-dark.json");
		const lightChrome = chrome("composery-light.json");
		const darkEditor = background("composery-dark.json");

		// The manifest carries one dark scheme, so the browser chrome and the
		// splash behind the launcher icon both take the dark surfaces; the
		// per-scheme metas then track the scheme the workbench starts in.
		expect(added).toContain(`theme_color: "${darkChrome}"`);
		expect(added).toContain(`background_color: "${darkEditor}"`);
		expect(added).toContain(
			`<meta name="theme-color" content="${darkChrome}" media="(prefers-color-scheme: dark)" />`
		);
		expect(added).toContain(
			`<meta name="theme-color" content="${lightChrome}" media="(prefers-color-scheme: light)" />`
		);
	});

	// The first-paint style sits directly beside those metas and is the colour a
	// cold load actually shows, but nothing tied it to the themes: it could drift
	// to a background the workbench then repaints a moment later, which reads as a
	// flash and is only visible on a slow connection.
	test("the pre-theme first paint is the theme background", () => {
		const dark = background("composery-dark.json");
		const light = background("composery-light.json");
		const firstPaint = /<style>([\s\S]*?)<\/style>/.exec(added)?.[1];
		expect(firstPaint).toEqual(expect.any(String));

		const colours = [
			...firstPaint!.matchAll(/background-color:\s*(#\w+)/g)
		].map((match) => match[1]);
		expect(colours.length).toBeGreaterThan(0);
		expect([...new Set(colours)].sort()).toEqual([light, dark].sort());
	});
});

// ---------------------------------------------------------------------------
// API terminals: the API creates ordinary persistent VS Code terminals through
// the pty host, so they show up in the editor like any other. The contracts
// below span the patch and the code-server-side routes, which compile
// separately and so cannot share a symbol.
// ---------------------------------------------------------------------------

describe("api terminals", () => {
	const patch = readRepoFile(`${PATCHES_DIR}/api.diff`);
	const terminals = readRepoFile(
		"packages/ide/overlay/src/node/routes/api/terminals.ts"
	);
	test("the workspace sentinel is identical on both sides", () => {
		// A terminal created outside any editor window carries this instead of a
		// real workspace id. If the two copies drift, the pty host stops matching
		// API terminals into any window's layout and they silently never appear.
		const inPatch = /API_TERMINAL_WORKSPACE_ID = '([^']+)'/.exec(
			addedLines(patch)
		);
		const inRoutes = /API_TERMINAL_WORKSPACE_ID = "([^"]+)"/.exec(terminals);
		expect(inPatch?.[1]).toBeDefined();
		expect(inRoutes?.[1]).toBe(inPatch?.[1]);
	});

	test("the API terminal env matches what an editor terminal is given", () => {
		// addTerminalEnvironmentKeys lives in the workbench bundle, which this
		// server cannot import, so terminals.ts sets the keys itself. Read the real
		// upstream function and require the same ones, or an API terminal quietly
		// renders differently from the identical terminal opened with `+`.
		const upstream = readRepoFile(
			"packages/ide/upstream/lib/vscode/src/vs/workbench/contrib/terminal/common/terminalEnvironment.ts"
		);
		const body = upstream.slice(
			upstream.indexOf("export function addTerminalEnvironmentKeys")
		);
		const keys = [
			...body.slice(0, body.indexOf("\n}")).matchAll(/env\['(\w+)'\]/g)
		]
			.map((match) => match[1])
			// TERM_PROGRAM_VERSION and LANG need the product version and the client
			// locale; neither reaches this server, and both are absent on purpose.
			.filter((key) => key !== "TERM_PROGRAM_VERSION" && key !== "LANG");
		expect(keys.length).toBeGreaterThan(0);
		for (const key of keys) {
			expect(terminals, `terminals.ts is missing ${key}`).toContain(key);
		}
	});

	test("a deliberately detached terminal is not synced back", () => {
		// terminal-sync merges every persistent process for a workspace into each
		// client's layout. Detach Session works by scheduling the disconnect
		// runners - there is no detached flag - so without this guard the next
		// layout request re-adopts the terminal and a client attaching cancels the
		// disconnect, silently undoing the detach.
		const added = addedLines(patch);
		expect(added).toContain("process.isDetaching");
		expect(added).toMatch(
			/get isDetaching\(\).*_disconnectRunner1\.isScheduled\(\) \|\| this\._disconnectRunner2\.isScheduled\(\)/
		);
	});

	test("the pty host is reached through the server API, not rebuilt", () => {
		// The point of the patch: one field exposing VS Code's own pty host. If
		// terminals.ts ever spawns its own pty again it is a parallel terminal
		// implementation, which is what this whole thing exists to avoid.
		expect(addedLines(patch)).toContain("readonly ptyService: IPtyService");
		expect(terminals).toContain("createProcess(");
		expect(terminals).not.toContain("node-pty");
		expect(terminals).not.toContain("child_process");
		expect(terminals).not.toContain("spawn(");
	});

	test("API terminals announce themselves to live editor clients", () => {
		const added = addedLines(patch);
		expect(added).toContain(
			"this._register(this._ptyHostService.onProcessReady"
		);
		expect(added).toContain("this._ptyHostService.listProcesses(true)");
		expect(added).toContain(
			"this._onPersistentTerminalInventoryChange.fire({ workspaceId: process.workspaceId })"
		);
	});

	test("every API attachment is its own terminal client", () => {
		// Two attachments sharing a client id would share one registry slot, so
		// either one finishing would strip the other's flow control and viewport,
		// and the pty would then pause on bytes nobody is left to acknowledge.
		const ids = [...terminals.matchAll(/clientId = `([^`$]+)\$\{/g)].map(
			(match) => match[1]
		);
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
		for (const id of ids) expect(id).toMatch(/^api-/);
		expect(terminals).toContain("crypto.randomUUID()");
		// One registration covers the viewport and the flow control, so neither
		// can outlive the other, and one unregistration releases both.
		expect(
			// "register" also matches inside "unregister" - anchor it.
			terminals.match(/(?<!un)registerTerminalClient\(id, clientId\)/g)
		).toHaveLength(2);
		expect(
			terminals.match(/unregisterTerminalClient\(id, clientId\)/g)
		).toHaveLength(3);
		expect(terminals).not.toContain("registerDataConsumer");
	});

	test("the orphan check keeps upstream's default and its own polarity", () => {
		// terminal-sharing.diff's fourth `_buildProcessDetails` argument is `checkOrphan`,
		// where true means run the check - and that check asks every renderer and
		// waits on a 4s barrier for an answer. A pass-through named for the
		// opposite meaning inverts both callers at once: the editor quietly loses
		// a check it had, and the API pays four seconds for one it never wanted.
		const added = addedLines(patch);
		expect(added).toContain(
			"async serializeTerminalState(ids: number[], checkOrphan: boolean = true)"
		);
		expect(added).not.toMatch(/skipOrphan/i);
		expect(terminals).toContain("serializeTerminalState([id], false)");
	});

	test("websocket attach subscribes to replay before asking the pty to emit it", () => {
		const route = terminals.slice(
			terminals.indexOf("wsRouter.ws(`${apiBasePath}/terminals/:id`")
		);
		const replay = route.indexOf("pty.onProcessReplay");
		const start = route.indexOf("pty.start(id)");
		expect(replay).toBeGreaterThan(-1);
		expect(start).toBeGreaterThan(replay);
		expect(route).toContain(
			"for (const replay of event.events) send(replay.data, false)"
		);
	});
});

// Our first-run layout defaults are the one place a "good default" can quietly
// become something the user cannot undo, because they are expressed against
// upstream's own persisted state rather than a setting they can see. Both of
// these guard the mechanism, not the taste: which containers we start with is
// free to change, how the choice is stored is not.
describe("default layout", () => {
	const compositeBarRel =
		"lib/vscode/src/vs/workbench/browser/parts/paneCompositeBar.ts";

	const patchedCompositeBar = (): string => {
		const shadow = mkdtempSync(resolve(tmpdir(), "composery-layout-"));
		try {
			const dst = resolve(shadow, compositeBarRel);
			mkdirSync(posix.dirname(dst.replaceAll("\\", "/")), { recursive: true });
			copyFileSync(
				resolve(repoRoot, "packages/ide/upstream", compositeBarRel),
				dst
			);
			const section = readRepoFile(`${PATCHES_DIR}/defaults.diff`)
				.split(/^(?=--- a\/)/m)
				.filter((part) => part.startsWith(`--- a/${compositeBarRel}`))
				.join("");
			expect(section).not.toBe("");
			const sectionFile = resolve(shadow, "composite-bar-section.diff");
			writeFileSync(sectionFile, section);
			applyPatch(sectionFile, shadow);
			return readFileSync(dst, "utf8").replaceAll("\r\n", "\n");
		} finally {
			rmSync(shadow, { recursive: true, force: true });
		}
	};

	// A container is on its bar when it is PINNED - that is the state the bar's
	// own context menu toggles and the only one persisted profile-wide. Deciding
	// this anywhere else re-runs the id list against state the user has since
	// changed: keying off `visible` instead re-hid the container on every reload
	// (it is workspace-scoped and re-derived from shouldBeHidden), and deciding
	// it in shouldBeHidden re-hid it mid-session on any view-descriptor change.
	// So: consulted exactly once, at the one call site that knows the container
	// is new to this profile.
	test("default-hidden containers are decided once, by not pinning", () => {
		const patched = patchedCompositeBar();
		const uses = patched.split("COMPOSERY_DEFAULT_HIDDEN_CONTAINER_IDS");

		// One declaration, one read - a second read is a second chance to
		// override a choice the user has already made.
		expect(uses).toHaveLength(3);
		expect(uses[1]).toContain("new Set<string>(");
		expect(patched).toContain(
			"if (!cachedViewContainer && !COMPOSERY_DEFAULT_HIDDEN_CONTAINER_IDS.has(viewContainer.id)) {\n\t\t\t\tthis.compositeBar.pin(viewContainer.id);"
		);

		// Hiding by any other mechanism does not survive a reload.
		expect(patched).not.toContain(
			"COMPOSERY_DEFAULT_HIDDEN_CONTAINER_IDS.has(viewContainerId)"
		);
	});

	// Where a container lives is a layout opinion, not a default: unlike pinned
	// state there is no UI that reads as "put this back", and it was seeded into
	// per-browser storage, so the same Composery looked different on a second device.
	test("no patch seeds view container locations", () => {
		for (const patch of readdirSync(resolve(repoRoot, PATCHES_DIR))) {
			if (!patch.endsWith(".diff")) continue;
			expect(
				addedLines(readRepoFile(`${PATCHES_DIR}/${patch}`)),
				patch
			).not.toContain("viewContainerLocations");
		}
	});
});

// The welcome grid and the builtin extension hold the same agent list twice, and
// they cannot share one: the grid is workbench source assembled by the patch
// stack, the list is an extension the workbench loads at runtime, and the two
// trees compile apart. Nor can the copies check each other at runtime - a card
// whose id the extension does not know silently falls through to the generic
// picker, which looks like a working button. So pin them here, plus the two
// things that only look right until somebody counts: the icon set on disk and
// the number the "More agents" card advertises.
describe("welcome agent cards", () => {
	const AGENT_MEDIA = "packages/ide/overlay/src/browser/media/agents";
	const EXTENSION =
		"packages/ide/overlay/lib/vscode/extensions/composery-agents/extension.js";

	// Every entry of the extension's AGENTS array, in declaration order.
	const agents = [
		...readRepoFile(EXTENSION).matchAll(/\n\t\{(?<body>[\s\S]*?)\n\t\}/g)
	].map((entry) => {
		// Drop the nested `extension: { ... }` first: it carries an id and a name
		// of its own, which are the VS Code extension's, not the agent's.
		const body = (entry.groups?.body ?? "").replace(/\{[^}]*\}/g, "");
		const field = (key: string) =>
			new RegExp(`${key}: "([^"]+)"`).exec(body)?.[1];
		return {
			id: field("id"),
			name: field("name"),
			owner: field("owner"),
			additional: body.includes("additional: true")
		};
	});
	const featured = agents.filter((agent) => !agent.additional);
	const additional = agents.filter((agent) => agent.additional);

	// Every card the welcome grid builds, in display order.
	const cards = [
		...addedLines(readRepoFile(`${PATCHES_DIR}/defaults.diff`)).matchAll(
			/\{ id: '(?<id>[^']+)', name: '(?<name>[^']+)', tagline: '(?<tagline>[^']+)' \}/g
		)
	].map((card) => card.groups!);

	// Both sides parsed something, so a regex that stops matching fails here
	// rather than passing every comparison below on two empty lists.
	test("both agent lists are readable", () => {
		expect(featured.length).toBeGreaterThan(0);
		expect(additional.length).toBeGreaterThan(0);
		expect(cards.length).toBe(featured.length);
	});

	test("a card exists for each featured agent, and for nothing else", () => {
		expect(cards.map((card) => card.id)).toEqual(
			featured.map((agent) => agent.id)
		);
		expect(cards.map((card) => [card.name, card.tagline])).toEqual(
			featured.map((agent) => [agent.name, agent.owner])
		);
	});

	// A card tints its logo through a CSS mask, so a missing file paints
	// nothing at all rather than a broken image.
	test("the shipped logos are exactly the featured agents", () => {
		const icons = readdirSync(resolve(repoRoot, AGENT_MEDIA)).filter((name) =>
			name.endsWith(".svg")
		);

		expect(icons.sort()).toEqual(
			featured.map((agent) => `${agent.id}.svg`).sort()
		);

		// Each logo is a third party's mark, kept only under the attribution the
		// NOTICE carries; a file it does not name ships without one.
		const notice = readRepoFile(`${AGENT_MEDIA}/NOTICE`);
		for (const icon of icons) expect(notice).toContain(icon);
		for (const named of notice.match(/[\w-]+\.svg/g) ?? []) {
			expect(icons).toContain(named);
		}
	});

	test("the More agents card counts the agents it opens", () => {
		expect(addedLines(readRepoFile(`${PATCHES_DIR}/defaults.diff`))).toContain(
			`'Browse ${additional.length} more choices'`
		);
	});
});
