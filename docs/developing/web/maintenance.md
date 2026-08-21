---
title: Maintenance
description: Runtime settings, runtime image versions, fixed retention windows, and scheduled backend work.
---

This page contains operational timing and retention behavior that matters when
running the hosted product. Implementation batch sizes and internal helper
constants are deliberately omitted; the code is the source of truth for those
and duplicating them here adds maintenance without helping an operator.

## Runtime settings

The staff console at **/console** owns the values that should change without a
deployment:

- checkout enabled/disabled;
- the Hetzner server and snapshot allocations assigned to this deployment;
- per-user concurrent unpaid checkout reservations;
- the retention window for the snapshots this deployment takes, and the
  manual-capture cooldown;
- abuse/resource thresholds;
- automatic suspension enabled/disabled;
- the minimum runtime version the fleet may run; and
- the plan a comped box is granted on.

Checkout fails closed until both Hetzner allocations are configured. Read
[Operations](operations.md) before changing allocations or destructive
behavior.

What a plan _is_ deliberately stays in code rather than joining that list: its
machine, and how many snapshots it includes, live in `convex/model/box/plan.ts` because
the pricing page is printed from that same row. A console control over either
would let what a visitor is sold and what they are given disagree. How an owner
divides their own box's allowance is theirs, not staff's, and lives on the box.
See [Hetzner](services/hetzner.md#plans).

## Runtime image versions

### Where the version comes from

There is one product version, and it lives in the **root `package.json`**. Nothing
else declares it and nothing derives it from a tag.

The release workflow reads that field, refuses it unless it is plain `X.Y.Z`, and
derives everything else from it: the git tag `vX.Y.Z`, the image tags `:latest`,
`:X.Y` and `:X.Y.Z`, and the `COMPOSERY_BUILD_VERSION` build argument. That
argument becomes both the image's `org.opencontainers.image.version` label - which
is the version the website reads and shows an owner - and the environment variable
the editor's own update notifier compares. A build that is not a release is
stamped `preview-<sha>` instead, and every version surface treats that as "not
release-comparable" rather than guessing.

So: **to cut a release, bump the root `package.json` and nothing else.** To find
out what a given box runs, read its box page; to find out what the fleet is on,
read the staff console.

### Versions that are not that one

Every other `version` field in the repository - `packages/web`, `packages/ide`,
`packages/shared`, and the Rust workspace in
`packages/cli/Cargo.toml` - belongs to a private, unpublished package and is
pinned at `0.0.0` on purpose. None of them is a release input, and a test in
`tests/invariants/toolchain-pins.test.ts` keeps them inert so a second real version cannot
creep back in.

That test deliberately does **not** ask two numbers to agree. Keeping copies in
sync is friction paid on every release forever, and the failure it invites is
silent: bump one and not the other and a box reports one version in its editor
and a different one from its own CLI. `composery --version` avoids the problem
rather than policing it - the binary reads `COMPOSERY_BUILD_VERSION` from its
environment at runtime, so it reports whatever the image it is running in was
built as, and answers `unknown` outside an image because an unreleased build has
no version to claim.

### How a box's version is compared

`RUNTIME_IMAGE` names a channel, not a version. A box resolves it to an
immutable digest when it is created and records that digest, so the tag can move
afterwards without changing what any existing box runs. Only two operations
re-resolve the channel: Reset, which rebuilds the host and does not keep the
box's files, and Update, which keeps them. Repair rewrites the box's runtime
files from Convex state, so it puts back the digest the row already records
rather than advancing it - which is what makes Repair the way back from a failed
update.

Compare digests, never version strings. The digest is what a box runs; the
`org.opencontainers.image.version` label on it is the human-readable name shown
in the interface and nothing else decides from it. This holds whatever the
channel points at - a moving tag, a pinned minor line, or a digest during a
rollback - so no surface needs to special-case one of them.

A managed runtime that served and then fails three internal checks exits so
Docker can restart it. A runtime that never served does not exit itself, which
prevents a bad configuration from becoming a restart loop. The external repair
gates still decide what happens next.

The console owns the **minimum runtime version**, the floor below which a box is
not allowed to stay. Above the floor a box updates only when its owner asks; at
or below it the owner is warned with a deadline and the box is updated
automatically once that deadline passes.

### The floor is a support obligation

Composery drives a box over SSH and parses its internals - service states, the
persistence engine the box chose, the environment the editor process started
with. Those readers live in `packages/web/convex/boxes/infra/`.

**Every runtime version at or above the floor has to keep working with them.**
Changing what a box prints - a CLI's output shape, a service name, a variable
the editor is started with - is a compatibility break for every box that has not
updated yet, not just for the release that introduces it. The safe order is:
ship the new shape while the readers still accept the old one, wait for the
fleet to move, then raise the floor, and only then remove the old parsing path.
Raising the floor is what retires a compatibility path; the deployment that adds
a new one never does.

This is also why boxes do not get a version or channel choice. The
compatibility window is bounded by the floor and nothing else, so a box that
could sit arbitrarily far behind would widen it without limit.

### When a compatibility path can be removed

The floor is what retires a path, but the deadline alone does not prove the
path is dead. A stopped or suspended box is picked up by the floor sweep only
once it becomes eligible again, so a box can still start below a floor whose
deadline has passed. Remove a reader only when a query over the boxes table,
covering every status, shows no box below the floor - and never on the release
that ships the new shape. The safe order is the adding order in reverse: ship
the new shape, wait for the fleet to move, raise the floor, wait for the sweep
to cross every box, and only then delete the old path.

Self-hosted volumes have no floor, so a format reader for them is a permanent
obligation or a documented support window. Prefer the migration rewrite in
`packages/cli/crates/persistence/src/metadata.rs` over an ever-growing set of
readers: a format bump ships a rewrite from the previous format, the reader
keeps accepting exactly one format, and only the rewrite is ever removed.

### Persistence across an image change

Cloud boxes run the overlay engine, so a box's delta is an overlayfs upper layer
on its volume, and changing the image is the case that engine is built for: the
new image ships a new lower, and the boot-time hygiene pass reconciles the
upper's deletion markers against the previous and current image baselines before
mounting. The policy is documented in
`packages/cli/crates/persistence/src/overlay.rs` and exercised against real
booted containers by `tests/system/overlay/run.sh`. An update is therefore not a
special case for persistence; it is the upgrade path that engine already
implements.

The reverse is not symmetrical. Re-pinning an older image points an older reader
at a delta a newer one has already written. Where that reader can detect the
mismatch it refuses to start and says so, which is recoverable; where it cannot,
it misreads. Treat any release that changes the delta's on-disk shape as a floor
move with its own migration plan, never as an ordinary update.

## Fixed windows

These values intentionally require a code change and deployment because they
define evidence retention, retry cadence, or background workload:

| Behavior                           | Window                              |
| ---------------------------------- | ----------------------------------- |
| Unattached checkout reservation    | 1 hour                              |
| Consecutive failures before repair | 3 probes (~30 minutes)              |
| Automatic repair quiet window      | 2 hours after a person acts         |
| Automatic repairs per box          | 2 per 24 hours                      |
| Orphaned operation grace period    | 30 minutes                          |
| Long-running operation alert       | After 6 hours                       |
| Delete attempts before alert       | 3 attempts                          |
| Raw metrics retention              | 2 days                              |
| Hourly metrics retention           | 30 days                             |
| Repeat flag cooloff per box/signal | 6 hours                             |
| Staff-alert record retention       | 180 days                            |
| Stuck account-deletion alert       | After 24 hours                      |
| Incomplete snapshot-row retention  | 24 hours                            |
| Snapshot capture deadline          | 1 hour                              |
| Deleted box/support evidence       | 180 days                            |
| Unpaid checkout record             | 30 days                             |
| Paid billing record                | 6 calendar years after the box ends |

Each row is bound to the constant that produces it by a `// window:` comment on
that constant, and `tests/invariants/fixed-windows.test.ts` fails if a number here stops
matching the code or a row loses its constant. Cadences that come from a cron
are declared in `convex/crons.ts` and are not restated here.

Paid initial-fulfillment failure, provider cleanup, capacity admission, and
refund behavior are specified once in [Operations](operations.md),
[Polar](services/polar.md), and [Hetzner](services/hetzner.md).

## Scheduled work

Convex owns every periodic backend job; no separate worker service is required.
Every job and the time it runs are declared in
**packages/web/convex/crons.ts**, which is one file of literal declarations and
the only place a schedule is stated. Read it there. Each name in it is Convex's
own, so what that file calls a job is what the Convex dashboard and the logs
call it. All fixed times are UTC.

Hetzner reconciliation deletes untracked product snapshot images only after a
two-hour grace period. It never deletes an untracked server automatically; it
records and alerts on the server for manual review. Polar and Hetzner
reconciliation failures also create rate-limited staff alerts.

## Automatic repair

A box that stops answering its health probe is repaired without its owner asking,
but only after every gate in `packages/web/convex/boxes/autoRepair.ts` passes. The
gates exist because a Composery box is a root-capable machine its owner is
supposed to break, so "not serving" is a normal state for someone mid-experiment
and an unconditional healer would fight them:

- the box must have failed several consecutive probes, not one;
- no operation started by a _person_ may have run recently - the owner's hand on
  the box always takes precedence over ours. Operations the fleet started itself
  (a nightly snapshot, a forced floor update, an abuse suspension) do not count,
  which is what stops the fleet's own housekeeping from suppressing repair;
- the box's status must independently allow a repair, which already excludes a
  stopped, suspended, or mid-operation box;
- and a box may only be repaired automatically twice in a day. Past that it is a
  person's problem. Repair first reconciles the containers and checks the public
  endpoint. It only parks the files and rebuilds the host when that does not
  recover service, but an unbounded healer would still be an unbounded loop.
  Reaching that limit raises a critical staff alert - a box nobody is going to fix
  automatically must not also be a box nobody knows about.

The sweep probes every status a repair may begin from, not only `running`. That
matters most for `update_failed`: repairing a box whose update failed is how the
update is rolled back, because the box's recorded image only advances once the new
one has answered.

Every operation records a `trigger` naming who started it (`owner`, `staff`, or a
`system:` sweep), so a box's history distinguishes one the fleet started from one a
person asked for. Failures alert through the normal operation-failure path;
nothing is retried outside the window count above.

## The operation lock

A box runs one operation at a time. Everything else is refused with "This box is
busy with another operation", which is what keeps a reset from racing a repair -
and it means an operation that never finishes makes its box unusable for ever.

Three things keep that from happening, in order of how much they promise:

- the operation row and its workflow are created in **one transaction**, so an
  operation can never exist with nothing behind it;
- `finishBoxOperation` runs on every terminal outcome the workflow component
  reports - success, failure, or cancellation - so an operation is closed even
  when the workflow's own error handling never ran;
- `boxOperationSweep` checks anything still open past the grace period against the
  workflow component. It closes an operation only when the workflow is provably
  gone, never on elapsed time alone: a repair copies a whole disk twice and can
  legitimately run for hours.

An operation whose workflow is genuinely still running past the long-running
window is reported to staff rather than closed, because cancelling one mid-flight
is a judgement call about the box's files. **Cancel operation** on the box's
console page is the lever: it stops the workflow, then records the operation as
failed, leaving the box in the same status an ordinary failure would.

## Retained deleted data

Deletion removes secrets, live infrastructure references, snapshots, and
metrics. A minimized box tombstone, lifecycle summaries, and abuse flags remain
for 180 days for support, security, and claim handling. Paid billing evidence
remains for six calendar years for accounting; a specific dispute or legal hold
may extend one record. Account deletion pseudonymizes retained links and removes
the account tombstone once no retained record still refers to it.

Legal notice records - which notice went to which account, when, and what Resend
reported about it - are held for the same six years, from the day the notice was
sent rather than the day the box ended. They are not in the table above because
they carry no window of their own: they read the paid-billing constant, on the
argument that both are evidence held against a claim and the period that decides
either is the six years the Statute of Limitations 1957 allows a contract action
in Ireland. Account deletion replaces the address in one with a non-identifying
value and keeps the rest, so the tombstone outlives them and is removed only once
none is left.
