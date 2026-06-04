// Prettier's configuration. A JS file rather than a "prettier" key in
// package.json because these comments have to live somewhere: Prettier accepts
// unknown keys inside an override without a word of complaint, so the "comment"
// field this block used to carry was never a supported field - and a misspelled
// "files" would have been swallowed just as quietly.
//
// packages/ide/overlay/src/ is copied into code-server's src/ by the build, so
// those files have to read like the files around them once they land. That makes
// upstream's own .prettierrc.yaml the authority on how they are formatted, and
// it is read here rather than copied into a second list that drifts the next
// time upstream edits its formatter. tests/invariants/prettier-config.test.ts
// checks the override still reaches those files, because a glob that matches
// nothing formats them to this repo's style and says nothing.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "yaml";

const upstreamConfig = resolve(
	import.meta.dirname,
	"packages/ide/upstream/.prettierrc.yaml"
);

function upstreamOptions() {
	try {
		return parse(readFileSync(upstreamConfig, "utf8"));
	} catch (cause) {
		// Falling back to this repo's style would format code-server's files to a
		// style unlike every file around them, and only the diff would ever say so.
		throw new Error(
			`Prettier cannot read ${upstreamConfig}. packages/ide/upstream is a git submodule - run "git submodule update --init --recursive".`,
			{ cause }
		);
	}
}

export default {
	useTabs: true,
	trailingComma: "none",
	overrides: [
		{
			files: "packages/ide/overlay/src/**",
			options: upstreamOptions()
		}
	]
};
