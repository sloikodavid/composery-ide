import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";
import { parse } from "yaml";

import { repoRoot, readRepoFile } from "../support/repo.ts";

// Node is pinned in `.nvmrc` for humans and CI, constrained by package engines,
// and baked into the Docker base image for the shipped IDE runtime. Keep those
// declarations in lockstep so the IDE's native-module ABI cannot drift silently.
const nodeVersion = readRepoFile(".nvmrc").trim();
const rootPackage = JSON.parse(readRepoFile("package.json")) as {
	engines?: Record<string, string>;
	packageManager?: string;
};
// Enumerated from disk, not listed: a hardcoded pair silently exempted every
// workflow added after it. Any workflow that sets Node up at all is covered.
const workflows = readdirSync(resolve(repoRoot, ".github/workflows"))
	.filter((name) => name.endsWith(".yaml"))
	.map((name) => `.github/workflows/${name}`)
	.filter((path) => readRepoFile(path).includes("actions/setup-node"));

describe("toolchain pins", () => {
	test("the IDE upstream npm install drops pnpm-only environment config and cleans scratch on failure", () => {
		const source = readRepoFile("packages/ide/scripts/types.mjs");
		expect(source).toContain('process.on("exit", () => rmSync(SCRATCH');
		expect(source).toContain(
			'name.toLowerCase() !== "npm_config_manage_package_manager_versions"'
		);
		expect(source).toContain("{ ...scratch, env: npmEnv }");
	});

	// One product, one version number, and releasing means editing one file.
	//
	// The root package.json is the source: the release workflow reads it, refuses
	// anything that is not plain semver, and derives the git tag, the
	// `:latest`/`:X.Y`/`:X.Y.Z` image tags, and COMPOSERY_BUILD_VERSION - which
	// becomes the image's org.opencontainers.image.version label and everything
	// the update system compares.
	//
	// Every other `version` field in the repository belongs to a private,
	// unpublished workspace package and must stay 0.0.0. That is the point of this
	// test: it does not ask two numbers to agree, it asks that a second real
	// number never appears. Keeping copies in sync is friction paid on every
	// release forever, and a contributor who bumps one and not the other ships a
	// build that reports one version in its editor and another from its own CLI.
	// Nothing here needs a real number - the Rust binary reads the version from
	// the environment at runtime - so the honest state for all of them is "not a
	// version".
	test("only the root package.json carries a real version", () => {
		const productVersion = (
			JSON.parse(readRepoFile("package.json")) as { version: string }
		).version;
		expect(productVersion).toMatch(/^\d+\.\d+\.\d+$/);

		const inert = [
			"packages/web/package.json",
			"packages/ide/package.json",
			"packages/shared/package.json"
		];
		for (const path of inert) {
			const version = (JSON.parse(readRepoFile(path)) as { version?: string })
				.version;
			expect(version, path).toBe("0.0.0");
		}

		// The Rust workspace version reaches users through `composery --version`
		// unless the binary overrides it, so this pair has to hold together: the
		// manifest stays inert *and* the override exists.
		expect(
			/^version = "([^"]+)"$/m.exec(
				readRepoFile("packages/cli/Cargo.toml")
			)?.[1]
		).toBe("0.0.0");
		const cli = readRepoFile("packages/cli/crates/composery/src/cli.rs");
		expect(cli).toContain("version = version()");
		expect(cli).toContain('std::env::var("COMPOSERY_BUILD_VERSION")');
	});

	test(".nvmrc is exact semver", () => {
		expect(nodeVersion).toMatch(/^\d+\.\d+\.\d+$/);
	});

	// The catalog in pnpm-workspace.yaml is the only place a version shared by two
	// workspace packages is written down, and this is what makes that sentence
	// true rather than a wish. It is checked in both directions on purpose: a
	// shared dependency that skips the catalog is the drift the catalog exists to
	// stop, and an entry with one consumer is indirection that prevents nothing
	// while reading like a rule. Enumerated from the manifests, never listed, so a
	// package or dependency added later cannot slip past.
	describe("the catalog holds the dependencies more than one package declares", () => {
		const manifests = ["packages/web", "packages/ide", "packages/shared"]
			.map((dir) => `${dir}/package.json`)
			.concat("package.json")
			.map((path) => ({
				path,
				json: JSON.parse(readRepoFile(path)) as {
					dependencies?: Record<string, string>;
					devDependencies?: Record<string, string>;
				}
			}));

		// name -> every manifest that declares it, with the range it asks for.
		const declarations = new Map<string, { path: string; range: string }[]>();
		for (const { path, json } of manifests) {
			for (const deps of [json.dependencies, json.devDependencies]) {
				for (const [name, range] of Object.entries(deps ?? {})) {
					declarations.set(name, [
						...(declarations.get(name) ?? []),
						{ path, range }
					]);
				}
			}
		}

		const catalog = (
			parse(readRepoFile("pnpm-workspace.yaml")) as {
				catalog?: Record<string, string>;
			}
		).catalog;

		test("the manifest scan found something to check", () => {
			// Without this, every assertion below passes on an empty enumeration.
			expect(manifests).toHaveLength(4);
			expect(declarations.size).toBeGreaterThan(20);
			expect(Object.keys(catalog ?? {}).length).toBeGreaterThan(0);
		});

		test("every dependency two packages declare is in the catalog", () => {
			const shared = [...declarations]
				.filter(([, sites]) => sites.length > 1)
				.map(([name]) => name);

			// A workspace link is a name two packages can share without a version to
			// drift, so it is not the catalog's business.
			const versioned = shared.filter((name) =>
				declarations
					.get(name)
					?.every(({ range }) => !range.startsWith("workspace:"))
			);

			expect(versioned.sort()).toEqual(Object.keys(catalog ?? {}).sort());
		});

		test("every shared declaration reads the catalog rather than a literal", () => {
			for (const name of Object.keys(catalog ?? {})) {
				for (const { path, range } of declarations.get(name) ?? []) {
					expect(range, `${path} declares ${name}`).toBe("catalog:");
				}
			}
		});
	});

	// The coverage provider is released in lockstep with the runner and refuses to
	// load against a different minor, so these two are one version written twice.
	// The copy cannot be removed - they are separate packages on the registry - and
	// nothing derives one from the other, so this is the duplication ladder's last
	// rung. Renovate groups them ("vitest") so they move together; this is what
	// notices when something moves only one of them.
	test("the coverage provider version matches the vitest runner", () => {
		const catalog = (
			parse(readRepoFile("pnpm-workspace.yaml")) as {
				catalog: Record<string, string>;
			}
		).catalog;
		const coverage = (
			JSON.parse(readRepoFile("package.json")) as {
				devDependencies: Record<string, string>;
			}
		).devDependencies["@vitest/coverage-v8"];

		expect(catalog.vitest).toMatch(/^\d+\.\d+\.\d+$/);
		expect(coverage).toBe(catalog.vitest);
	});

	// @types/node is not a dependency to keep current, it is a description of the
	// runtime underneath. A newer major types APIs the shipped Node does not have,
	// so the compiler goes on passing while it describes a machine we do not run.
	// Renovate cannot derive that ceiling, so it is written there as a number; this
	// is what stops that number and the runtime from drifting apart.
	test("@types/node describes the pinned Node major, and Renovate's ceiling agrees", () => {
		const nodeMajor = Number(nodeVersion.split(".")[0]);
		const catalog = (
			parse(readRepoFile("pnpm-workspace.yaml")) as {
				catalog: Record<string, string>;
			}
		).catalog;

		expect(catalog["@types/node"]).toMatch(
			new RegExp(String.raw`^${nodeMajor}\.\d+\.\d+$`)
		);

		const renovate = JSON.parse(readRepoFile("renovate.json")) as {
			packageRules: {
				matchPackageNames?: string[];
				allowedVersions?: string;
			}[];
		};
		const ceiling = renovate.packageRules.find(
			(rule) =>
				rule.allowedVersions !== undefined &&
				rule.matchPackageNames?.length === 1 &&
				rule.matchPackageNames[0] === "@types/node"
		)?.allowedVersions;

		expect(ceiling).toBe(`<${nodeMajor + 1}`);
	});

	test("package engines match the pinned Node version", () => {
		const nodeMajor = Number(nodeVersion.split(".")[0]);

		expect(rootPackage.engines?.node).toBe(
			`>=${nodeVersion} <${nodeMajor + 1}`
		);
		expect(rootPackage.engines).not.toHaveProperty("pnpm");
	});

	test("Dockerfile base image names the exact pinned Node version", () => {
		const dockerImage =
			/^ARG NODE_IMAGE=node:(\d+\.\d+\.\d+)-trixie-slim@sha256:[a-f0-9]{64}$/m.exec(
				readRepoFile("Dockerfile")
			)?.[1];

		expect(dockerImage).toBe(nodeVersion);
	});

	test("Dockerfile runtime pnpm matches packageManager", () => {
		const pnpmVersion = /^pnpm@([^+]+)/.exec(
			rootPackage.packageManager ?? ""
		)?.[1];
		const dockerPnpmVersion = /^ARG PNPM_VERSION=(\S+)$/m.exec(
			readRepoFile("Dockerfile")
		)?.[1];

		expect(dockerPnpmVersion).toBe(pnpmVersion);
	});

	test("IDE engine patch rejects the old upstream Node major", () => {
		const nodeMajor = Number(nodeVersion.split(".")[0]);
		const patch = readRepoFile("packages/ide/patches/node-engine.diff");

		expect(patch).toContain('-    "node": "22"');
		expect(patch).toContain(`+    "node": ">=24.15.0 <${nodeMajor + 1}"`);
	});

	// Rust's version lives in three places and, unlike Node, none of them can see
	// the others: Cargo's rust-version, the CI toolchain action, and the Docker
	// build image. Renovate groups the latter two ("rust toolchain"); this pins
	// Cargo's floor to them, so a bump that misses one fails here.
	test("Rust toolchain pins agree across Cargo, CI, and the Docker image", () => {
		const cargoVersion = /^rust-version = "([^"]+)"$/m.exec(
			readRepoFile("packages/cli/Cargo.toml")
		)?.[1];
		const ci = parse(readRepoFile(".github/workflows/ci.yaml")) as {
			jobs: Record<string, { steps?: Array<{ uses?: string }> }>;
		};
		const ciVersions = Object.values(ci.jobs)
			.flatMap((job) => job.steps ?? [])
			.flatMap(
				(step) =>
					/^dtolnay\/rust-toolchain@(\S+)$/.exec(step.uses ?? "")?.[1] ?? []
			);
		const imageVersion = /^FROM rust:(\d+\.\d+\.\d+)-/m.exec(
			readRepoFile("Dockerfile")
		)?.[1];

		expect(cargoVersion).toBeDefined();
		expect(ciVersions).toHaveLength(1);
		// Cargo states a minimum (major.minor); CI and the image are exact and must
		// satisfy it, so compare on the major.minor they share.
		const minor = (value?: string) => value?.split(".").slice(0, 2).join(".");
		expect(minor(ciVersions[0])).toBe(cargoVersion);
		expect(minor(imageVersion)).toBe(cargoVersion);
	});

	test("the workflow scan found something to check", () => {
		// An empty enumeration would make the test.each below vacuously pass.
		expect(workflows.length).toBeGreaterThan(1);
	});

	test.each(workflows)("%s reads Node from .nvmrc, not a literal", (path) => {
		const yaml = readRepoFile(path);
		expect(yaml).toContain("node-version-file: .nvmrc");
		expect(yaml).not.toMatch(/node-version:\s*["']?\d/);
	});
});
