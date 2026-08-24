import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

import { repoRoot } from "../support/repo.ts";

// A dead link fails silently: it renders as a link, and only a reader clicking
// it finds out. Two audiences read these files and they break differently.
// GitHub resolves `foo.md` against the checkout, so any Markdown in the repo
// can point at any other. The website loads only `docs/` minus `developing/`
// (source.config.ts), rewrites relative `.md` links to routes, and has no file
// to serve for anything outside that set - so a shipped page linking into
// `developing/` or up out of `docs/` is a 404 for every visitor while still
// reading fine on GitHub. Both rules are checked here.

const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"tmp",
	"upstream",
	".next",
	"dist"
]);

const DOCS_DIR = join(repoRoot, "docs");
const SITE_EXCLUDED = join(DOCS_DIR, "developing");

const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const HEADING = /^#{1,6}\s+(.*)$/gm;

function markdownFiles(dir: string): string[] {
	const found: string[] = [];

	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (SKIP_DIRS.has(entry.name)) continue;
		const path = join(dir, entry.name);

		if (entry.isDirectory()) found.push(...markdownFiles(path));
		else if (/\.mdx?$/.test(entry.name)) found.push(path);
	}

	return found;
}

// ponytail: hand-rolled instead of github-slugger, which is a transitive
// fumadocs dependency the root workspace cannot import. Covers the headings
// these docs actually use (words, digits, code spans, punctuation); reach for
// the real slugger if a heading ever needs unicode or duplicate-suffix rules.
function slugify(heading: string): string {
	return heading
		.trim()
		.toLowerCase()
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[`*_]/g, "")
		.replace(/[^\w\s-]/g, "")
		.replace(/\s+/g, "-");
}

function anchorsOf(file: string): Set<string> {
	const text = readFileSync(file, "utf8");
	const anchors = new Set<string>();

	for (const match of text.matchAll(HEADING))
		anchors.add(slugify(match[1] ?? ""));
	for (const match of text.matchAll(/<a\s+id="([^"]+)"/g))
		anchors.add(match[1] ?? "");

	return anchors;
}

function resolveTarget(from: string, path: string): string | null {
	const base = resolve(dirname(from), path);
	const candidates = [
		base,
		`${base}.md`,
		`${base}.mdx`,
		join(base, "index.md"),
		join(base, "index.mdx")
	];

	return (
		candidates.find((c) => existsSync(c) && statSync(c).isFile()) ??
		(existsSync(base) ? base : null)
	);
}

const files = markdownFiles(repoRoot);

describe("docs links", () => {
	test("the repo has Markdown to check", () => {
		expect(files.length).toBeGreaterThan(10);
	});

	test.each(files.map((f) => [relative(repoRoot, f), f]))(
		"%s resolves every relative link it makes",
		(_name, file) => {
			const dead: string[] = [];

			for (const match of readFileSync(file, "utf8").matchAll(MARKDOWN_LINK)) {
				const href = match[1];
				if (!href || /^(?:[a-z]+:|\/\/)/i.test(href)) continue;

				const [path = "", anchor] = href.split("#");
				const target = path ? resolveTarget(file, path) : file;

				if (!target) {
					dead.push(`${href} - no such file`);
					continue;
				}
				if (
					anchor &&
					/\.mdx?$/.test(target) &&
					!anchorsOf(target).has(anchor)
				) {
					dead.push(
						`${href} - no heading "#${anchor}" in ${relative(repoRoot, target)}`
					);
				}
			}

			expect(dead).toEqual([]);
		}
	);

	// Pages the site ships. Anything they link to must ship too.
	const sitePages = files.filter(
		(f) => f.startsWith(DOCS_DIR) && !f.startsWith(SITE_EXCLUDED)
	);

	test.each(sitePages.map((f) => [relative(repoRoot, f), f]))(
		"%s links only to pages the website serves",
		(_name, file) => {
			const offsite: string[] = [];

			for (const match of readFileSync(file, "utf8").matchAll(MARKDOWN_LINK)) {
				const href = match[1];
				if (!href || /^(?:[a-z]+:|\/\/|#)/i.test(href)) continue;

				const target = resolveTarget(file, href.split("#")[0] ?? "");
				if (!target) continue; // the previous test owns this failure

				if (!target.startsWith(DOCS_DIR) || target.startsWith(SITE_EXCLUDED)) {
					offsite.push(`${href} -> ${relative(repoRoot, target)}`);
				}
			}

			expect(offsite).toEqual([]);
		}
	);

	// A page missing from its meta.json still has a URL but no way to reach it.
	test.each(
		files
			.filter((f) => f.startsWith(DOCS_DIR) && !f.startsWith(SITE_EXCLUDED))
			.map((f) => dirname(f))
			.filter((d, i, all) => all.indexOf(d) === i)
			.map((d) => [relative(repoRoot, d) || "docs", d])
	)("%s lists every page it holds in meta.json", (_name, dir) => {
		const meta = join(dir, "meta.json");
		expect(existsSync(meta), `${relative(repoRoot, meta)} is missing`).toBe(
			true
		);

		const { pages } = JSON.parse(readFileSync(meta, "utf8")) as {
			pages: string[];
		};
		const listed = new Set(pages);
		const held = readdirSync(dir, { withFileTypes: true })
			.filter((e) =>
				e.isDirectory()
					? // A folder is one nav entry, and only if the site ships it.
						existsSync(join(dir, e.name, "meta.json")) &&
						!join(dir, e.name).startsWith(SITE_EXCLUDED)
					: /\.mdx?$/.test(e.name)
			)
			// `index` is the folder's own page - the parent lists the folder instead.
			.map((e) => e.name.replace(/\.mdx?$/, ""))
			.filter((page) => page !== "index");

		expect(held.filter((page) => !listed.has(page))).toEqual([]);
	});
});
