import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import {
	existsSync,
	lstatSync,
	readFileSync,
	readlinkSync,
	writeFileSync
} from "node:fs";
import { dirname, matchesGlob, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const HEADER = `/*
Ruling:
- This file lists every lexical unit found in Git-owned or untracked,
  non-Git-ignored filenames and covered text contents.
- The scanner does not cover this file's own contents, contents matched by
  .whitelistignore, contents that are not valid UTF-8, contents with U+0000-
  U+0008, U+000B, U+000C, U+000E-U+001F, or U+007F, or contents inside Git
  submodules. Filenames and symbolic-link targets remain covered.
- Standard 3, 4, 6, and 8 digit CSS hexadecimal colors are accepted by syntax
  and do not appear in this list. So are content-addressed digests: a run of
  exactly 40, 64, or 128 lowercase hexadecimal digits, which is what a pinned
  Git commit, image digest, or integrity hash is. Both are computed, not
  written, so their fragments are not words this repository keeps.
- Digits are exact units. Other visible text is evaluated as Unicode grapheme
  clusters. Identifiers split at letter-number, lower-upper, and acronym-word
  boundaries. Lowercase, Titlecase, and UPPERCASE ASCII forms share one lowercase
  entry. An existing irregular complete unit wins before splitting and is exact.
- Every entry is a word this repository keeps. The list must not grow to make a
  check pass. Read the flagged unit and change the source: a typo, an accidental
  name, or a word this list already has. "pnpm fix:whitelist" prunes and sorts
  but refuses new entries; "--write --accept-new" is the deliberate exception.
*/
`;
const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });
const LETTER = /^\p{L}$/u;
const LOWER = /^\p{Lowercase_Letter}$/u;
const UPPER = /^\p{Uppercase_Letter}$/u;
const NUMBER = /^\p{N}$/u;
const ASCII_LETTERS = /^[A-Za-z]+$/;
const ASCII_LOWER = /^[a-z]+$/;
const ASCII_UPPER = /^[A-Z]+$/;
const ASCII_TITLE = /^[A-Z][a-z]*$/;
const CSS_COLOR_AT_START =
	/^#(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{3})(?![0-9A-Fa-f])/;
// A content-addressed digest - a Git object name, an image digest, an integrity
// hash - is a number the machine computed, not a word anybody wrote. Splitting
// one yields fragments like "ddec" and "fdef", and every pinned digest in the
// repository was adding a handful. That is the failure this list is meant
// to prevent, arriving through the list itself: each digest bump adds new
// nonsense units and orphans the ones it replaced, so the only way to keep the
// check passing is to keep growing the vocabulary until it says nothing. The
// lengths are exactly the three the repository pins - SHA-1, SHA-256, SHA-512 -
// and a run one character longer or shorter is still read as a word, because
// then it is not a digest and the question about the source is a real one.
const DIGEST_AT_START =
	/^(?:[0-9a-f]{128}|[0-9a-f]{64}|[0-9a-f]{40})(?![0-9a-f])/;

function compare(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

function flatten(entries) {
	return entries.flatMap((entry) => (Array.isArray(entry) ? entry : [entry]));
}

function codePointType(character) {
	if (NUMBER.test(character)) return "number";
	if (LOWER.test(character)) return "lower";
	if (UPPER.test(character)) return "upper";
	return "letter";
}

function splitRun(value, exact) {
	if (exact.has(value)) return [value];
	const characters = [...value];
	if (characters.every((character) => NUMBER.test(character)))
		return characters;

	const parts = [];
	let start = 0;
	for (let index = 1; index < characters.length; index++) {
		const previous = codePointType(characters[index - 1]);
		const current = codePointType(characters[index]);
		const next = characters[index + 1]
			? codePointType(characters[index + 1])
			: undefined;
		if (
			(previous === "number") !== (current === "number") ||
			(previous === "lower" && current === "upper") ||
			(previous === "upper" && current === "upper" && next === "lower")
		) {
			parts.push(characters.slice(start, index).join(""));
			start = index;
		}
	}
	parts.push(characters.slice(start).join(""));
	return parts.flatMap((part) =>
		[...part].every((character) => NUMBER.test(character)) ? [...part] : [part]
	);
}

function lexicalUnits(value, exact) {
	const segments = [...GRAPHEMES.segment(value)];
	const result = [];
	for (let cursor = 0; cursor < segments.length;) {
		const segment = segments[cursor];
		const rest = value.slice(segment.index);
		const skipped =
			rest.match(CSS_COLOR_AT_START)?.[0] ?? rest.match(DIGEST_AT_START)?.[0];
		if (skipped) {
			const end = segment.index + skipped.length;
			do cursor++;
			while (cursor < segments.length && segments[cursor].index < end);
			continue;
		}

		if (LETTER.test(segment.segment) || NUMBER.test(segment.segment)) {
			const start = segment.index;
			let run = "";
			do {
				run += segments[cursor].segment;
				cursor++;
			} while (
				cursor < segments.length &&
				(LETTER.test(segments[cursor].segment) ||
					NUMBER.test(segments[cursor].segment))
			);
			let offset = 0;
			for (const part of splitRun(run, exact)) {
				result.push({ value: part, index: start + offset });
				offset += part.length;
			}
			continue;
		}

		result.push({ value: segment.segment, index: segment.index });
		cursor++;
	}
	return result;
}

function decodeText(contents) {
	try {
		const value = new TextDecoder("utf-8", { fatal: true }).decode(contents);
		const hasNonTextControl = [...value].some((character) => {
			const code = character.codePointAt(0);
			return (
				code <= 8 ||
				code === 11 ||
				code === 12 ||
				(code >= 14 && code <= 31) ||
				code === 127
			);
		});
		return hasNonTextControl ? undefined : value;
	} catch {
		return undefined;
	}
}

function casingDefinition(value) {
	if (
		ASCII_LETTERS.test(value) &&
		(ASCII_LOWER.test(value) ||
			ASCII_UPPER.test(value) ||
			ASCII_TITLE.test(value))
	) {
		return value.toLowerCase();
	}
	return value;
}

function definitions(values) {
	return [...new Set([...values].map(casingDefinition))].sort(compare);
}

function validate(entries) {
	if (!Array.isArray(entries))
		return ["whitelist.jsonc must contain one array"];
	const errors = [];
	const seen = new Set();
	for (const [index, entry] of entries.entries()) {
		if (typeof entry !== "string" || entry.length === 0) {
			errors.push(
				`whitelist.jsonc entry ${index + 1} is not a nonempty string`
			);
			continue;
		}
		const canonical = casingDefinition(entry);
		if (canonical !== entry) {
			errors.push(
				`whitelist.jsonc entry ${index + 1} uses regular ASCII casing; use ${JSON.stringify(canonical)}`
			);
		}
		if (seen.has(entry))
			errors.push(
				`whitelist.jsonc contains duplicate entry ${JSON.stringify(entry)}`
			);
		seen.add(entry);
	}
	return errors;
}

function parseIgnore(value) {
	const patterns = [];
	for (const [index, raw] of value.split(/\r?\n/u).entries()) {
		const pattern = raw.trim();
		if (!pattern || pattern.startsWith("#")) continue;
		if (
			pattern.startsWith("!") ||
			pattern.startsWith("/") ||
			pattern.endsWith("/")
		) {
			throw new Error(
				`.whitelistignore:${index + 1} must be a positive repository-relative file glob`
			);
		}
		if (patterns.includes(pattern))
			throw new Error(
				`.whitelistignore:${index + 1} duplicates ${JSON.stringify(pattern)}`
			);
		patterns.push(pattern);
	}
	return patterns;
}

function ignored(path, patterns, matched) {
	let result = false;
	for (const pattern of patterns) {
		if (matchesGlob(path, pattern)) {
			matched.add(pattern);
			result = true;
		}
	}
	return result;
}

function location(path, value, index, filename = false) {
	if (filename) return { path, line: 1, column: 1, filename: true };
	const before = value.slice(0, index);
	const lastNewline = before.lastIndexOf("\n");
	return {
		path,
		line: before.split("\n").length,
		column: before.length - lastNewline
	};
}

function record(occurrences, unit, item) {
	const files = occurrences.get(unit) ?? new Map();
	if (!files.has(item.path)) files.set(item.path, item);
	occurrences.set(unit, files);
}

function scanWhitelist({
	sources,
	existing = [],
	patterns = [],
	collectUnknownLocations = false
}) {
	const exact = new Set(Array.isArray(existing) ? flatten(existing) : []);
	const accepted = new Set(definitions(exact));
	const found = new Set();
	const occurrences = new Map();
	const matchedPatterns = new Set();
	for (const source of [...sources].sort((left, right) =>
		compare(left.path, right.path)
	)) {
		for (const unit of lexicalUnits(source.path, exact)) {
			const definition = casingDefinition(unit.value);
			found.add(definition);
			if (collectUnknownLocations && !accepted.has(definition)) {
				record(occurrences, definition, {
					path: source.path,
					index: unit.index,
					filename: true
				});
			}
		}
		if (source.gitlink || source.path === "whitelist.jsonc") continue;
		const skip = ignored(source.path, patterns, matchedPatterns);
		if (skip) continue;
		const text = decodeText(source.contents);
		if (text === undefined) continue;
		for (const unit of lexicalUnits(text, exact)) {
			const definition = casingDefinition(unit.value);
			found.add(definition);
			if (collectUnknownLocations && !accepted.has(definition)) {
				record(occurrences, definition, {
					path: source.path,
					value: text,
					index: unit.index,
					filename: false
				});
			}
		}
	}
	const stalePatterns = patterns.filter(
		(pattern) => !matchedPatterns.has(pattern)
	);
	if (stalePatterns.length > 0) {
		throw new Error(
			`.whitelistignore patterns match no files: ${stalePatterns.map(JSON.stringify).join(", ")}`
		);
	}
	return { entries: definitions(found), occurrences };
}

export function createWhitelist(input) {
	return scanWhitelist(input).entries;
}

function canonical(entries) {
	return `${HEADER}${JSON.stringify(entries, null, "\t")}\n`;
}

function changedEntries(expected, actual) {
	const expectedUnits = new Set(flatten(expected));
	const actualUnits = new Set(flatten(actual));
	const additions = [...actualUnits]
		.filter((unit) => !expectedUnits.has(unit))
		.sort(compare);
	const removals = [...expectedUnits]
		.filter((unit) => !actualUnits.has(unit))
		.sort(compare);
	return { additions, removals };
}

function footer(hasAdditions) {
	if (!hasAdditions)
		return ["Accept the removals with:", "  pnpm fix:whitelist"];
	return [
		"Every new entry is a word this repository keeps. Change the source first:",
		"correct the typo or the name, or use a word the list already has.",
		"Only a word that carries a meaning no listed word carries is accepted with:",
		"  node scripts/whitelist.mjs --write --accept-new"
	];
}

function difference(expected, actual, occurrences) {
	const { additions, removals } = changedEntries(expected, actual);
	const lines = ["whitelist.jsonc is out of date."];
	const addSection = (title, values, showLocations = false) => {
		if (values.length === 0) return;
		lines.push("", `${title} (${values.length}):`);
		for (const value of values.slice(0, 25)) {
			lines.push(`  ${JSON.stringify(value)}`);
			if (!showLocations) continue;
			const files = [...(occurrences.get(value)?.values() ?? [])];
			for (const item of files.slice(0, 5)) {
				const found = location(
					item.path,
					item.value ?? item.path,
					item.index,
					item.filename
				);
				lines.push(
					`    ${found.path}:${found.line}:${found.column}${found.filename ? " (filename)" : ""}`
				);
			}
			if (files.length > 5)
				lines.push(`    ... and ${files.length - 5} more files`);
		}
		if (values.length > 25) lines.push(`  ... and ${values.length - 25} more`);
	};
	addSection("New entries", additions, true);
	addSection("Removed entries", removals);
	if (additions.length === 0 && removals.length === 0) {
		lines.push("", "Entries are not in canonical order or format.");
	}
	lines.push("", ...footer(additions.length > 0));
	return lines;
}

export function checkWhitelist({ entries, sources, patterns = [] }) {
	const errors = validate(entries);
	if (errors.length > 0) return errors;
	let scan;
	try {
		scan = scanWhitelist({
			sources,
			existing: entries,
			patterns,
			collectUnknownLocations: true
		});
	} catch (error) {
		return [error.message];
	}
	return canonical(entries) === canonical(scan.entries)
		? []
		: difference(entries, scan.entries, scan.occurrences);
}

function gitOutput(root, arguments_) {
	return new TextDecoder("utf-8", { fatal: true }).decode(
		execFileSync("git", arguments_, {
			cwd: root,
			encoding: "buffer",
			maxBuffer: 64 * 1024 * 1024
		})
	);
}

function repositorySources(root, patterns) {
	const staged = new Map();
	for (const record of gitOutput(root, ["ls-files", "--stage", "-z"]).split(
		"\0"
	)) {
		if (!record) continue;
		const match = /^(\d+) ([0-9a-f]{40,64}) (\d)\t([\s\S]+)$/.exec(record);
		if (!match || match[3] !== "0")
			throw new Error(
				`cannot scan unresolved Git index record ${JSON.stringify(record)}`
			);
		staged.set(match[4], { mode: match[1], oid: match[2] });
	}
	const paths = gitOutput(root, [
		"ls-files",
		"--cached",
		"--others",
		"--exclude-standard",
		"-z"
	])
		.split("\0")
		.filter(Boolean)
		.sort(compare);
	const sources = [];
	for (const path of paths) {
		const absolute = resolve(root, ...path.split("/"));
		const index = staged.get(path);
		if (index?.mode === "160000") {
			sources.push({ path, gitlink: index.oid });
			continue;
		}
		if (!existsSync(absolute)) continue;
		if (
			path === "whitelist.jsonc" ||
			patterns.some((pattern) => matchesGlob(path, pattern))
		) {
			sources.push({ path, contents: Buffer.alloc(0) });
			continue;
		}
		const status = lstatSync(absolute);
		if (status.isSymbolicLink())
			sources.push({ path, contents: Buffer.from(readlinkSync(absolute)) });
		else if (status.isFile())
			sources.push({ path, contents: readFileSync(absolute) });
	}
	return sources;
}

function repositoryInput(root) {
	const ignorePath = resolve(root, ".whitelistignore");
	const patterns = existsSync(ignorePath)
		? parseIgnore(readFileSync(ignorePath, "utf8"))
		: [];
	return { sources: repositorySources(root, patterns), patterns };
}

function parseWhitelist(source, requireCurrentRuling = true) {
	if (requireCurrentRuling && !source.startsWith(HEADER))
		throw new Error("required ruling comment is missing or changed");
	const commentEnd = source.indexOf("*/");
	if (commentEnd < 0) throw new Error("ruling comment is not closed");
	return JSON.parse(source.slice(commentEnd + 2));
}

function readWhitelist(path) {
	return parseWhitelist(readFileSync(path, "utf8"));
}

export function checkRepository(root) {
	let entries;
	try {
		entries = readWhitelist(resolve(root, "whitelist.jsonc"));
	} catch (error) {
		return [`whitelist.jsonc cannot be read: ${error.message}`];
	}
	try {
		return checkWhitelist({ entries, ...repositoryInput(root) });
	} catch (error) {
		return [`repository cannot be scanned: ${error.message}`];
	}
}

export function writeRepositoryWhitelist(root, { acceptNew = false } = {}) {
	const path = resolve(root, "whitelist.jsonc");
	let existing = [];
	let source;
	try {
		source = readFileSync(path, "utf8");
		try {
			existing = parseWhitelist(source);
		} catch {
			existing = parseWhitelist(source, false);
		}
	} catch {
		// The dump covers its own filename, so the file has to exist before the scan.
		source = canonical([]);
		writeFileSync(path, source);
	}
	const actual = createWhitelist({ ...repositoryInput(root), existing });
	const output = canonical(actual);
	const { additions, removals } = changedEntries(existing, actual);
	const blocked = additions.length > 0 && !acceptNew;
	if (blocked || source === output)
		return { changed: false, blocked, additions, removals };
	writeFileSync(path, output);
	return { changed: true, blocked, additions, removals };
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	if (process.argv.slice(2).includes("--write")) {
		const acceptNew = process.argv.slice(2).includes("--accept-new");
		const result = writeRepositoryWhitelist(repositoryRoot, { acceptNew });
		const print = (title, entries, log) => {
			if (entries.length === 0) return;
			log(`\n${title} (${entries.length}):`);
			for (const entry of entries.slice(0, 25))
				log(`  ${JSON.stringify(entry)}`);
			if (entries.length > 25) log(`  ... and ${entries.length - 25} more`);
		};
		if (result.blocked) {
			console.error("whitelist.jsonc is unchanged.");
			print("New entries", result.additions, console.error);
			console.error(
				`\n${footer(true).join("\n")}\nRun "pnpm check:whitelist" for every location.`
			);
			process.exitCode = 1;
		} else if (!result.changed) {
			console.log("whitelist.jsonc is already current.");
		} else {
			console.log("Updated whitelist.jsonc.");
			print("Added entries", result.additions, console.log);
			print("Pruned unused entries", result.removals, console.log);
		}
	} else {
		const diagnostics = checkRepository(repositoryRoot);
		if (diagnostics.length === 0) console.log("whitelist.jsonc is current.");
		else {
			console.error(diagnostics.join("\n"));
			process.exitCode = 1;
		}
	}
}
