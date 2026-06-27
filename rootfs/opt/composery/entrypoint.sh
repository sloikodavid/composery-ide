#!/usr/bin/env bash
set -euo pipefail

# Caddy owns the public port and reverse-proxies the IDE on the loopback one.
# Equal values leave the two fighting over one bind in a restart loop.
if [ "${PORT:-8080}" = "${COMPOSERY_IDE_PORT:-8081}" ]; then
  printf 'PORT and COMPOSERY_IDE_PORT are both %s; they must differ.\n' "${PORT:-8080}" >&2
  exit 78
fi

# finalize(): the engine-independent boot tail. It runs once the rootfs delta is
# live - replayed by `persistence apply` under the copy engine, or mounted by
# the kernel under the overlay engine - so it is identical for both engines and
# both init profiles. Under overlay, init/overlay.sh pivots into the merged root
# and re-execs this script back into the stage guard below to reach finalize.
finalize() {
  # First, and before either init system can start sshd. A disk copied from
  # another instance still holds that instance's SSH certificate authority, host
  # keys and API keys, so anything that accepts a connection before this has run
  # accepts it under the wrong machine's credentials. It is also before the
  # machine-id block below, which is what regenerates the id this truncates.
  /opt/composery/identity.sh apply

  if [ ! -s /etc/machine-id ]; then
    tr -d '-' < /proc/sys/kernel/random/uuid > /etc/machine-id
  fi

  # The durable volume is a normal user-owned disk. Persistence keeps its own
  # root-owned subdirectory, while applications can place large state directly
  # on the volume without duplicating it into the rootfs delta store.
  volume_root="${COMPOSERY_DOCKER_VOLUME_PATH:-/data}"
  chown user:user "$volume_root"
  chmod 0755 "$volume_root"
  install -d -m 0700 -o user -g user "$volume_root/api"

  # Sharing a device with / means nothing is mounted here, so persistence would
  # write the delta into the container layer and lose it on the next recreate.
  # Comparing devices rather than mountpoints keeps a subdirectory of a mount
  # (a volume on /mnt with the root at /mnt/data) correct. A warning, not a
  # failure: running with no volume at all is a legitimate way to try Composery.
  if [ "$(stat -c %d "$volume_root")" = "$(stat -c %d /)" ]; then
    printf 'Warning: no volume is mounted at %s, so changes will be lost when this container is recreated. Mount a volume or disk there, or point COMPOSERY_DOCKER_VOLUME_PATH at one.\n' "$volume_root" >&2
  fi

  # After the delta is live, or a restored/overlaid delta would put the password back.
  /opt/composery/remove-password.sh

  # Deployment-supplied SSH keys are written here rather than by the service,
  # because this value is an authorized_keys file and therefore multi-line. The
  # systemd profile bridges settings to its units through the `env | grep` file
  # built below, which keeps only a value's first line - so reading it there would
  # honour one key under systemd and all of them under supervisor.
  /opt/composery/ssh.sh install-keys


  case "${COMPOSERY_INIT:-supervisor}" in
    supervisor)
      exec /opt/composery/init/supervisor.sh
      ;;
    systemd)
      # systemd (PID 1) starts services with a clean env, so bridge the IDE's
      # settings through a file its unit reads (/run is tmpfs, never persisted).
      ( umask 077
        env | grep -E '^(PORT|BROWSER|EDITOR|VISUAL|GIT_EDITOR|KUBE_EDITOR|LANG|LC_ALL|PATH|XDG_RUNTIME_DIR|HTTPS?_PROXY|https?_proxy)=|^COMPOSERY_' > /run/composery.env ) || true
      exec /opt/composery/init/systemd.sh
      ;;
    *)
      printf 'Unsupported COMPOSERY_INIT: %s (expected "supervisor" or "systemd")\n' "${COMPOSERY_INIT:-}" >&2
      exit 64
      ;;
  esac
}

# Overlay re-entry: after init/overlay.sh builds the overlay and pivot_roots into
# the merged tree, it re-execs this script inside the new root with this marker,
# landing here to run the shared finalize tail. A clean re-exec is safer than
# continuing to run a script across pivot_root, and reuses one copy of the tail.
if [ "${COMPOSERY_OVERLAY_STAGE:-}" = finalize ]; then
  unset COMPOSERY_OVERLAY_STAGE
  finalize
fi

# Pick the persistence engine. Mirrors COMPOSERY_INIT exactly: auto (default),
# overlay, or copy; an unsupported value is a clear message + exit 64. See
# docs/persistence.md and docs/configuration.md.
case "${COMPOSERY_PERSISTENCE:-auto}" in
  auto | overlay | copy) ;;
  *)
    printf 'Unsupported COMPOSERY_PERSISTENCE: %s (expected "auto", "overlay", or "copy")\n' "${COMPOSERY_PERSISTENCE:-}" >&2
    exit 64
    ;;
esac

# select-engine probes by *doing* (a real overlay mount on the /data volume for
# auto), records the choice and reason where `persistence status` reports them,
# and prints the engine. It exits non-zero - failing boot loudly, never a silent
# fallback - when an explicit overlay pin cannot be honoured.
engine="$(/opt/composery/bin/composery persistence select-engine)"

if [ "$engine" = overlay ]; then
  # Overlay engine: the kernel maintains the rootfs delta. init/overlay.sh runs
  # the upper-hygiene pass, builds the overlay (lower = image rootfs, upper+work
  # in the reserved subtree of the /data volume), moves the kernel filesystems
  # and the volume in, rebinds the resolver files (Hazard D: no DNS otherwise),
  # pivot_roots, then re-execs this script's finalize tail inside the merged root.
  exec /opt/composery/init/overlay.sh
fi

# Copy engine: replay the persisted delta over the image rootfs, then finalize.
/opt/composery/bin/composery persistence apply
finalize
