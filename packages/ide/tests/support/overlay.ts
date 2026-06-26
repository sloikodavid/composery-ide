import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import ts from "typescript";

// Loading overlay modules so a behaviour test can run them. Overlay files
// compile against the upstream IDE tsconfig and VS Code's module graph, so most
// cannot simply be imported here - but they are real files, so they can be
// evaluated as shipped rather than paraphrased.
//
// This is the sanctioned path for `packages/ide/tests/behavior/`. It hands back
// a module, never its text, which is what keeps a behaviour test from quietly
// becoming a grep over source. The patch-extraction helpers next door are the
// text-handling ones and are confined to `invariants/`.
//
// Coverage attribution is the trap here. Vitest maps v8's ranges through the
// source map of *its own* esbuild transform of the same path, which preserves
// line numbers; `transpileModule` re-prints the AST, which does not. Where the
// two disagree the report is simply wrong, in both directions - `api/config.ts`
// is 42 source lines emitted as 73 and shows its whole `apiConfig` literal as
// unreached while a test drives it 19 times, and `api/auth.ts` shows the body of
// `httpAuth` unreached while two tests drive both its branches.
//
// Alignment is incidental, not a property to reason about: an interop preamble
// causes it, so do parameter properties, so does any construct the re-print
// spells differently. `cloud.ts` happens to line up and reports an unreachable
// probe at exactly the right lines; that is luck, not a rule.
//
// So a module loaded here earns its correctness from its assertions, never from
// a percentage, and belongs in the coverage exclusions in vitest.config.ts.
// Measured dead ends, so they are not retried: `esModuleInterop: false` drops
// the preamble and breaks the modules that need the interop, and an inline
// `sourceMap` is ignored because vitest never sees a `vm.Script`. The fix that
// would work is evaluating these as ES modules rather than re-printing them to
// CommonJS, which needs `--experimental-vm-modules`.

function transpileToCommonJs(source: string): string {
	return ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022
		}
	}).outputText;
}

export function loadOverlayModule<T>({
	source,
	dependencies = {},
	globals = {}
}: {
	source: URL;
	dependencies?: Record<string, unknown>;
	globals?: Record<string, unknown>;
}): {
	exports: T;
	binding<U>(name: string): U;
} {
	const filename = fileURLToPath(source);
	const localRequire = createRequire(source);
	const module = { exports: {} as T };
	const context = vm.createContext({
		...globals,
		exports: module.exports,
		module,
		__dirname: fileURLToPath(new URL(".", source)),
		__filename: filename,
		require(specifier: string): unknown {
			if (Object.hasOwn(dependencies, specifier)) {
				return dependencies[specifier];
			}
			return localRequire(specifier) as unknown;
		}
	});

	const contents = readFileSync(filename, "utf8");
	const executable = filename.endsWith(".ts")
		? transpileToCommonJs(contents)
		: contents;
	new vm.Script(executable, { filename }).runInContext(context);
	return {
		exports: module.exports,
		binding<U>(name: string): U {
			return new vm.Script(name).runInContext(context) as U;
		}
	};
}
