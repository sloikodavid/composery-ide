import { join } from "node:path";
import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const withMDX = createMDX();

const nextConfig: NextConfig = {
	// The docs/ markdown rendered at /docs lives at the repo root (two levels up).
	// Widen Turbopack's root so it resolves the sibling content and the single
	// workspace lockfile instead of inferring a root from this package.
	turbopack: {
		root: join(import.meta.dirname, "..", "..")
	},
	// The `shared` package ships raw .ts (imported directly, no build step), so
	// transpile it like first-party source.
	transpilePackages: ["shared"]
};

export default withMDX(nextConfig);
