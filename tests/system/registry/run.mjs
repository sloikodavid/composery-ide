import { resolveRelease } from "../../../packages/web/convex/boxes/infra/registry.ts";

// This is the image every self-hosting guide and managed box uses. Resolve it
// without credentials so a deleted or private release fails before deployment.
const image = "ghcr.io/sloikodavid/composery:latest";
const release = await resolveRelease(image);
if (
	!/^ghcr\.io\/sloikodavid\/composery@sha256:[a-f0-9]{64}$/.test(release.image)
) {
	throw new Error(`The registry resolved ${image} to ${release.image}.`);
}
// The version label has one contract: it is the stamp a release build puts on
// the image, so on :latest it must be a plain X.Y.Z. Not the release's literal
// number - the literal lives once, in the root package.json, and CI runs
// before a release publishes, so a copy here would go red between bump and
// publish.
if (!/^\d+\.\d+\.\d+$/.test(release.version ?? "")) {
	throw new Error(`The registry reports version ${release.version ?? "none"}.`);
}

console.log(
	`${image} -> ${release.image} (${release.version ?? "unlabelled"})`
);
