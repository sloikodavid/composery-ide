---
title: GitHub
description: Create and configure the GitHub repository - settings, community intake, rulesets, Actions, ghcr, releases, security, CLA, and Renovate.
---

GitHub is a configured service, not just a remote: CI, smoke, and the release
pipeline run on GitHub Actions; the shipped runtime image publishes to ghcr;
bug reports, feature requests, questions, and vulnerability reports all land on
GitHub surfaces; the CLA bot records signatures; Renovate opens dependency
pull requests. This page assumes no GitHub account exists yet and walks a fresh
setup to parity with the canonical repository.

Repository checks and image publication authenticate with the ephemeral,
repository-scoped `GITHUB_TOKEN`. Do not replace it with a personal GitHub
access token. Check GitHub's plan/billing pages for runner and
storage allowances rather than recording mutable quotas here.

## Account and repository

Create a GitHub account, then a repository named `composery` (public, no
template, default branch `main`) and push the source:

```bash
git remote add origin https://github.com/<github-user>/composery.git
git push -u origin main
```

Two source-level facts matter to GitHub itself:

- `packages/ide/upstream` is a submodule of the public
  `coder/code-server` repository over HTTPS - cloning needs no credentials,
  and CI checks it out with `submodules: true`.
- The submodule's history uses Git LFS, so contributors need `git lfs install`
  (see [Repository](../repository.md)); this repository tracks no LFS objects
  of its own, so there is nothing to configure or pay for server-side.

## Repository settings

Settings -> General. The canonical values:

| Setting                         | Value                                  |
| ------------------------------- | -------------------------------------- |
| Default branch                  | `main`                                 |
| Wikis / Projects / Sponsorships | off                                    |
| Issues                          | on                                     |
| Discussions                     | on                                     |
| Allow merge commits             | off                                    |
| Allow squash merging            | off                                    |
| Allow rebase merging            | **on** (the only enabled merge method) |
| Allow auto-merge                | off                                    |
| Require signoff on web commits  | off                                    |

Rebase-only merging keeps `main` linear and lands commits as authored, which
the `Protect main` ruleset below also asserts via its linear-history rule.

```bash
gh repo edit <github-user>/composery \
  --enable-issues --enable-discussions \
  --enable-wiki=false --enable-projects=false \
  --enable-merge-commit=false --enable-squash-merge=false \
  --enable-rebase-merge
```

## Community intake

All intake surfaces ship in the repository - after the push there is nothing
to configure beyond enabling Discussions above:

- `.github/ISSUE_TEMPLATE/bug.yaml` is the only issue form; it labels new
  issues `bug` and requires the affected surface and reproduction details.
- `.github/ISSUE_TEMPLATE/config.yaml` disables blank issues and routes the
  "New issue" chooser: feature requests to the **Ideas** discussion category,
  questions to **Q&A**, vulnerabilities to a private security advisory, and
  Composery Cloud account/billing matters to the support email (contact links
  must be `https://` URLs, so the email rides in the link description).
- `.github/PULL_REQUEST_TEMPLATE.md` includes the CLA signing instructions.

Discussions ships with its default categories; the routing relies on the
**Ideas** and **Q&A** slugs (`/discussions/categories/ideas`, `.../q-a`).
Renaming or deleting those categories silently breaks the links in
`.github/ISSUE_TEMPLATE/config.yaml`, `packages/web/convex/model/links.ts`, and the
README - keep the defaults.

Labels: the GitHub default label set is enough for the issue form (`bug`).
Renovate applies a `dependencies` label to its pull requests and the canonical
repository carries that label; create it if Renovate reports it missing:

```bash
gh label create dependencies --color 0366d6 --description "Dependency updates"
```

## Ruleset: Protect main

Branch protection is a repository ruleset (Settings -> Rules -> Rulesets)
named `Protect main`, targeting `refs/heads/main`, with no bypass actors:

| Rule                                       | Parameters             |
| ------------------------------------------ | ---------------------- |
| Require a pull request                     | 0 approving reviews    |
| Required status checks                     | `all checks` and `cla` |
| Require branches to be up to date (strict) | on                     |
| Require linear history                     | -                      |
| Restrict deletions                         | -                      |
| Block force pushes                         | -                      |

**This ruleset is what stops a commit reaching production before the checks
pass**, so its enforcement is `active` and its bypass list is empty. Nothing
downstream re-checks: Vercel tracks `main` directly, so a commit that reaches
`main` is a commit that deploys.

Two parameters carry that weight and are easy to get wrong:

- **0 approving reviews.** The pull request itself is the gate - work lands on a
  branch, the checks run, and merging waits for them. A review count above the
  number of people who can review blocks every merge, which is why enforcement
  cannot simply be switched on with a `1` left in place. Raise it when a second
  person can approve.
- **Strict status checks.** Without it a stale branch may merge, and the tree
  that lands on `main` is one no run ever tested - exactly the commit the gate
  exists to stop. With it, and with rebase-only merging, the tested tree and the
  merged tree are the same tree.

Required status check contexts must exactly equal the check-run names GitHub
reports on a commit, not workflow file names. `all checks` is the one fail-closed
result over Linux, Windows, macOS, both smoke architectures, and the source-drift
check; a failed, cancelled, or skipped dependency makes it fail rather than
skip. Read the exact names off any recent commit before saving:

```bash
gh api repos/<github-user>/composery/commits/main/check-runs \
  --jq '.check_runs[].name'
```

Confirm the three settings that no test in the repository can see:

```bash
gh api repos/<github-user>/composery/rulesets --jq '.[] | select(.name=="Protect main") | .id' \
  | xargs -I{} gh api repos/<github-user>/composery/rulesets/{} \
  --jq '{enforcement, bypass: (.bypass_actors | length),
         strict: (.rules[] | select(.type=="required_status_checks")
                  | .parameters.strict_required_status_checks_policy)}'
```

It must report `active`, `0`, and `true`. A bypass actor, a lapsed enforcement
flag, or `strict: false` each reopens the path to production without changing a
file, and the only symptom from inside the repository is a red run on `main`.

## Actions

Settings -> Actions -> General: Actions enabled, all actions allowed, default
workflow token permissions **read-only**. Workflows elevate per-file through
their `permissions:` blocks, which is why none of this needs org-level policy:

| Workflow             | Trigger                               | Elevated permissions and why                                                                  |
| -------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `ci.yaml`            | pull requests, pushes to `main`, call | none; grouped platform and smoke checks finish in the stable, fail-closed `all checks` result |
| `smoke.yaml`         | call                                  | none; boots the image and logs the informational Trivy scan without changing repository state |
| `smoke-nightly.yaml` | schedule, dispatch                    | none - uncached image smoke                                                                   |
| `release.yaml`       | dispatch                              | revalidates the exact ref before image release, ghcr, provenance, and Trivy permissions       |
| `cla.yaml`           | PR events/comments                    | signature branch, PR comments, and recheck permissions                                        |

Operational notes:

- Linux image work runs on the hosted `ubuntu-24.04` and `ubuntu-24.04-arm`
  runners - both free for public repositories, nothing to provision.
- Docker builds cache through the GitHub Actions cache (`type=gha`). The
  per-repository cache budget is limited and evicts least-recently-used
  entries; slow cold builds after quiet periods are normal, not broken.
- GitHub suspends scheduled workflows (`smoke-nightly.yaml`) after 60 days
  without repository activity; re-enable from the Actions tab if it happens.
- `cla.yaml` guards on `github.repository == 'sloikodavid/composery'` so forks
  do not run a misconfigured CLA bot; see
  [Running your own](#running-your-own) before expecting it to work on a fork.

## Container registry

`release.yaml` pushes multi-architecture images to
`ghcr.io/<github-user>/composery` using `GITHUB_TOKEN` - no registry
credentials exist anywhere. Two one-time steps after the first release run:

1. The first push creates the ghcr package **private**. Make it public so
   `docker run` works unauthenticated (Package -> Package settings -> Danger
   Zone -> Change visibility), which the README quickstart, the self-hosting
   docs, and every template assume.
2. Confirm the package is linked to the repository (publishing from Actions
   does this automatically), so the package page shows the repo README and
   inherits access.

The tag scheme, and why some tags are immutable while `latest`,
`<major>.<minor>`, and `preview-<ref>` move, is specified in
[`.github/IMAGE_RELEASE.md`](https://github.com/sloikodavid/composery-ide/blob/main/.github/IMAGE_RELEASE.md).
Renovate is configured to never bump our own image reference.

## Releases and tags

Stable image `v*` tags and image GitHub Releases are created exclusively by the
image release workflow; never create them by hand. The operator procedure is
`.github/IMAGE_RELEASE.md`:

- Actions -> release -> Run workflow (requires write access; image release has
  no provider credential).
- Each published image gets a build provenance attestation pushed to the
  registry. Verify one with:

  ```bash
  gh attestation verify oci://ghcr.io/<github-user>/composery:latest \
    --owner <github-user>
  ```

## Security

- **Private vulnerability reporting** (Settings -> Advanced Security) is
  enabled; `SECURITY.md` and the issue chooser both point reporters at
  private advisories instead of public issues.
- **Code scanning** needs no setup: after the complete validation tier passes,
  the release workflow uploads Trivy SARIF results (severity `CRITICAL,HIGH`),
  which appear under Security -> Code scanning alerts.
- **Secret scanning and push protection** (same settings page): enable both.
  They are free on public repositories and block accidental credential
  pushes at the git layer. Provider secrets must never enter Git regardless -
  see [Repository](../repository.md#secrets-and-scratch-work).
- **Dependabot security updates stay off**: Renovate owns dependency updates
  (including `vulnerabilityAlerts`), and two bots opening PRs for the same
  advisories is noise.

## CLA

Contributions are covered by `.github/CLA.md`, enforced by the
`contributor-assistant` action in `cla.yaml`:

- On each PR the bot posts signing instructions; the contributor signs by
  commenting the exact sentence from the PR template, and `recheck` re-runs a
  stalled check.
- Signatures are recorded in `signatures/cla-v1.json` on the `cla-signatures`
  branch, which the action creates on first signature - do not create,
  protect, or delete it manually.
- Bot authors (`github-actions[bot]`, `dependabot[bot]`, `renovate[bot]`) are
  allowlisted.
- If `CLA.md` changes materially, bump the signature file version in
  `cla.yaml` (`cla-v1.json` -> `cla-v2.json`) so existing signatures do not
  cover a document their authors never read.

## Renovate

Dependency updates come from the hosted Mend Renovate GitHub App - there is no
Renovate workflow in this repository. Install it from the GitHub Marketplace
(Mend Renovate, free tier) and grant it this repository. Behavior is entirely
`renovate.json` at the repo root, validated in CI by `pnpm check:renovate`;
the highlights: a Dependency Dashboard issue, a 3-day minimum release age,
automerge for low-risk updates once CI and smoke pass, and manual dashboard
approval held for majors and for `packages/ide/upstream` submodule bumps
(a code-server release can break the quilt patch stack - see
[IDE](../ide.md)).

## Vercel connection

The production website deploys from `main` through the Vercel GitHub App,
installed during `vercel link`. `packages/web/vercel.json` rejects Git
deployments from every other branch, and the `Protect main` ruleset above is
what makes tracking `main` safe: no commit reaches it without `all checks`. That
connection and everything after it is [Web / Vercel](../web/services/vercel.md).

## Running your own

The canonical coordinates `sloikodavid/composery` (and the support email) are
hardcoded where a moving value would be wrong or unreachable - shipped docs,
deploy templates, product metadata, and workflow security guards. After
forking or recreating the repository under another owner, repoint them; this
finds every site:

```bash
git grep -n "sloikodavid" -- ':!packages/ide/upstream' ':!pnpm-lock.yaml'
```

| Surface                                                                   | What it controls                                                      |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `.github/workflows/cla.yaml`                                              | repo guard condition and the CLA document URLs                        |
| `.github/ISSUE_TEMPLATE/config.yaml`                                      | issue-chooser links to Discussions, advisories, and the support page  |
| `renovate.json`                                                           | the "never bump our own image" package rule                           |
| `README.md`, `CHANGELOG.md`, `docs/self-hosting/`, `templates/`           | published image references and repo links                             |
| `compose.dev.yaml`, `Dockerfile` (`COMPOSERY_BUILD_SOURCE`)               | image source labels                                                   |
| `packages/web/convex/model/links.ts` (`GITHUB_REPO_URL`, `SUPPORT_EMAIL`) | the website's repo links, issue/discussion links, and support email   |
| `packages/ide/scripts/rebrand.mjs`                                        | product metadata baked into the IDE build (issue URL, license, email) |
| `packages/ide/overlay/.../composery-*/package.json`                       | bundled extension repository metadata                                 |

`release.yaml` and `smoke.yaml` need no edits - they derive the image owner from
`github.repository_owner` at run time.

## References

- Issue forms: https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms
- Issue template chooser config: https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/configuring-issue-templates-for-your-repository
- Repository rulesets: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
- GITHUB_TOKEN permissions: https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication
- ghcr package visibility: https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility
- Artifact attestations: https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations
- Private vulnerability reporting: https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/configuring-private-vulnerability-reporting-for-a-repository
- CLA assistant action: https://github.com/contributor-assistant/github-action
- Renovate configuration: https://docs.renovatebot.com/configuration-options/
