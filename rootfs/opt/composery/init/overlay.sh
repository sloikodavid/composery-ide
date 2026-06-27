#!/usr/bin/env bash
# Overlay persistence engine boot. Builds an overlayfs root whose upper lives on
# the /data volume, so the kernel maintains the rootfs delta the copy daemon
# maintains in userspace, then pivot_roots into it and hands back to the shared
# entrypoint tail. Reached only when `persistence select-engine` chose `overlay`
# - i.e. a real overlay mount on /data already succeeded in the probe - so a
# mount failure here is a genuine fault that stops the boot loudly rather than
# silently falling back to copy. See spike/FINDINGS.md and docs/persistence.md.
set -euo pipefail

log() { printf '[overlay-engine] %s\n' "$*" >&2; }

DATA="${COMPOSERY_DOCKER_VOLUME_PATH:-/data}"
# Scratch mountpoint for the merged tree. Deliberately NOT under any filesystem
# we move (/proc /sys /dev /run /tmp /data): a recursive bind of /run into the
# merged tree would otherwise swallow this scratch. It is a fresh tmpfs, dropped
# at pivot.
SCRATCH=/mnt/composery-overlay
MERGED="$SCRATCH/merged"

# The upper-hygiene pass and reserved-subtree prep live in Rust (xattr reads,
# baseline diffing, real tests). It creates upper/, recreates a fresh work/ (a
# hard-killed container leaves it dirty), reconciles stale whiteouts and reports
# opaque directories against the image baselines, and prints the upperdir/workdir
# to mount - the single source of truth for those reserved paths.
hygiene="$(/opt/composery/bin/composery persistence overlay-hygiene)"
UPPER="$(printf '%s\n' "$hygiene" | sed -n 's/^upperdir=//p')"
WORK="$(printf '%s\n' "$hygiene" | sed -n 's/^workdir=//p')"
if [ -z "$UPPER" ] || [ -z "$WORK" ]; then
  log "overlay-hygiene did not report the reserved mount paths; refusing to mount."
  exit 1
fi

# Private propagation: keeps our mount moves from escaping to the host and
# satisfies pivot_root's "root not shared" requirement.
mount --make-rprivate /

# Scratch tmpfs for the merged mountpoint, off both the image rw layer and the
# persistent upper.
mkdir -p "$SCRATCH"
mount -t tmpfs tmpfs "$SCRATCH"
mkdir -p "$MERGED"

log "mount overlay: lower=/ upper=$UPPER work=$WORK -> $MERGED"
# Take the mount's own status, deliberately not `if ! mount ...; then rc=$?`:
# there `$?` is the status of the negation, which is 0, so a failed mount would
# exit 0 and report a successful boot for a root that was never overlaid. Keep
# this shape.
set +e
err="$(mount -t overlay composery-overlay \
  -o "lowerdir=/,upperdir=$UPPER,workdir=$WORK" "$MERGED" 2>&1)"
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  log "OVERLAY MOUNT FAILED (rc=$rc): $err"
  log "select-engine's probe succeeded, so this is a real fault, not a fallback."
  exit "$((rc == 0 ? 1 : rc))"
fi

# The overlay lower is the image rootfs as a plain tree: mounts stacked on / -
# proc, sys (carrying cgroup), dev, run, tmp, and the /data volume - are
# invisible through it. Move them into the merged tree before pivoting.
for m in /proc /sys /dev /run /tmp "$DATA"; do
  mkdir -p "$MERGED$m"
done
mount --rbind /proc "$MERGED/proc"
mount --rbind /sys "$MERGED/sys"
mount --rbind /dev "$MERGED/dev"
mount --rbind /run "$MERGED/run"
mount --rbind /tmp "$MERGED/tmp"
mount --rbind "$DATA" "$MERGED$DATA" # durable volume; the upper is a subtree of it

# Keep the update-owned Composery code out of the persisted delta. Under the copy
# engine these are integrity exclusions; under overlay the equivalent guarantee
# is structural - bind the image's own copies over the merged tree so any write
# lands on the ephemeral container layer, never the volume upper, and the image
# always governs them on upgrade. (The reserved upper subtree itself is already
# out of the delta: it lives on the separately-mounted /data volume, so it is
# never part of the overlay lower and cannot be captured into the upper.)
for d in /opt/composery /opt/persistence; do
  if [ -d "$d" ]; then
    mount --bind "$d" "$MERGED$d"
  fi
done

# The container runtime injects /etc/resolv.conf, /etc/hosts and /etc/hostname as
# individual FILE bind mounts on the old root. They are invisible through the
# overlay lower (which sees only the image's empty copies), so without rebinding
# them the pivoted system has NO DNS and no hostname at all (Hazard D) - inner
# Docker and the user could not reach any registry. These are exactly the
# runtime-managed files persistence never owns.
for f in /etc/resolv.conf /etc/hosts /etc/hostname; do
  if mountpoint -q "$f" 2>/dev/null || [ -s "$f" ]; then
    [ -e "$MERGED$f" ] || : >"$MERGED$f"
    mount --bind "$f" "$MERGED$f"
  fi
done

# Pivot into the merged overlay and detach the old container root.
mkdir -p "$MERGED/mnt/oldroot"
cd "$MERGED"
pivot_root . mnt/oldroot
cd /
mount --make-rprivate /mnt/oldroot 2>/dev/null || true
umount -l /mnt/oldroot || true

log "pivot complete; root is the overlay. Running the shared boot tail."
export COMPOSERY_OVERLAY_STAGE=finalize
exec /opt/composery/entrypoint.sh
