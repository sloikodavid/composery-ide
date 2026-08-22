---
title: Persistence
description: How Composery keeps your changes across restarts with the persistence daemon.
---

Composery is a container, but it should feel like a machine whose state survives
restarts. Persistence keeps only your changes to the image - your delta - on the `/data`
volume, and mounting one durable volume there is the only hard requirement for
[self-hosting](self-hosting/index.md). Two [engines](#engines) implement that, and which
one an instance runs changes nothing about the promise.

The delta model is what makes image upgrades safe: a new image ships new base contents,
your changes stay on top, and every file you never touched moves to the new version. See
[Updating](self-hosting/index.md#updating) for the procedure.

`/data` is owned by the normal `user` account and is the direct durable disk. Put
databases, object stores, large build artifacts, and other high-volume state there. Files
under `/data` occupy the volume once, under either engine. Files elsewhere behave like
ordinary machine files; under the copy engine a changed one occupies both the container's
writable layer and its delta copy, so a 10 GB changed file outside `/data` costs roughly
20 GB of host disk (the overlay engine stores it once). `df -h /data` shows the durable
disk's ordinary filesystem usage.

Composery ships Docker, already pointed at the volume. `/etc/docker/daemon.json` sets
`data-root` to `/data/docker`, and `/etc/containerd/config.toml` sets `root` to
`/data/containerd`. Both are needed: Docker Engine 29 and later keep images and container
snapshots under containerd, which `data-root` does not cover, so setting it alone would
move volumes and daemon state while leaving every image layer on the root filesystem.
There the layers cost you twice - under the overlay engine Docker cannot nest `overlay2`
and falls back to the slower `fuse-overlayfs`, and under the copy engine they are
churning, regenerable files the delta has no reason to carry. On the volume Docker and
containerd each get a native filesystem, and your images are stored once.

Docker needs `CAP_SYS_ADMIN`. It runs wherever the overlay engine runs, and on a platform
that cannot grant container privileges it stays down and says why in the container log
rather than restarting forever. `COMPOSERY_DISABLE_DOCKER` turns it off.

The volume must be a normal block-backed Linux filesystem (ext4, xfs, btrfs, or a Docker
named volume). Network filesystems such as NFS are not supported: persistence relies on
file locking, atomic renames, and xattrs that NFS does not reliably provide.

## Engines

Persistence has two engines behind one contract, selected by `COMPOSERY_PERSISTENCE`
(`auto` by default):

- **copy** - the universal engine, and the only one that works on managed PaaS that
  cannot grant container privileges (Render, Railway, Koyeb, and similar). A userspace
  daemon compares the live root filesystem against the image baseline and writes only your
  deltas to `/data/persistence`. Its observation cost is bounded by construction (see
  [Bounded observation](#bounded-observation)).
- **overlay** - a kernel-maintained engine that makes the root filesystem an overlayfs
  whose upper layer lives on the `/data` volume, so the kernel records the delta directly.
  It needs a privileged container (`CAP_SYS_ADMIN`), which means Composery Cloud, the
  `systemd` compose recipes, and any host you own; a managed platform that cannot grant
  privileges gets the copy engine. Because the kernel maintains the delta, there is no
  restore pass at boot and nothing to watch while you work.

What is identical across engines: one durable volume at `/data`, the same delta model, the
same image-upgrade promise (a new image ships a new baseline/lower, your changes stay on
top, every file you never touched moves to the new version), and the same integrity
boundary - the paths under [What persists](#what-persists) are never captured either way.
`auto` probes by attempting a real overlay mount on the `/data` volume and falls back to
copy on any failure; an explicit `COMPOSERY_PERSISTENCE=overlay` that cannot be satisfied
stops the container with the probe's own error rather than quietly running copy, and
`composery persistence status` always reports the selected engine and the reason.

What honestly differs:

|               | copy                                                                                        | overlay                                   |
| ------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Boot          | replays the delta before the editor starts, so a large delta costs boot time                | the kernel mounts it; nothing to replay   |
| While running | a daemon watches and copies changes; a change is durable within one audit interval at worst | every write is already in the upper layer |
| Disk          | a changed file outside `/data` occupies both the container layer and its delta copy         | one copy                                  |
| Deletions     | recorded as tombstones                                                                      | recorded as overlayfs whiteouts           |

One consequence is worth knowing about. Under either engine a file you delete stays
deleted across an upgrade, which is what you want - but an upgrade that reintroduces
content at a path you had deleted, or adds files inside a directory you had replaced
wholesale, has to decide between your change and the image's. Overlay reconciles this at
boot: a deletion whose file the new image genuinely changed is dropped so the new version
arrives, a deletion the image left alone is kept, and a directory you replaced is left
exactly as you left it and reported rather than silently reopened. The container log lists
what it reconciled on every boot.

## What persists

Persisted:

- regular files and directories;
- symlinks;
- hardlinks when the volume supports them;
- mode bits, ownership, and mtimes;
- xattrs, ACLs, and file capabilities, when supported by the kernel, mounted filesystem, and container privileges;
- FIFOs and device-node metadata, when supported by the mounted filesystem and container privileges;
- package manager state under paths such as `/usr`, `/etc`, and `/var/lib/dpkg`.

Always excluded because they are runtime state, container-managed files, or the
update-owned Composery implementation:

- `/data`;
- `/run`, `/var/run`, `/proc`, `/sys`, `/dev`, and `/tmp`;
- `/opt/persistence` and `/opt/composery`;
- resolver and hostname files: `/etc/hosts`, `/etc/hostname`, `/etc/resolv.conf`.

`/var/cache` is also excluded by default because it holds regenerable caches such as
downloaded apt archives. Unlike the integrity exclusions above, this is a default the image
ships rather than an unremovable rule: list it under `persist` in `config.json` to keep it,
and a future image can change the default set without rewriting your volume.

For the systemd profile, keep `/etc/systemd`, `/var/lib/systemd`, and `/etc/machine-id`
persisted. Those paths store enabled units, service state, and machine identity; excluding
them would make Composery feel less like a VPS after restart.

Unix sockets are runtime endpoints and are ignored even outside excluded directories. The
owning process must recreate them after restart.

When a regular file still has the same bytes as the image but only metadata has changed -
mode, owner, mtime, or xattrs - Composery stores the metadata delta without copying the
full file into `changed/`. This keeps a touched large image file from ballooning the
`/data` volume.

The active config lives at `/data/persistence/config.json`. A new file starts with a
removable `documentation` link, while its configurable values record only your intent,
never the built-in policy. Two symmetric arrays: `exclude` adds paths to the boundary, and
`persist` keeps a path the image excludes by default (it can never override an integrity
exclusion). A new config contains neither - the image owns the default set, so a future
image can change it - alongside an `audit` block and a `maxWatches` cap. The effective
exclusion set is the integrity set, plus the image defaults you did not `persist`, plus
whatever you `exclude`. A config written by an older build, with a single `exclusions`
array, keeps working unchanged: `exclusions` is read as `exclude`, so the paths you named
go on excluding what they always did. If the file is malformed or
contains an invalid value, it is preserved beside the original as `config.invalid-N.json`
and replaced with safe defaults, so a configuration typo cannot prevent the IDE from
starting. Storage or filesystem-integrity failures still stop boot rather than pretending
the durable state was applied.

## Bounded observation

The live inotify watcher is a latency optimisation, not the source of truth: the rolling
audit is the recovery floor. So the watcher's cost is capped by construction rather than
allowed to scale with the workload. It watches at most `maxWatches` directories (8192 by
default, tunable in `config.json`) and evicts the least-recently-active watch when full;
the dirty-change queue between the watcher and the writer is likewise bounded and sheds
under sustained pressure. Neither `/var/lib/docker` overlay churn nor a `node_modules`
storm can grow the daemon's memory. Anything not currently watched - trees past the budget,
or under a saturated queue - is still recovered by the next audit pass, at most one audit
interval later. Both the watcher and the audit also stop at mount boundaries: a bind-mounted
volume or a container runtime's overlay tree is runtime-managed, not part of the image, so
it is neither watched nor audited. `composery persistence status` reports the active watch
count, the budget, cumulative evictions, and whether the watcher has shed to audit-only.

## Commands

Inside the container:

```bash
sudo composery persistence status
sudo composery persistence status --json
sudo composery persistence doctor
sudo composery persistence prune
```

## Readiness

Readiness is exposed through `/run/persistence/ready` and `/_composery/healthz`.
If `composery persistence apply` fails during boot, the IDE does not become ready.

## Hostname

The hostname is set by your container runtime, not the image - it is one of the
Docker-managed files Composery cannot persist. Set a stable one through your orchestrator:
`docker run --hostname ...`, Compose `hostname:`, or the equivalent.
