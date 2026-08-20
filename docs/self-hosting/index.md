---
title: Self-hosting
description: Deploy Composery with one container, one persistent /data volume, and one HTTP edge.
---

Every Composery deployment is the same shape: **one container, one persistent volume at
`/data`, one HTTP edge.** [Persistence](../persistence.md) keeps the root filesystem's
changes on `/data`, so the only hard requirement is a writable disk mounted
there. Composery cannot externalize its state to a managed database, so platforms with an
ephemeral filesystem and no attachable disk are [not viable](#not-viable).

## Choose a target

Run on your own server, or on a managed platform that supplies the HTTPS edge and a disk:

- **[DigitalOcean](digitalocean.md)** - a Droplet with a compose recipe (the common n8n
  path), or DOKS. Not App Platform.
- **[Fly.io](fly.md)** - `fly.toml` with one volume.
- **[Render](render.md)** - `render.yaml` Blueprint with a persistent disk.
- **[Railway](railway.md)** - image service with a volume at `/data`.
- **[Koyeb](koyeb.md)** - image service with a volume at `/data`
  (single-instance regions).
- **[Other platforms](other-platforms.md)** - Coolify, Dokploy, CapRover, Northflank,
  Sliplane, PikaPods, Elestio, and any host that runs a container image with a volume at
  `/data`.
- **[VPS](vps.md)** - your own Linux server. Pick the init system
  (`systemd` or `supervisor`) and whether Composery owns its TLS edge (bundled Caddy or
  your own proxy).
- **[Kubernetes](kubernetes.md)** - one replica, a PVC at `/data`, Service, and Ingress.

## Not viable

Composery needs a persistent `/data` and cannot fall back to a managed database, so it is
**not** a fit for platforms whose container filesystem is ephemeral with no attachable disk:

- **Heroku** - dynos cycle daily and lose the filesystem.
- **DigitalOcean App Platform** - no volumes; local disk is ephemeral. Use a
  [Droplet](vps.md) or [DOKS](kubernetes.md) instead.
- **Google Cloud Run / App Engine** - stateless. Use a GCE VM.
- **AWS App Runner / ECS Fargate (default)** - stateless without EFS. Use EC2, or mount
  EFS at `/data` (advanced).
- **Azure Container Apps** - needs an Azure Files share mounted at `/data`, or use a VM.

## Maintenance

- **[Disk space](disk-space.md)** - remove unused Docker images and build cache, then
  reclaim space held by Docker Desktop's virtual disk on Windows and macOS.

## Updating

Composery ships as a single rolling image; there is no migration step to run on upgrade.
[Persistence](../persistence.md) lays your saved deltas over each new image's baseline, so
an upgrade keeps your state:

- your `/data` volume is never touched by an upgrade;
- files you changed keep your version;
- files you removed stay removed;
- every system file you never touched moves to the new image's version automatically.

Upgrade by pulling the new image and recreating the container from the same volume. With
Docker Compose:

```bash
docker compose pull
docker compose up -d
```

Other targets do the same thing their own way: redeploy or restart the service so it pulls
the new image while keeping the `/data` volume attached.

Choose how eagerly you take upgrades with the image tag:

- `ghcr.io/sloikodavid/composery:latest` - always the newest stable release (the default in
  every recipe here);
- `ghcr.io/sloikodavid/composery:0.1` - the latest patch of one minor line, with no surprise
  minor or major jumps;
- `ghcr.io/sloikodavid/composery:0.1.0` - an exact build that changes only when you change
  the tag.

Back up the `/data` volume before a major upgrade - your changes are stored as deltas
against the image baseline, so a volume backup is the clean way back if a major jump does
not suit you. See [Backing up the volume](#backing-up-the-volume) for how to copy it
without losing the delta.

The delta format is versioned per record, and a newer image reads everything
an older one wrote. An older image refuses a volume a newer one has written;
the message names the image that wrote the volume and a backup restore as the
way back. Keep the volume backup from before an upgrade if you might move an
image backwards.

## Backing up the volume

Copy the volume with a tool that preserves extended attributes, and copy it as root.

Under the overlay engine - the default anywhere the container is privileged, which includes
every recipe here that owns its host - the delta _is_ an overlayfs upper layer, so the
filesystem attributes are the data. Deletions are recorded as `0:0` character device nodes
and hidden directories as a `trusted.overlay.opaque` extended attribute. A copy that drops
those does not fail; it silently returns files you deleted and hides files the new image
ships. `cp -a`, `docker cp`, and a plain `tar` all drop them, and reading the `trusted.*`
namespace needs root in the first place.

Stop the container first so nothing is mid-write, then copy the volume's contents from the
host:

```bash
docker compose stop
sudo rsync -aHAXS --numeric-ids --delete \
  "$(docker volume inspect composery_data --format '{{ .Mountpoint }}')/" \
  ./composery-data-backup/
docker compose start
```

Those flags are the same set Composery uses internally to move an instance's files between hosts:
`-a` (recursive, symlinks, permissions, times, owner, devices), `-H` (hardlinks), `-A`
(ACLs), `-X` (all extended-attribute namespaces, including `trusted.*` when run as root),
`-S` (sparse files), and `--numeric-ids` (no uid/gid remapping).

Restore by copying it back the same way, into a stopped container's volume:

```bash
docker compose stop
sudo rsync -aHAXS --numeric-ids --delete \
  ./composery-data-backup/ \
  "$(docker volume inspect composery_data --format '{{ .Mountpoint }}')/"
docker compose start
```

On a managed platform that cannot grant container privileges you get the copy engine
instead, where the delta is ordinary files plus a JSON metadata sidecar and any faithful
file copy will do. Use the platform's own volume backup or snapshot feature; you have no
host to run the commands above on. See [Persistence](../persistence.md#engines) for which
engine a target gets, and `composery persistence status` for which one an instance chose.

## SSH

Composery runs an SSH service, so an instance works like an ordinary server - shell,
`scp`/`sftp`, `rsync`, tunnels, and your desktop editor's remote mode. See
[SSH](../ssh.md) for how access is granted and revoked.

sshd listens on port **22 inside the container** and reaches nothing until you publish it,
so leaving it enabled costs nothing until you decide otherwise. The compose recipes carry
the mapping commented out; `2222` on the host is the usual choice, because your own server
already uses 22.

```yaml
ports:
  - "2222:22"
```

Only keys are accepted - there is no password login to brute force. Set
`COMPOSERY_SSH_AUTHORIZED_KEYS` to your public key before the instance starts, or sign in
to the editor and append it to `~/.ssh/authorized_keys`. Those are separate files, so the
deployment's keys and your own can never overwrite each other.

Each instance generates its own host key on first boot and
[persistence](../persistence.md) keeps it, so a client's `known_hosts` entry stays valid
across restarts and upgrades.

`COMPOSERY_DISABLE_SSH` stops the service entirely.

## Hardening

Whatever target you pick, treat the browser password and reverse proxy as the security
boundary - Composery is intentionally root-capable inside the container:

- use HTTPS;
- register a strong password, or set `COMPOSERY_PASSWORD` /
  `COMPOSERY_HASHED_PASSWORD`
  (see [Configuration](../configuration.md));
- never leave `COMPOSERY_REMOVE_PASSWORD` set after you have registered a new password
  (see [Forgotten password](#forgotten-password)) - it reopens the instance on every
  restart;
- keep the image [updated](#updating);
- do not expose port `8080` directly when a public Caddy/nginx/Traefik edge terminates TLS;
- publish [SSH](#ssh) only when you want it, and keep it to keys you can account for;
- [back up](#backing-up-the-volume) the named Docker volume or the mounted `/data` disk
  before major upgrades.

## Forgotten password

Two ways back in, both through your target's environment variables. Neither needs the
volume.

**Prefer `COMPOSERY_PASSWORD`.** Set it and restart: it overrides the registered password
and keeps overriding it for as long as it stays set. The instance is never left open, so
there is no window to get wrong.

The other way removes the password instead, and it is the dangerous one.

### COMPOSERY_REMOVE_PASSWORD leaves your instance wide open

Set `COMPOSERY_REMOVE_PASSWORD=true` and restart, and the registered password is deleted. The
instance then behaves exactly like a brand new one: the next person to load the URL is
handed the "create password" screen. **That person does not have to be you.** Whoever
registers first owns the instance, and a Composery instance is a root-capable machine with
a terminal, your files, and your credentials on it.

It runs on **every boot while the variable is set**, not once. Each restart removes the
password again - including restarts you did not ask for, such as host reboots, platform
redeploys, and node migrations. An instance you believe you re-secured can be silently
returned to open weeks later.

Use it like this, and do not stop after step 2:

1. Set `COMPOSERY_REMOVE_PASSWORD=true` only when you can open the instance _right now_.
2. Restart, open it immediately, and register the new password.
3. **Set `COMPOSERY_REMOVE_PASSWORD=false` (or remove it entirely) and restart again.** Until
   you do, you are one restart away from an unprotected instance.

Only `1` and `true` turn it on, trimmed and case-insensitive. Every other value - `0`,
`false`, empty, or a typo - leaves the registered password alone, so a mistake fails
towards staying protected. The container logs a warning on every boot it is active, and a
separate note if `COMPOSERY_PASSWORD` is also set and still governs sign-in.
