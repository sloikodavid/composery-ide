// Writes a generated file, first formatting its contents with the repo's
// Prettier config so committed output matches `prettier --check .` without a
// generator reaching out to reformat the whole tree. Files Prettier has no
// parser for (e.g. .svg) are written verbatim.
import { writeFile } from "node:fs/promises";
import prettier from "prettier";

// Formats content with the repo's Prettier config, or returns it unchanged for
// files Prettier has no parser for (e.g. .svg). Shared by writeFormatted (write
// path) and the brand --check guard (compare path) so both agree byte-for-byte.
export async function formatContent(path, content) {
	const { inferredParser } = await prettier.getFileInfo(path);
	if (!inferredParser) return content;
	const config = await prettier.resolveConfig(path);
	return prettier.format(content, { ...config, filepath: path });
}

export async function writeFormatted(path, content) {
	await writeFile(path, await formatContent(path, content));
}
