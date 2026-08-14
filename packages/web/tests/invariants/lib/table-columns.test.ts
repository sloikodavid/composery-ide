import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// The table's no-shift guarantee rests on `cols`: fixed layout takes every
// column width from there, so a table whose shape is missing, mistyped, or out
// of step with its headers silently goes back to sizing itself from its data.
// These checks are what stops that, since none of it is visible at runtime
// until a column jumps.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = `${dir}/${entry.name}`;
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.name.endsWith(".tsx") ? [path] : [];
	});
}

// Every `<Table>` in the package, paired with the source between it and its
// closing tag. Tables never nest, so the next `</Table>` is always the match.
function tables() {
	return [`${ROOT}app`, `${ROOT}components`]
		.flatMap(sourceFiles)
		.flatMap((path) => {
			const source = readFileSync(path, "utf8");
			return [...source.matchAll(/<Table(?![A-Za-z])/g)].map((match) => {
				const start = match.index;
				const end = source.indexOf("</Table>", start);
				return {
					body: source.slice(start, end),
					name: path.slice(ROOT.length)
				};
			});
		});
}

const TOKENS = new Set([
	"fluid",
	...[
		...readFileSync(`${ROOT}components/base/table.tsx`, "utf8").matchAll(
			/^\t"?([\w-]+)"?: \d+/gm
		)
	].map((match) => match[1])
]);

describe("table columns", () => {
	test("has more than one width token to choose from", () => {
		// Guards the scrape above: a regex that stopped matching would leave every
		// column check below trivially passing.
		expect(TOKENS.size).toBeGreaterThan(3);
	});

	test.each(tables())("$name sizes every column it renders", ({ body }) => {
		expect(body).toContain("cols={");
		// The prop runs to the end of the opening tag, which is one array or - when
		// a table changes shape with a prop - a branch holding several.
		const prop = body.match(/cols=\{([\s\S]*?)\}\s*>/)?.[1] ?? "";
		const shapes = [...prop.matchAll(/\[([^\]]*)\]/g)].map((match) =>
			[...match[1].matchAll(/"([\w-]+)"/g)].map((token) => token[1])
		);
		expect(shapes.length).toBeGreaterThan(0);

		for (const shape of shapes) {
			// Exactly one fluid column: none and every column is pinned so the table
			// can't fill its container, more than one and they split the leftover
			// between them.
			expect(shape.filter((token) => token === "fluid")).toHaveLength(1);
			for (const token of shape) expect(TOKENS).toContain(token);
		}

		// A shape shorter than the header row leaves its last columns unsized, and
		// a longer one pushes width onto a column that isn't there.
		const heads = body.match(/<TableHead(?![A-Za-z])/g) ?? [];
		expect(Math.max(...shapes.map((shape) => shape.length))).toBe(heads.length);
	});
});
