import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { readRepoFile, repoRoot } from "../support/repo.ts";

// The tagline is the first sentence a reader gets, and it is written down in
// several places. Some of them import it; README.md, docs/index.md and the
// Dockerfile cannot, so shared says of itself that such files "duplicate these values
// by hand". A hand copy nothing checks is a hand copy that drifts - this is the
// check that makes the sentence in shared the one that actually ships.
describe("brand copy", () => {
	const tagline = /APP_TAGLINE =\s*"([^"]+)"/.exec(
		readRepoFile("packages/shared/index.ts")
	)?.[1];

	test("shared declares a tagline to pin the copies to", () => {
		expect(tagline).toEqual(expect.any(String));
	});

	test.each([
		// The README opens on it, under the title.
		["README.md", (copy: string) => copy],
		// Fumadocs frontmatter, which reads as a sentence about the product.
		["docs/index.md", (copy: string) => `Composery is ${lowerFirst(copy)}`],
		// The OCI image description registries show next to the image.
		[
			"Dockerfile",
			(copy: string) => `org.opencontainers.image.description="${copy}"`
		]
	])("%s carries the tagline shared declares", (file, phrase) => {
		expect(readRepoFile(file)).toContain(phrase(tagline!));
	});
});

// The same argument as the tagline above, for the name of the image people
// actually pull. `CONTAINER_IMAGE` in shared says of itself that the files which
// cannot import TS "hardcode this same string - keep in sync", and until this
// test nothing did: the self-hosting templates and the Convex env examples each
// carried their own copy, and a repository or owner rename would have left every
// recipe in the documentation pointing at an image that no longer exists.
//
// This cannot be solved by removing the duplication. A template is an artifact a
// reader copies away whole, and `.env.example.*` is the documented list an
// operator fills in by hand; neither can import a constant. That is what makes a
// test the right answer here rather than the lazy one.
//
// Enumerated from disk, never listed: a hardcoded set of files would itself be a
// copy that drifts, and would silently exempt every template added after it.
describe("published image name", () => {
	const containerImage = /CONTAINER_IMAGE =\s*"([^"]+)"/.exec(
		readRepoFile("packages/shared/index.ts")
	)?.[1];

	// Any ghcr reference of the shape owner/repo. Matching the pattern rather than
	// the expected value is the point: a copy that names the wrong owner or a
	// renamed repository is exactly the drift this catches, and asserting on the
	// right string alone would simply not see it.
	const GHCR_REFERENCE = /ghcr\.io\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/g;

	function infraFiles(): string[] {
		const found: string[] = [];
		const walk = (relative: string) => {
			const absolute = resolve(repoRoot, relative);
			if (statSync(absolute).isDirectory()) {
				for (const entry of readdirSync(absolute).sort()) {
					walk(`${relative}/${entry}`);
				}
				return;
			}
			found.push(relative);
		};
		walk("templates");
		for (const entry of readdirSync(resolve(repoRoot, "packages/web"))) {
			if (entry.startsWith(".env.example."))
				found.push(`packages/web/${entry}`);
		}
		return found;
	}

	test("shared declares an image name to pin the copies to", () => {
		expect(containerImage).toMatch(/^ghcr\.io\/[^:]+$/);
	});

	test("every infrastructure copy names the image shared declares", () => {
		let copies = 0;
		for (const file of infraFiles()) {
			for (const [reference] of readRepoFile(file).matchAll(GHCR_REFERENCE)) {
				copies += 1;
				expect(reference, file).toBe(containerImage);
			}
		}
		// Without this the loop passes vacuously the day the scan stops finding
		// anything - a moved templates directory would read as "all copies agree".
		expect(copies).toBeGreaterThanOrEqual(8);
	});
});

// "A secure cloud..." -> "a secure cloud...", so the docs sentence reads as one.
function lowerFirst(value: string): string {
	return value.charAt(0).toLowerCase() + value.slice(1);
}
