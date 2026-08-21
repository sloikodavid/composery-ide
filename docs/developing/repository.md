---
title: Repository
description: Fresh-clone setup, workspace map, verification gates, and the normal change workflow.
---

This is the zero-config entry point: assume only source access and no configured
local environment or external services. Product deployment continues under
[Web](web/index.md), and IDE-fork work under [IDE](ide.md).

## Fresh clone

The supported Node line is pinned in `.nvmrc`; pnpm is pinned by
`packageManager` in the root `package.json`. Node, pnpm, Git, Git LFS, and Git
submodules are the whole list on any host. Quilt and Rust are needed only to
run the IDE build or the CLI checks natively on Linux - see
[Host platforms](#host-platforms).

```bash
git clone --recurse-submodules https://github.com/<github-user>/<repo>.git
cd <repo>
git lfs install
git lfs pull
corepack enable
pnpm install --frozen-lockfile
```

If the clone already exists, repair its submodules with:

```bash
git submodule update --init --recursive
git lfs pull
```

Do not hand-edit dependency versions into a package manifest. Install or update
them through pnpm so the manifest and lockfile move together.

## Host platforms

Develop on Linux, Windows, or macOS. `pnpm check:portable` is the part of the
gate that must pass identically on all three, and CI runs it on Windows and
macOS runners as well as Linux, so a host-specific break fails a pull request
rather than one contributor's afternoon.

Quilt and a local Rust toolchain are not prerequisites off Linux. Two targets
need Linux, and reach for Docker when they cannot find it:

| Target                                  | Off Linux                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `pnpm check:cli`                        | Runs cargo in the Dockerfile's Rust image; the persistence crate needs Linux inotify/xattr |
| `pnpm build:image`, `pnpm system:smoke` | Build and run the shipped Linux image through Docker Desktop                               |

So `pnpm check` and `pnpm system:smoke` want Docker running on a Windows or macOS
host; everything else is native. The IDE fork builds inside the image, so
`packages/ide/scripts/build.sh` is never run from the host.

## Workspace map

| Path                | Responsibility                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `packages/web`      | Public site, customer dashboard, staff console, Convex backend, cloud orchestration, and these docs |
| `packages/ide`      | Owned hard fork of code-server, assembled from the upstream submodule, Quilt patches, and overlay   |
| `packages/cli`      | Rust CLI and persistence service                                                                    |
| `packages/shared`   | Brand and identity constants imported directly, plus the build-time CSS/asset generator             |
| `rootfs`            | Files installed into the shipped runtime image                                                      |
| `templates`         | Self-hosting templates                                                                              |
| `tests`             | Cross-package integration and patch-stack tests                                                     |
| `.github/workflows` | CI, smoke, release, and maintenance automation                                                      |

Read the nearest `AGENTS.md` before editing a package. In particular, upstream
files under `packages/ide/upstream` are never edited in place: upstream changes
are Quilt patches and fork-only files are path-mirrored under `overlay`.

## Daily commands

```bash
pnpm dev
pnpm check
pnpm build
pnpm system:smoke
```

`pnpm dev` starts the tree watcher, development container, Convex, Next.js,
and local theme editor. Run narrower scripts while iterating, such as
`pnpm --filter web check`, but run the root `pnpm check` before opening a pull request. The root
gate covers TypeScript, ESLint, Prettier, Vitest, the generated repository tree,
Renovate config, the IDE patch stack, Rust formatting/lints/tests, and brand
assets. CI then runs the complete build as a separate bundling gate.

Every root script is named for what it acts on, in four families:

| Family              | Names                                                                        |
| ------------------- | ---------------------------------------------------------------------------- |
| `dev:<pane>`        | One long-running process, so `pnpm dev` can start and colour each on its own |
| `build:<artifact>`  | One thing produced: the website, the runtime image                           |
| `system:<harness>`  | One directory under `tests/system/`                                          |
| `check:` and `fix:` | The same name on both sides, one pair per generated artifact                 |

There is no `build:convex`: Convex has no build step. Vercel's build command
runs `convex deploy` around the website build, which is why the website is one
target and the image is the other.

`scripts/tree.mjs` owns the tree embedded in the root `AGENTS.md`. If a change
adds, moves, or removes tracked paths, run `pnpm fix:tree`; do not manually
rewrite the generated block. Generated Convex API files may change after
function/schema changes and should be reviewed like any other generated diff.

## Source whitelist

`pnpm check:whitelist` derives a dump from every Git-owned or untracked,
non-Git-ignored path and compares it with the root `whitelist.jsonc`. CI fails
for an added or removed unit or casing form.

The list is the vocabulary gate, so a new entry is a cost: the word stays until
somebody removes it, and a list that grows on demand checks nothing. A flagged
unit asks about the source. Most answers are there: a typo, an accidental
filename, a word that repeats a word the list already has. `pnpm fix:whitelist`
prunes unused entries and repairs the order, but it refuses new entries and
exits with an error that names them. A word that carries a meaning no listed
word carries is accepted with
`node scripts/whitelist.mjs --write --accept-new`; record why in the commit
text. Review the resulting diff.

The lexical grammar is deliberately small. Filename extensions have no special
meaning, so `123.test.ts` becomes `1`, `2`, `3`, `.`, `test`, `.`, and `ts`.
Whitespace, punctuation, emoji, combining sequences, and other visible text use
Unicode grapheme clusters, so `1️⃣`, `👩‍💻`, skin-tone sequences, and flags each
remain one exact unit. Bare number segments become separate digits.
Letter/number transitions, lowercase-to-uppercase transitions, and the
last-uppercase-to-word transition split identifiers: `win32AppId` becomes
`win`, `3`, `2`, `App`, and `Id`, while `APIOperation` becomes `API` and
`Operation`. An existing complete unit wins first, so explicitly recording
`iPhone` prevents that run from becoming `i` and `Phone`. No substring or
dictionary-based split occurs.

The JSONC body is one array of strings. A lowercase ASCII entry accepts its
lowercase, Titlecase, and uppercase forms, so `"api"` accepts `api`, `Api`, and
`API`. Other mixed casing is exact: `"iPhone"` accepts only `iPhone`. Non-ASCII
text is also exact because Unicode casing can expand or depend on language.
Standard three-, four-, six-, and eight-digit CSS colors are accepted
structurally and omitted instead of producing fragments such as `fff`.

The required comment at the top of `whitelist.jsonc` is the authoritative
coverage ruling. The scanner does not cover the whitelist's own contents,
invalid UTF-8 or contents with the control ranges named in the ruling, contents
selected by `.whitelistignore`, or contents inside a Git submodule; it still
scans every filename and symbolic-link target. Ignore patterns are positive
repository-relative file globs. Negation, directory rules, duplicates, and
patterns that match nothing fail, so every rule is explicit and effective.
There is no inline suppression mechanism and the checker has no warnings mode.

## Change workflow

1. Pull the target branch and inspect `git status`; never discard unrelated
   local work.
2. Read the nearest instructions and the relevant developing runbook.
3. Make the smallest coherent change. Keep environment examples and provider
   docs in the same change as configuration behavior.
4. Run focused tests while iterating, then the appropriate package check.
5. Run `pnpm check`; run the build or smoke path when the change can affect
   packaging, routing, runtime boot, or provider integration.
6. Review the final diff for secrets, generated noise, stale wording, and
   unintentional provider/account assumptions.
7. Use a pull request. CI checks the Quilt stack with fuzz zero before the full
   build, so upstream patch drift fails loudly.

## Releases

The web frontend deploys through Vercel as described in
[Web / Vercel](web/services/vercel.md). Convex functions deploy separately with their
configured deployment. The shipped self-hosted product is a multi-architecture
ghcr image. `.github/IMAGE_RELEASE.md` is the image procedure. Image preview
refs publish preview tags; a stable run from current `main` reads the
root semver, publishes immutable version/SHA tags plus moving convenience tags,
scans the image, attests it, and creates the GitHub release. Never create stable
`v*` tags manually. The GitHub-side repository configuration - settings, rulesets,
Actions, ghcr, community intake, CLA, and Renovate - is
[Services / GitHub](services/github.md).

## Secrets and scratch work

Provider secrets belong in the provider's secret store or deployment
environment, never in Git, screenshots, issue text, shell history copied into a
PR, or documentation examples. Use the gitignored `tmp/` directory for local
artifacts. If a secret appears in a commit or shared log, rotate it at the
provider; deleting the visible text is not sufficient remediation.
