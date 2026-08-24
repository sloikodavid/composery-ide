#!/usr/bin/env bash
# End-to-end proof for the overlay persistence engine.
#
# Builds the representative test image (tests/system/overlay/Dockerfile: Debian +
# systemd + the real rootfs/ tree + a real cargo-built composery binary) and boots
# real privileged containers on named volumes to prove, on a running system, what
# the unit tests can only claim in isolation:
#
#   1. auto selects overlay; systemd boots as PID 1 on an overlay root whose upper
#      is on the volume; docker stop shuts down cleanly (ExecStop marker on volume).
#   2. files created/modified/deleted (incl. /etc and /usr) survive a docker rm.
#   3. an image upgrade (new lower) lands while user edits win and new files appear.
#   4. upper hygiene reconciles a stale whiteout and reports an opaque directory.
#   5. DNS resolves inside the pivoted root (Hazard D: resolv.conf survives pivot).
#   6. unprivileged auto falls back to copy and boots; explicit overlay fails loudly
#      and does not boot; an unsupported value exits 64.
#
# Self-contained, standalone, self-cleaning. Everything it creates is prefixed
# "overlay-harness-" and the EXIT trap removes only those, never unrelated Docker
# resources on this host. Reuses one built image per fixture version across checks.
#
# No `-e`: a failing check is a verdict this harness has to record and carry to
# the summary at the end, not an error that aborts the run and hides the checks
# that would have followed it.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# The repository root, walked up to from HERE: this harness once sat two
# directories deep and "cd $HERE/../.." computed the root then, and silently
# pointed at tests/ after the tests/system/ move - grep found no Dockerfile,
# RUST_IMAGE came out empty, and every nightly failed on a blank base image
# name. git answers the question instead of a depth count that must be
# remembered: the harness always runs inside the checkout.
REPO="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO" ] || [ ! -f "$REPO/Dockerfile" ]; then
  echo "cannot find the repository root from $HERE" >&2
  exit 1
fi
# The build context and the -f Dockerfile are *host* paths, so on Git Bash / MSYS
# they have to reach Docker in Windows form - the daemon cannot resolve
# "/c/Users/...". The container-internal paths in the run flags must stay POSIX,
# which is why only these two convert and the script runs with
# MSYS_NO_PATHCONV=1. `cygpath -m` (forward slashes) avoids backslashes being
# eaten as escapes on the way through.
REPO_CONTEXT="$REPO"
DOCKERFILE="$HERE/Dockerfile"
if command -v cygpath >/dev/null 2>&1; then
  REPO_CONTEXT="$(cygpath -m "$REPO")"
  DOCKERFILE="$(cygpath -m "$DOCKERFILE")"
fi

PREFIX=overlay-harness
IMAGE_V1="${PREFIX}-fixture:v1"
IMAGE_V2="${PREFIX}-fixture:v2"
# One source of truth for the Rust toolchain: the cli-chef FROM line in the
# top-level Dockerfile (the same image the shipped binary is built with).
RUST_IMAGE="$(grep -oE 'rust:[^[:space:]]+' "$REPO/Dockerfile" | head -n1)"
# A blank extraction is a broken source, not a build problem: fail here, where
# the command is in view, rather than as a base-image error from inside BuildKit.
if ! printf '%s' "$RUST_IMAGE" | grep -qE '^rust:[0-9]+\.[0-9]+\.[0-9]+'; then
  echo "could not read the Rust build image from $REPO/Dockerfile (got '$RUST_IMAGE')" >&2
  exit 1
fi

FAILED=0
CHECK_FAILED=0

log()  { printf '\n=== %s ===\n' "$*"; }
pass() { printf '  [PASS] %s\n' "$*"; }
fail() { printf '  [FAIL] %s\n' "$*"; FAILED=1; CHECK_FAILED=1; }
note() { printf '  [ .. ] %s\n' "$*"; }

# Isolate the docker client config: some hosts (Docker Desktop + WSL) inject a
# credential helper that breaks anonymous pulls of public base images. A throwaway
# empty config sidesteps it without touching the operator's real ~/.docker.
if [ -z "${DOCKER_CONFIG:-}" ]; then
  DOCKER_CONFIG="$(mktemp -d)"
  printf '{}\n' >"$DOCKER_CONFIG/config.json"
  export DOCKER_CONFIG
fi

cleanup() {
  docker ps -aq --filter "name=^${PREFIX}-" | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker volume ls -q --filter "name=^${PREFIX}-" | xargs -r docker volume rm -f >/dev/null 2>&1 || true
  docker rmi -f "$IMAGE_V1" "$IMAGE_V2" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Production runtime flags, mirroring renderCompose() in
# packages/web/convex/boxes/infra/artifacts.ts.
PROD_FLAGS=(
  --privileged
  --cgroupns=host
  --stop-signal SIGRTMIN+3
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw
  --tmpfs /run
  --tmpfs /run/lock
  --tmpfs /tmp
)

fresh_volume() {
  docker volume rm "$1" >/dev/null 2>&1 || true
  docker volume create "$1" >/dev/null
}

# Boot the given image on the given volume, privileged, systemd init (production).
boot_overlay() {
  local name="$1" image="$2" vol="$3"
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" "${PROD_FLAGS[@]}" \
    -v "$vol:/data" -e COMPOSERY_INIT=systemd "$image" >/dev/null
}

wait_system() { # $1=name -> echoes running|degraded|TIMEOUT
  local s=""
  local i
  for i in $(seq 1 60); do
    s="$(docker exec "$1" systemctl is-system-running 2>/dev/null || true)"
    case "$s" in running | degraded) echo "$s"; return 0 ;; esac
    sleep 1
  done
  echo "TIMEOUT"
  return 1
}

status_of() { docker exec "$1" /opt/composery/bin/composery persistence status 2>/dev/null; }

wait_status() { # wait until persistence status answers with an engine line
  local i
  for i in $(seq 1 60); do
    status_of "$1" | grep -q '  engine:' && return 0
    sleep 1
  done
  return 1
}

# Read a path from a volume via a throwaway container (used after a container is
# removed). $3 is printed if the path is absent.
volume_read() {
  docker run --rm -v "$1:/data" --entrypoint sh "$IMAGE_V1" \
    -c "cat '$2' 2>/dev/null || echo '${3:-ABSENT}'"
}

dump_logs() { docker logs --tail 40 "$1" 2>&1 | sed 's/^/    log: /'; }

# ---------------------------------------------------------------------------

check1_boot_and_shutdown() {
  CHECK_FAILED=0
  log "Check 1: auto->overlay, systemd PID 1 on overlay root, clean shutdown"
  local name="${PREFIX}-c1" vol="${PREFIX}-c1"
  fresh_volume "$vol"
  boot_overlay "$name" "$IMAGE_V1" "$vol" || { fail "container did not start"; return; }

  local sys; sys="$(wait_system "$name")"
  case "$sys" in
    running | degraded) pass "systemd reached '$sys' (degraded is normal in a container)" ;;
    *) fail "systemd never reached running/degraded"; dump_logs "$name"; return ;;
  esac

  local pid1; pid1="$(docker exec "$name" ps -o comm= -p 1 2>/dev/null | tr -d '[:space:]')"
  [ "$pid1" = systemd ] && pass "PID 1 is systemd" || fail "PID 1 is '$pid1', not systemd"

  local jd; jd="$(docker exec "$name" systemctl is-active systemd-journald 2>/dev/null || true)"
  [ "$jd" = active ] && pass "journald active" || fail "journald not active ($jd)"

  local ua; ua="$(docker exec "$name" systemctl is-active persistence.service 2>/dev/null || true)"
  [ "$ua" = active ] && pass "persistence.service active" || fail "persistence.service not active ($ua)"

  local root; root="$(docker exec "$name" findmnt -no SOURCE,FSTYPE / 2>/dev/null)"
  echo "$root" | grep -q 'overlay' && pass "root is an overlay mount ($root)" || fail "root is not overlay: $root"

  # Upper on the volume, and it is the overlay's upperdir (proven structurally by
  # the reserved-subtree layout the hygiene command prints).
  if docker exec "$name" test -d /data/persistence/overlay/upper; then
    pass "overlay upper exists on the /data volume"
  else
    fail "overlay upper dir missing on the volume"
  fi
  local opts; opts="$(docker exec "$name" findmnt -no OPTIONS / 2>/dev/null)"
  echo "$opts" | grep -q '/data/persistence/overlay/upper' \
    && pass "root overlay upperdir= is on the volume" \
    || note "upperdir not shown in mount options (kernel may hide it): $opts"

  if wait_status "$name"; then
    local st; st="$(status_of "$name")"
    echo "$st" | sed 's/^/    /'
    echo "$st" | grep -q 'engine: overlay' && pass "persistence status reports engine overlay" || fail "status engine not overlay"
    echo "$st" | grep -q 'standing down' && pass "copy daemon is standing down (kernel owns the delta)" || note "no stand-down line in status"
  else
    fail "persistence status never answered"
    dump_logs "$name"
  fi

  # Install a oneshot whose ExecStop writes a marker to the volume. It can only
  # appear if systemd ran an orderly shutdown (SIGKILL would skip ExecStop).
  docker exec "$name" bash -c '
cat >/etc/systemd/system/harness-marker.service <<UNIT
[Unit]
Description=overlay-harness shutdown marker
DefaultDependencies=no
Before=shutdown.target umount.target
Conflicts=shutdown.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/true
ExecStop=/bin/sh -c "echo clean-stop > /data/harness-execstop.marker"
UNIT
systemctl daemon-reload
systemctl start harness-marker.service
' >/dev/null 2>&1 || note "could not install shutdown-marker unit"

  local t0 t1; t0="$(date +%s)"
  docker stop -t 30 "$name" >/dev/null 2>&1
  t1="$(date +%s)"
  local code; code="$(docker inspect -f '{{.State.ExitCode}}' "$name" 2>/dev/null)"
  local marker; marker="$(volume_read "$vol" /data/harness-execstop.marker ABSENT)"
  note "docker stop took $((t1 - t0))s; container exit code $code (130 = systemd container poweroff)"
  [ "$marker" = clean-stop ] \
    && pass "ExecStop marker present on volume -> systemd ran an orderly shutdown" \
    || fail "ExecStop marker absent ($marker) -> shutdown was not orderly"

  docker rm -f "$name" >/dev/null 2>&1 || true
  [ "$CHECK_FAILED" -eq 0 ] && echo "  VERDICT: PASS" || echo "  VERDICT: FAIL"
}

check2_persistence_across_recreate() {
  CHECK_FAILED=0
  log "Check 2: create/modify/delete survive a docker rm (incl. /etc and /usr)"
  local name="${PREFIX}-c2" vol="${PREFIX}-c2"
  fresh_volume "$vol"
  boot_overlay "$name" "$IMAGE_V1" "$vol" || { fail "container did not start"; return; }
  [ "$(wait_system "$name")" != TIMEOUT ] || { fail "systemd did not boot"; dump_logs "$name"; return; }
  wait_status "$name" || note "status slow to answer"

  docker exec "$name" bash -c '
    set -e
    echo "created" > /etc/harness-created.conf
    mkdir -p /usr/local/harness && echo "usr-created" > /usr/local/harness/file
    echo "user-modified" > /etc/composery-test-marker      # exists in the image lower
    rm -f /etc/composery-edit                              # delete an image file -> whiteout
  ' || { fail "could not mutate the rootfs"; return; }

  # A whiteout should now exist in the upper for the deleted image file.
  local wtype; wtype="$(docker exec "$name" stat -c '%F' /data/persistence/overlay/upper/etc/composery-edit 2>/dev/null || echo none)"
  echo "$wtype" | grep -qi 'character special' \
    && pass "deletion recorded as an overlay whiteout in the upper ($wtype)" \
    || note "deleted file not a char-device whiteout in upper ($wtype)"

  docker stop -t 30 "$name" >/dev/null 2>&1
  docker rm -f "$name" >/dev/null 2>&1 || true

  # Recreate on the same volume.
  boot_overlay "$name" "$IMAGE_V1" "$vol" || { fail "recreate did not start"; return; }
  [ "$(wait_system "$name")" != TIMEOUT ] || { fail "systemd did not boot on recreate"; dump_logs "$name"; return; }

  local v
  v="$(docker exec "$name" cat /etc/harness-created.conf 2>/dev/null || echo MISSING)"
  [ "$v" = created ] && pass "created /etc file survived recreate" || fail "created /etc file lost ($v)"
  v="$(docker exec "$name" cat /usr/local/harness/file 2>/dev/null || echo MISSING)"
  [ "$v" = usr-created ] && pass "created /usr file survived recreate" || fail "created /usr file lost ($v)"
  v="$(docker exec "$name" cat /etc/composery-test-marker 2>/dev/null || echo MISSING)"
  [ "$v" = user-modified ] && pass "modified image file kept user content" || fail "modification lost ($v)"
  if docker exec "$name" test -e /etc/composery-edit; then
    fail "deleted image file came back (whiteout not persisted)"
  else
    pass "deleted image file stayed deleted (whiteout survived)"
  fi
  v="$(docker exec "$name" cat /etc/composery-hygiene-same 2>/dev/null || echo MISSING)"
  [ "$v" = constant ] && pass "untouched image file still served from the lower" || fail "untouched image file wrong ($v)"

  docker rm -f "$name" >/dev/null 2>&1 || true
  [ "$CHECK_FAILED" -eq 0 ] && echo "  VERDICT: PASS" || echo "  VERDICT: FAIL"
}

check3_upgrade() {
  CHECK_FAILED=0
  log "Check 3: image upgrade (new lower on the same upper)"
  local name="${PREFIX}-c3" vol="${PREFIX}-c3"
  fresh_volume "$vol"
  boot_overlay "$name" "$IMAGE_V1" "$vol" || { fail "v1 did not start"; return; }
  [ "$(wait_system "$name")" != TIMEOUT ] || { fail "v1 systemd did not boot"; dump_logs "$name"; return; }
  wait_status "$name" || note "status slow to answer"

  docker exec "$name" bash -c '
    set -e
    echo "mine" > /etc/composery-edit          # user edits a file both images ship
    echo "user-file" > /etc/harness-user-file   # brand-new user file
  ' || { fail "could not mutate v1"; return; }
  docker stop -t 30 "$name" >/dev/null 2>&1
  docker rm -f "$name" >/dev/null 2>&1 || true

  # Boot v2 (changed lower) on v1's upper.
  boot_overlay "$name" "$IMAGE_V2" "$vol" || { fail "v2 did not start"; return; }
  [ "$(wait_system "$name")" != TIMEOUT ] || { fail "v2 systemd did not boot"; dump_logs "$name"; return; }

  local v
  v="$(docker exec "$name" cat /etc/composery-test-marker 2>/dev/null || echo MISSING)"
  [ "$v" = v2 ] && pass "untouched image file moved to v2 (new lower wins)" || fail "untouched file not upgraded ($v)"
  v="$(docker exec "$name" cat /etc/composery-edit 2>/dev/null || echo MISSING)"
  [ "$v" = mine ] && pass "user edit won over the new lower" || fail "user edit lost on upgrade ($v)"
  v="$(docker exec "$name" cat /etc/composery-only-v2 2>/dev/null || echo MISSING)"
  [ "$v" = v2-only ] && pass "brand-new v2 lower file appeared" || fail "new v2 file missing ($v)"
  v="$(docker exec "$name" cat /etc/harness-user-file 2>/dev/null || echo MISSING)"
  [ "$v" = user-file ] && pass "user-created file survived the upgrade" || fail "user file lost on upgrade ($v)"

  docker rm -f "$name" >/dev/null 2>&1 || true
  [ "$CHECK_FAILED" -eq 0 ] && echo "  VERDICT: PASS" || echo "  VERDICT: FAIL"
}

check4_upper_hygiene() {
  CHECK_FAILED=0
  log "Check 4: upper hygiene reconciles a stale whiteout, reports an opaque dir"
  local name="${PREFIX}-c4" vol="${PREFIX}-c4"
  fresh_volume "$vol"
  boot_overlay "$name" "$IMAGE_V1" "$vol" || { fail "v1 did not start"; return; }
  [ "$(wait_system "$name")" != TIMEOUT ] || { fail "v1 systemd did not boot"; dump_logs "$name"; return; }
  wait_status "$name" || note "status slow to answer"

  # Construct the two hazards against the v1 lower:
  #  - whiteout over composery-hygiene-changed (v2 changes it  -> should be DROPPED)
  #  - whiteout over composery-hygiene-same    (v2 unchanged    -> should be KEPT)
  #  - opaque dir over composery-hygiene-dir   (v2 adds c-new   -> should be REPORTED)
  docker exec "$name" bash -c '
    set -e
    rm -f /etc/composery-hygiene-changed
    rm -f /etc/composery-hygiene-same
    rm -rf /etc/composery-hygiene-dir
    mkdir /etc/composery-hygiene-dir
    echo "mine" > /etc/composery-hygiene-dir/user
  ' || { fail "could not construct hazards on v1"; return; }
  docker stop -t 30 "$name" >/dev/null 2>&1
  docker rm -f "$name" >/dev/null 2>&1 || true

  # Boot v2: the hygiene pass runs before the mount.
  boot_overlay "$name" "$IMAGE_V2" "$vol" || { fail "v2 did not start"; return; }
  [ "$(wait_system "$name")" != TIMEOUT ] || { fail "v2 systemd did not boot"; dump_logs "$name"; return; }
  wait_status "$name" || note "status slow to answer"

  local report; report="$(docker logs "$name" 2>&1 | grep -F '[overlay-hygiene]' || true)"
  echo "$report" | sed 's/^/    /'

  echo "$report" | grep -q 'previousBaseline=true' \
    && pass "hygiene had the previous baseline (upgrade, not first boot)" \
    || fail "hygiene ran without a previous baseline"

  # Changed whiteout dropped -> v2 content delivered.
  local v; v="$(docker exec "$name" cat /etc/composery-hygiene-changed 2>/dev/null || echo MISSING)"
  [ "$v" = v2 ] && pass "stale whiteout over a CHANGED file dropped; v2 content delivered" \
    || fail "changed-file whiteout not reconciled ($v)"
  echo "$report" | grep -Eq 'changed=[1-9]' && pass "report counts the dropped changed whiteout" || note "changed-drop count not visible in report"

  # Same-content whiteout kept -> deletion still valid.
  if docker exec "$name" test -e /etc/composery-hygiene-same; then
    fail "whiteout over an UNCHANGED file was resurrected (upgrade promise broken)"
  else
    pass "whiteout over an UNCHANGED file kept; valid deletion preserved"
  fi
  echo "$report" | grep -Eq 'kept=[1-9]' && pass "report counts the kept whiteout" || note "kept count not visible in report"

  # Opaque dir reported, not rewritten: v2's new entry stays hidden, user entry stays.
  echo "$report" | grep -Eq 'opaqueDirs=[1-9]' && pass "opaque directory detected and reported" || fail "opaque dir not reported"
  echo "$report" | grep -Eq 'shadowing=[1-9]' && pass "report flags the opaque dir as shadowing new-image entries" || fail "opaque shadowing not reported"
  if docker exec "$name" test -e /etc/composery-hygiene-dir/c; then
    fail "opaque dir was silently rewritten (engine must only report it)"
  else
    pass "opaque dir left intact: v2's new entry stays hidden (reported, not modified)"
  fi
  v="$(docker exec "$name" cat /etc/composery-hygiene-dir/user 2>/dev/null || echo MISSING)"
  [ "$v" = mine ] && pass "user's replacement directory content intact" || fail "user dir content lost ($v)"

  docker rm -f "$name" >/dev/null 2>&1 || true
  [ "$CHECK_FAILED" -eq 0 ] && echo "  VERDICT: PASS" || echo "  VERDICT: FAIL"
}

check5_dns_after_pivot() {
  CHECK_FAILED=0
  log "Check 5: DNS works inside the pivoted overlay root (Hazard D)"
  local name="${PREFIX}-c5" vol="${PREFIX}-c5"
  fresh_volume "$vol"
  boot_overlay "$name" "$IMAGE_V1" "$vol" || { fail "container did not start"; return; }
  [ "$(wait_system "$name")" != TIMEOUT ] || { fail "systemd did not boot"; dump_logs "$name"; return; }

  local resolv; resolv="$(docker exec "$name" cat /etc/resolv.conf 2>/dev/null || true)"
  echo "$resolv" | sed 's/^/    resolv.conf: /'
  if echo "$resolv" | grep -Eq '^[[:space:]]*nameserver[[:space:]]+[^[:space:]]+'; then
    pass "/etc/resolv.conf carries a real nameserver after the pivot"
  else
    fail "/etc/resolv.conf has no nameserver after the pivot (DNS bind lost)"
  fi

  if docker exec "$name" getent hosts deb.debian.org >/dev/null 2>&1; then
    pass "name resolution works inside the pivoted root"
  else
    fail "name resolution failed inside the pivoted root (if this host has no egress, treat as environmental)"
  fi

  docker rm -f "$name" >/dev/null 2>&1 || true
  [ "$CHECK_FAILED" -eq 0 ] && echo "  VERDICT: PASS" || echo "  VERDICT: FAIL"
}

check6_fallback() {
  CHECK_FAILED=0
  log "Check 6: unprivileged fallback and loud failures"
  local vol="${PREFIX}-c6"

  # 6a: unprivileged auto -> copy, and it boots (supervisor init, the PaaS floor).
  local name="${PREFIX}-c6a"
  fresh_volume "$vol"
  docker rm -f "$name" >/dev/null 2>&1 || true
  if docker run -d --name "$name" -v "$vol:/data" -e COMPOSERY_INIT=supervisor "$IMAGE_V1" >/dev/null; then
    local i st=""
    for i in $(seq 1 60); do
      st="$(status_of "$name")" && echo "$st" | grep -q '  engine:' && break
      docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null | grep -q true || break
      sleep 1
    done
    echo "$st" | grep -q 'engine: copy' && pass "unprivileged auto selected copy and booted" \
      || { fail "unprivileged auto did not report engine copy"; echo "$st" | sed 's/^/    /'; dump_logs "$name"; }
  else
    fail "unprivileged auto container did not start"
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true

  # 6b: unprivileged explicit overlay -> fails loudly, does not boot.
  name="${PREFIX}-c6b"
  fresh_volume "$vol"
  docker rm -f "$name" >/dev/null 2>&1 || true
  local out code
  out="$(docker run --name "$name" -v "$vol:/data" -e COMPOSERY_PERSISTENCE=overlay "$IMAGE_V1" 2>&1)"
  code="$(docker inspect -f '{{.State.ExitCode}}' "$name" 2>/dev/null)"
  echo "$out" | tail -n 5 | sed 's/^/    /'
  if [ "$code" != 0 ] && echo "$out" | grep -Eqi 'overlay (probe failed|engine is not available|was requested)'; then
    pass "explicit overlay unprivileged failed loudly (exit $code) and did not boot"
  else
    fail "explicit overlay unprivileged did not fail loudly (exit $code)"
  fi
  # It must not have reached systemd / a stand-down daemon.
  echo "$out" | grep -q 'pivot complete' && fail "explicit overlay reached the pivot before failing" || pass "boot aborted before any overlay mount/pivot"
  docker rm -f "$name" >/dev/null 2>&1 || true

  # 6c: an unsupported value exits 64.
  name="${PREFIX}-c6c"
  fresh_volume "$vol"
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run --name "$name" -v "$vol:/data" -e COMPOSERY_PERSISTENCE=nonsense "$IMAGE_V1" >/dev/null 2>&1
  code="$(docker inspect -f '{{.State.ExitCode}}' "$name" 2>/dev/null)"
  [ "$code" = 64 ] && pass "unsupported COMPOSERY_PERSISTENCE exits 64" || fail "unsupported value exit code was $code, expected 64"
  docker rm -f "$name" >/dev/null 2>&1 || true

  [ "$CHECK_FAILED" -eq 0 ] && echo "  VERDICT: PASS" || echo "  VERDICT: FAIL"
}

# ---------------------------------------------------------------------------

log "Building the test image (RUST_IMAGE=$RUST_IMAGE)"
docker build -f "$DOCKERFILE" \
  --build-arg "RUST_IMAGE=$RUST_IMAGE" --build-arg FIXTURE_VERSION=1 \
  -t "$IMAGE_V1" "$REPO_CONTEXT" || { echo "image build (v1) failed"; exit 1; }
docker build -f "$DOCKERFILE" \
  --build-arg "RUST_IMAGE=$RUST_IMAGE" --build-arg FIXTURE_VERSION=2 \
  -t "$IMAGE_V2" "$REPO_CONTEXT" || { echo "image build (v2) failed"; exit 1; }
echo "built $IMAGE_V1 and $IMAGE_V2"

check1_boot_and_shutdown
check2_persistence_across_recreate
check3_upgrade
check4_upper_hygiene
check5_dns_after_pivot
check6_fallback

log "SUMMARY"
if [ "$FAILED" -eq 0 ]; then
  echo "ALL CHECKS PASSED - the overlay engine is proven end to end."
  exit 0
else
  echo "ONE OR MORE CHECKS FAILED - see the per-check verdicts above."
  exit 1
fi
