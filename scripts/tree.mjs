import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync
} from "node:fs";
import { basename, dirname, join, posix, resolve } from "node:path";
import { setInterval } from "node:timers";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_FILE = "AGENTS.md";
const TREE_START = "<!-- tree:start -->";
const TREE_FINISH = "<!-- tree:finish -->";
const write = process.argv.includes("--write");
const watch = process.argv.includes("--watch");

// The note that says the block below it is generated. It only tells the truth
// inside the markers, so it is also how a second, unmanaged copy of the tree
// gives itself away - see `dropStrayTrees`.
const TREE_NOTE =
	"> Live-updated by `scripts/tree.mjs` when `pnpm dev` or `pnpm dev:tree` is running. Manually update with `pnpm fix:tree`.";

// The index modes this tree can distinguish. Everything else is a plain file.
export const MODES = {
	executable: "100755",
	file: "100644",
	submodule: "160000",
	symlink: "120000"
};

// Include new, non-ignored files before they are staged. A tree check that is
// green before `git add` but turns red after it is not checking the artifact a
// contributor is about to commit. `--stage` carries the mode, which is the only
// thing that tells a symlink, a submodule and a file apart - a path alone says
// they are all the same kind of thing, and an agent reading this listing then
// edits `CLAUDE.md` instead of the `AGENTS.md` it points at.
export const GIT_FILE_ARGS = [
	"ls-files",
	"--cached",
	"--others",
	"--exclude-standard",
	"--stage",
	"-z"
];

// Git's names, verbatim. This used to re-resolve every path against the real
// directory and take the filesystem's spelling, which made the generated file
// depend on the machine that ran it: a committed case-only rename
// (prompts/REFACTOR.md) still had the old name on disk under Windows' and
// macOS' case-insensitive lookup, so `pnpm fix:tree` wrote a name no
// case-sensitive checkout has and CI failed on every commit afterwards. The
// index is what gets pushed, so the index is the only authority here.
//
// That applies to the mode too, so it is read from the index rather than
// lstat'd: a checkout with core.symlinks=false holds a symlink as an ordinary
// file on disk, and the tree would then describe the machine instead of the
// repository. `--stage` prints `<mode> <object> <stage>\t<path>` for indexed
// entries and a bare path for untracked ones, which have no mode to report.
export function gitFiles() {
	return execFileSync("git", GIT_FILE_ARGS, { cwd: REPO_ROOT })
		.toString("utf8")
		.split("\0")
		.filter(Boolean)
		.map((record) => {
			const staged = /^(\d{6}) ([0-9a-f]+) \d+\t([\s\S]*)$/.exec(record);
			return staged
				? { mode: staged[1], object: staged[2], path: staged[3] }
				: { mode: MODES.file, object: "", path: record };
		});
}

// A symlink's blob is its target path, so the tree can name it without touching
// the filesystem. Read per object rather than per entry: the two `CLAUDE.md`
// links are the same blob.
function readBlobs(entries) {
	const objects = entries
		.filter((entry) => entry.mode === MODES.symlink)
		.map((entry) => entry.object);

	return new Map(
		[...new Set(objects)].map((object) => [
			object,
			execFileSync("git", ["cat-file", "blob", object], {
				cwd: REPO_ROOT
			}).toString("utf8")
		])
	);
}

// Where a symlink points, as a path of this tree.
//
// The stored target is relative to the link, so `packages/web/CLAUDE.md ->
// AGENTS.md` names neither the file it points at nor the one at the root - the
// reader has to resolve it and can pick wrong. Resolved against the tree's own
// root there is nothing left to work out, and the target is a line above.
//
// A target the index does not hold is not this repository's to describe: it
// resolves against whatever the checkout happens to sit next to, so printing it
// would state a fact about one machine. It is named as the one thing that is
// true everywhere instead.
export function linkTarget(path, target, paths) {
	const resolved = posix.normalize(posix.join(posix.dirname(path), target));
	const prefix = `${resolved}/`;

	if (paths.has(resolved)) return resolved;
	if (paths.values().some((entry) => entry.startsWith(prefix))) return prefix;
	return "(outside this repository)";
}

// What one line says about itself. `->` and `*` are `ls -F`'s, so nothing here
// needs a legend to be read correctly.
export function entryLabel({ mode, name, target, type }) {
	if (mode === MODES.symlink) return `${name} -> ${target}`;
	if (mode === MODES.submodule) return `${name}/ (submodule)`;
	if (mode === MODES.executable) return `${name}*`;
	return type === "directory" ? `${name}/` : name;
}

// Directories before files, then by name under a pinned locale. localeCompare
// with a default (undefined) locale resolves it from the environment (en-US on
// the author's machine, en-US-POSIX on a LANG=C.UTF-8 CI runner), which sorts
// "_components" vs "[id]" differently and makes the committed tree fail the CI
// check forever. Exported so a test guards the pin.
export function compareEntries(left, right) {
	if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
	return left.name.localeCompare(right.name, "en-US", { sensitivity: "base" });
}

export function renderTree() {
	const root = {
		children: new Map(),
		name: basename(REPO_ROOT),
		type: "directory"
	};

	const files = [
		...gitFiles(),
		{ mode: MODES.file, object: "", path: AGENTS_FILE }
	];
	const blobs = readBlobs(files);
	const paths = new Set(files.map((entry) => entry.path));

	for (const { mode, object, path } of files) {
		const parts = path.split("/").filter(Boolean);
		let current = root;
		for (const [index, name] of parts.entries()) {
			const leaf = index === parts.length - 1;
			// A submodule is a leaf in this index but a directory on disk, and it
			// sorts and prints as one - its contents belong to another repository
			// and are deliberately not listed.
			const type = !leaf || mode === MODES.submodule ? "directory" : "file";
			let next = current.children.get(name);
			if (!next) {
				next = {
					children: new Map(),
					mode: leaf ? mode : MODES.file,
					name,
					target:
						mode === MODES.symlink && leaf
							? linkTarget(path, blobs.get(object), paths)
							: undefined,
					type
				};
				current.children.set(name, next);
			}
			current = next;
		}
	}

	function renderNode(node, depth = 0) {
		const entries = [...node.children.values()].sort(compareEntries);

		if (depth > 0 && entries.length > 80)
			return [`${"  ".repeat(depth)}... (${entries.length} items)`];

		return entries.flatMap((entry) => [
			`${"  ".repeat(depth)}${entryLabel(entry)}`,
			...(entry.children.size ? renderNode(entry, depth + 1) : [])
		]);
	}

	return [
		TREE_START,
		"",
		TREE_NOTE,
		"",
		"```text",
		...renderNode(root),
		"```",
		"",
		TREE_FINISH,
		""
	].join("\n");
}

// Remove any copy of the tree that is not the one between the markers.
//
// A file listing nothing regenerates is worse than no listing: it reads as
// current for exactly as long as nobody checks it, and this file is loaded into
// every agent's context, so a stale copy is handed out as fact. One did exist -
// a second block carrying this same "live-updated" note, naming twenty-one files
// that had been deleted and missing forty-five that had been added - and nothing
// could have caught it, because the check only ever compared the managed block.
// Now a stray copy is rewritten away by `--write` and named by the check.
export function dropStrayTrees(current) {
	const start = current.indexOf(TREE_START);
	const managed = start === -1 ? "" : current.slice(start);
	const before = start === -1 ? current : current.slice(0, start);

	// A note followed by a fenced block, anywhere outside the markers.
	const stray = new RegExp(
		`${TREE_NOTE.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\n+\`\`\`[\\s\\S]*?\\n\`\`\`\\n*`,
		"g"
	);
	return `${before.replace(stray, "")}${managed}`;
}

export function renderAgentsFile(current, tree) {
	const cleaned = dropStrayTrees(current);
	const start = cleaned.indexOf(TREE_START);
	const finish = cleaned.indexOf(TREE_FINISH);

	if (start !== -1 && finish !== -1 && finish > start) {
		const before = cleaned.slice(0, start).trimEnd();
		const after = cleaned.slice(finish + TREE_FINISH.length).trimStart();
		return [before, tree.trimEnd(), after].filter(Boolean).join("\n\n") + "\n";
	}

	return `${cleaned.trimEnd()}\n\n${tree}`;
}

// The file as it is, or nothing if it is between two states.
//
// Everything outside the markers is carried over from this read, so a read that
// arrives early destroys it: another process truncates the file to write it -
// `git checkout`, a rebase, an editor, a rewrite script - the watch tick lands
// in that window, reads nothing, and writes back a file that is only the tree.
// Every convention above the markers is then gone, and the watch reports
// success. A file that exists but reads empty is being written, never authored,
// so the tick leaves it alone and takes the next read instead.
function readAgentsFile() {
	const file = join(REPO_ROOT, AGENTS_FILE);
	if (!existsSync(file)) return "";
	const current = readFileSync(file, "utf8");
	return current.trim() ? current : undefined;
}

function syncTree({ quiet = false } = {}) {
	const file = join(REPO_ROOT, AGENTS_FILE);
	const current = readAgentsFile();
	if (current === undefined) return false;

	const expected = renderAgentsFile(current, renderTree());
	if (current === expected) return false;

	// Write through a rename so no reader ever sees this file empty. A plain
	// write truncates first, and the readers are constant - agents follow the
	// `CLAUDE.md` symlink here, and this watch itself reads before it writes.
	// The staging file goes to `tmp/`, which is ignored: left behind by a crash
	// beside `AGENTS.md` it would be an untracked file, and untracked files are
	// listed, so the tree would name a file that is not part of the repository.
	const staged = join(REPO_ROOT, "tmp", `${AGENTS_FILE}.tmp`);
	mkdirSync(dirname(staged), { recursive: true });
	writeFileSync(staged, expected);
	renameSync(staged, file);
	if (!quiet) console.log(`Updated ${AGENTS_FILE}`);
	return true;
}

// One watch tick, which never ends the watch.
//
// Windows refuses a write while another process holds the file open or memory
// mapped, and this file is read often: ripgrep maps it during a repository
// search, an editor or a scanner opens it, and every agent follows the
// `CLAUDE.md` symlink to it. Node has no errno for that refusal and reports
// `UNKNOWN` (-4094). It is not the same failure every tick - one write in about
// ten was refused when this was measured - and an uncaught one took down the
// whole of `pnpm dev`. The write is not lost: the file still differs from the
// tree, so the next tick writes it. A lock that never clears says so once a
// second rather than silently leaving the listing stale.
//
// Exported so a test can prove a failed write does not end the watch.
export function syncTick() {
	try {
		return syncTree({ quiet: true });
	} catch (error) {
		console.warn(`${AGENTS_FILE} is locked (${error.code}). Retrying.`);
		return false;
	}
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	if (watch) {
		syncTick();
		setInterval(syncTick, 1000);
		process.stdin.resume();
	} else if (write) {
		syncTree();
	} else {
		const actual = readAgentsFile() ?? "";
		const expected = renderAgentsFile(actual, renderTree());

		if (actual !== expected) {
			// Naming the drifting lines is the whole value of this check on a CI
			// runner: "out of date" alone cannot distinguish a forgotten fix:tree
			// from a file that only exists on that machine, and the runner is gone
			// by the time anyone reads it.
			const actualLines = new Set(actual.split("\n"));
			const expectedLines = new Set(expected.split("\n"));
			console.error(
				[
					`${AGENTS_FILE} tree block is out of date. Run 'pnpm fix:tree'.`,
					...expected
						.split("\n")
						.filter((line) => line.trim() && !actualLines.has(line))
						.map((line) => `+${line}`),
					...actual
						.split("\n")
						.filter((line) => line.trim() && !expectedLines.has(line))
						.map((line) => `-${line}`)
				].join("\n")
			);
			process.exitCode = 1;
		}
	}
}
