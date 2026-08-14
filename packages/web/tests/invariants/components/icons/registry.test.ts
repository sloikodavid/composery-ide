import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = join(import.meta.dirname, "../../../..");
const ICONS_DIR = join(ROOT, "components/icons");
const REGISTRY = join(ROOT, "components/animated-icon.tsx");

// Files in ui/icons that are animated glyphs: everything except the
// shared shell, the static brand logos, and this test.
function glyphFiles() {
	return readdirSync(ICONS_DIR).filter(
		(file) =>
			file.endsWith(".tsx") &&
			file !== "create.tsx" &&
			!file.endsWith("-logo.tsx")
	);
}

function registeredNames() {
	const source = readFileSync(REGISTRY, "utf8");
	const map = source.match(/const ICONS = \{([\s\S]*?)\n\};/);
	if (!map) throw new Error("ICONS map not found in ui/animated-icon");
	return [...map[1].matchAll(/^\t"?([\w-]+)"?:/gm)].map((match) => match[1]);
}

function sourceFiles() {
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
			const path = `${dir}/${entry.name}`;
			if (entry.isDirectory()) walk(path);
			else if (/\.tsx?$/.test(entry.name)) found.push(path);
		}
	};
	for (const dir of ["app", "components", "hooks", "lib"]) walk(dir);
	return found;
}

describe("animated icon registry", () => {
	// An icon file nobody registered renders nowhere and reads as live code. This
	// is how `arrow-left` once sat unused behind a deleted showcase page.
	test("registers every glyph in ui/icons", () => {
		const expected = glyphFiles()
			.map((file) => file.replace(/\.tsx$/, ""))
			.sort();
		expect(registeredNames().sort()).toEqual(expected);
	});

	// The registry is the only way in: call sites name an icon, they don't import
	// one. Keeps `CheckIcon` from meaning two different components depending on
	// the import line.
	test("is the only importer of a glyph module", () => {
		const offenders = sourceFiles().filter((file) => {
			if (file.startsWith("components/icons/")) return false;
			if (file === "components/animated-icon.tsx") return false;
			return /"@\/ui\/icons\/(?!.*-logo")[\w-]+"/.test(
				readFileSync(join(ROOT, file), "utf8")
			);
		});
		expect(offenders).toEqual([]);
	});
});
