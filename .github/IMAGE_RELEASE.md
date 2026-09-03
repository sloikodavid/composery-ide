# Image release

Composery container-image releases publish to ghcr.

GitHub always shows a **Use workflow from** dropdown when manually running a
workflow. Leave it set to `main`; that dropdown selects the workflow definition.

The image workflow has one input: `ref`.

- `main` creates a stable image release.
- Any other branch, tag, or commit creates a preview image.

## Preview image

1. Open GitHub -> **Actions** -> **release** -> **Run workflow**.
2. Leave **Use workflow from** on `main`.
3. Enter the branch, tag, or full commit SHA in `ref`.

It publishes `preview-<ref>` and immutable `sha-<short-sha>` tags without a
GitHub Release or `latest` tag.

## Stable image

1. Merge a PR changing the root `package.json` version to plain `X.Y.Z`.
2. Confirm CI and smoke checks pass on `main`.
3. Open **Actions** -> **release** -> **Run workflow** and leave `ref` as `main`.

The workflow reruns the complete CI tier, including both smoke architectures and
the source-drift check, for the exact ref before it receives any package write
permission. It then verifies the current `main`, builds both architectures,
publishes the multi-platform manifest, scans it, attests it, and creates tag
`vX.Y.Z`. It publishes `<version>`, `<major>.<minor>`, `latest`, and the commit
tag.

Do not create `v*` tags or stable image GitHub Releases manually; the image
workflow owns them.
