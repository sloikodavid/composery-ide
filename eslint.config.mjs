import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

const TS_FILES = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];

export default defineConfig(
	// Only what ESLint would otherwise walk into. `node_modules` and `.git` are
	// ignored by ESLint itself, and a path that exists in no checkout - a build
	// directory nothing writes, a vendor directory we do not have - reads like a
	// rule when it is really a guess, so each entry below names something real.
	globalIgnores([
		// Scratch and build artifacts, both gitignored.
		"tmp/",
		"coverage/",
		"packages/ide/build/",
		// This package lints itself, through a flat config that extends
		// eslint-config-next.
		"packages/web/**",
		// The code-server submodule, and the files we add to its tree. Overlay
		// files are formatted and written to read like the upstream sources they
		// sit beside (see the prettier override in package.json), so our rules are
		// the wrong ones to hold them to.
		"packages/ide/overlay/**",
		"packages/ide/upstream/**"
	]),
	{
		linterOptions: {
			reportUnusedDisableDirectives: "error"
		}
	},
	js.configs.recommended,
	{
		files: TS_FILES,
		extends: [tseslint.configs.recommendedTypeChecked],
		// `recommendedTypeChecked` already sets no-floating-promises and
		// no-misused-promises to error; restating them here said nothing.
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname
			}
		}
	},
	{
		// Every `.mjs` here is a Node script - a generator, a check, or a test
		// harness. Listing the directories they live in was a second copy of the
		// layout that went stale the moment one moved.
		//
		// These three are the whole set: every other Node global these scripts use
		// is imported by name (`node:buffer`, `node:timers`). To derive the list
		// again, empty it and read what ESLint reports as undefined.
		files: ["**/*.mjs"],
		languageOptions: {
			globals: {
				console: "readonly",
				fetch: "readonly",
				process: "readonly"
			}
		}
	}
);
