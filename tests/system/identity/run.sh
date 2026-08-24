#!/usr/bin/env bash
# End-to-end proof for instance-identity rotation.
#
# The question this harness exists to answer is not "does rotation work" - a unit
# test over a declared list can claim that. It is **"is the declared list
# complete"**, which no test over that same list can ever answer: both would be
# reading the one belief. So completeness is derived from behaviour instead.
#
#   1. INVENTORY. Two containers boot from one image onto two fresh volumes,
#      neither given a cloud box id. Anything that differs between two
#      independent first boots is, by construction, instance identity - it was
#      generated on the machine rather than shipped in the image. Every such path
#      must be named by `identity.sh paths`, or this check fails. That is what
#      stops the inventory rotting as future releases add an identity-bearing
#      file nobody remembers to add to the list.
#   2. ROTATION. A volume from box-a is copied and booted as box-b, which is
#      exactly what Duplicate does. Every path in the inventory must have changed,
#      and - the part that actually matters - a certificate issued by the source's
#      CA must no longer verify against the copy's.
#   3. STABILITY. The same box id across a restart rotates nothing, or every
#      ordinary reboot would invalidate the owner's certificates and their
#      known_hosts entry.
#   4. SELF-HOSTING. No cloud box id, across a restart and across a volume moved
#      to a different container, rotates nothing - a self-hoster restoring a
#      backup onto a replacement machine keeps their identity.
#
# Two of the stores exist only once something has written to them, so a bare boot
# would leave them absent and the diff would say nothing about either. `exercise`
# below writes to both through the shipped CLI - the same code path and the same
# files the editor's own routes use - so the API key store and the enrollment
# tokens are *derived* here rather than taken on trust.
#
# WHAT THIS IMAGE CANNOT PROVE, stated plainly because a harness that overstates
# its reach is worse than none: it installs no Docker engine, so
# `/data/docker/key.json` is never created and check 1 cannot derive it. That one
# entry stays declared. Adding a working engine-in-container to this harness buys
# one inventory line for a large amount of machinery, so the honest thing is to
# name the exception rather than hide it.
#
# Self-contained, standalone, self-cleaning. Everything it creates is prefixed
# "identity-harness-" and the EXIT trap removes only those.
#
# No `-e`: a failing check is a verdict this harness records and carries to the
# summary, not an error that aborts the run and hides the checks after it.
set -uo pipefail

# Git Bash / MSYS rewrites anything that looks like a Unix path in a command
# line, so `-v /sys/fs/cgroup:/sys/fs/cgroup` reaches Docker as a Windows path
# and the daemon tries to create it under the Git installation. Every path in the
# run flags below is container-internal and must survive verbatim; the two *host*
# paths the build needs are converted explicitly with cygpath instead. Exported
# rather than set per command, because one missed command is one confusing
# "Access is denied" from the daemon.
export MSYS_NO_PATHCONV=1

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO" ] || [ ! -f "$REPO/Dockerfile" ]; then
  echo "cannot find the repository root from $HERE" >&2
  exit 1
fi

# Host paths reach Docker in Windows form on Git Bash / MSYS; container-internal
# paths stay POSIX. Same reasoning as tests/system/overlay/run.sh.
REPO_CONTEXT="$REPO"
DOCKERFILE="$HERE/Dockerfile"
if command -v cygpath >/dev/null 2>&1; then
  REPO_CONTEXT="$(cygpath -m "$REPO")"
  DOCKERFILE="$(cygpath -m "$DOCKERFILE")"
fi

PREFIX=identity-harness
IMAGE="${PREFIX}-fixture:v1"
RUST_IMAGE="$(grep -oE 'rust:[^[:space:]]+' "$REPO/Dockerfile" | head -n1)"
if ! printf '%s' "$RUST_IMAGE" | grep -qE '^rust:[0-9]+\.[0-9]+\.[0-9]+'; then
  echo "could not read the Rust build image from $REPO/Dockerfile (got '$RUST_IMAGE')" >&2
  exit 1
fi

FAILED=0
log()  { printf '\n=== %s ===\n' "$*"; }
pass() { printf '  [PASS] %s\n' "$*"; }
fail() { printf '  [FAIL] %s\n' "$*"; FAILED=1; }
note() { printf '  [ .. ] %s\n' "$*"; }

if [ -z "${DOCKER_CONFIG:-}" ]; then
  DOCKER_CONFIG="$(mktemp -d)"
  printf '{}\n' >"$DOCKER_CONFIG/config.json"
  export DOCKER_CONFIG
fi

cleanup() {
  docker ps -aq --filter "name=^${PREFIX}-" | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker volume ls -q --filter "name=^${PREFIX}-" | xargs -r docker volume rm -f >/dev/null 2>&1 || true
  docker rmi -f "$IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

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

# Boot on a volume, optionally as a named cloud box. An empty id is the
# self-hosting case and must pass no variable at all - passing an empty one would
# test a state the control plane never produces.
boot() { # name volume [boxId]
  local name="$1" vol="$2" boxId="${3:-}"
  docker rm -f "$name" >/dev/null 2>&1 || true
  if [ -n "$boxId" ]; then
    docker run -d --name "$name" "${PROD_FLAGS[@]}" -v "$vol:/data" \
      -e COMPOSERY_INIT=systemd -e "COMPOSERY_CLOUD_BOX_ID=$boxId" "$IMAGE" >/dev/null
  else
    docker run -d --name "$name" "${PROD_FLAGS[@]}" -v "$vol:/data" \
      -e COMPOSERY_INIT=systemd "$IMAGE" >/dev/null
  fi
}

# Wait until sshd has started, which is the moment the instance would first
# answer a certificate - and therefore the moment rotation had to have finished.
wait_ready() {
  local i
  for i in $(seq 1 90); do
    if docker exec "$1" test -s /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null \
      && docker exec "$1" test -f /data/instance/identity 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Make the lazily-created stores real.
#
# The API key store and the enrollment tokens are written on first use, not on
# boot, so without this they would be absent on both instances - identical by
# absence, invisible to the diff, and therefore "declared" entries that no check
# covers. The shipped CLI writes exactly the files the editor's routes write
# (`keystore.rs` and `enrollments.rs` both resolve `volume_root()`), so running
# it once is what turns those two into derived coverage.
#
# Called only on a volume's first boot. Running it again on a restart would add a
# second key and change the store for an honest reason, which checks 3 and 4
# would then have to read as a rotation.
exercise() {
  docker exec "$1" composery api key create --name harness >/dev/null 2>&1 \
    || note "could not create an API key on $1 - keys.json stays declared, not derived"
  docker exec "$1" composery ssh enroll --name harness >/dev/null 2>&1 \
    || note "could not mint an enrollment on $1 - enrollments.json stays declared, not derived"
}

# A stable fingerprint of every identity-bearing file, read from the inventory
# the shipped script declares rather than from a second list kept here. Missing
# files are reported as "-" so an inventory entry that never exists is visible
# rather than silently skipped.
fingerprints() {
  docker exec "$1" sh -c '
    /opt/composery/identity.sh paths | while IFS= read -r p; do
      [ -n "$p" ] || continue
      if [ -f "$p" ]; then printf "%s %s\n" "$p" "$(sha256sum "$p" | cut -d" " -f1)"
      else printf "%s -\n" "$p"; fi
    done' 2>/dev/null
}

# Paths that differ between two first boots and are deliberately not rotated.
#
# Every entry is a claim somebody made and can be argued with, which is the point
# of writing them here rather than narrowing the sweep: "differs between two
# boots" is a fact the machine can establish, but "and therefore is a credential"
# is a judgement, and a judgement belongs somewhere a reviewer can see it. An
# entry added without a reason should not survive review.
#
# Adding to this list is how the check stops working, so the bar is the same as
# `.whitelistignore`: it hides things that are not credentials, never a credential
# that is awkward to rotate.
identity_exclusions() {
	printf '%s\n' \
		\
		"# The overlay engine's own backing store. Under the overlay engine /etc IS" \
		"# the merged root, so a delete of /etc/ssh/ssh_host_* goes *through* the" \
		"# overlay and the regenerated file lands in the upper. These paths are the" \
		"# same bytes as the /etc entries the inventory already names, seen from" \
		"# underneath - rotating them separately would be rotating them twice, and" \
		"# listing them would make the inventory read as if there were two copies." \
		'/data/persistence/overlay/upper/*' \
		'/data/persistence/overlay/work/*' \
		\
		"# Persistence's own state database. Machine-varying, and not a credential:" \
		"# it records which rootfs files changed, not anything that authenticates." \
		'/data/persistence/.internal/*' \
		\
		"# Ordinary machine-varying system state. Logs, login records and a linker" \
		"# cache differ between any two boots of anything; none of them authenticate" \
		"# anybody, and wiping them would be housekeeping dressed up as security." \
		'/var/log/*' \
		'/var/cache/*'
}

# True when a path is covered by an exclusion pattern (comment lines are skipped).
excluded() {
	local path="$1" pattern
	while IFS= read -r pattern; do
		case "$pattern" in "" | \#*) continue ;; esac
		# shellcheck disable=SC2254 - the pattern is a glob on purpose.
		case "$path" in $pattern) return 0 ;; esac
	done <<<"$(identity_exclusions)"
	return 1
}

# Everything a boot generated, as path+hash, over the trees where identity can
# live. Deliberately broader than the inventory: this is the set the inventory is
# checked *against*, so narrowing it to the inventory would make check 1 circular.
generated_state() {
  docker exec "$1" sh -c '
    find /data /etc/ssh /etc/machine-id -type f 2>/dev/null | sort | while IFS= read -r p; do
      printf "%s %s\n" "$p" "$(sha256sum "$p" 2>/dev/null | cut -d" " -f1)"
    done' 2>/dev/null
}

log "Building the identity fixture image (Debian + systemd + openssh + real rootfs + real CLI)"
if ! MSYS_NO_PATHCONV=1 docker build \
  --build-arg "RUST_IMAGE=$RUST_IMAGE" \
  -f "$DOCKERFILE" -t "$IMAGE" "$REPO_CONTEXT"; then
  echo "fixture image build failed" >&2
  exit 1
fi

# --- 1. Inventory completeness ------------------------------------------------
#
# Two independent first boots. Any file that differs between them was generated
# on the machine, which is the definition of instance identity, and must be in
# the inventory.
log "1. Two independent first boots: everything that differs is in the inventory"
fresh_volume "${PREFIX}-vol-a1"
fresh_volume "${PREFIX}-vol-a2"
boot "${PREFIX}-a1" "${PREFIX}-vol-a1" box-a
boot "${PREFIX}-a2" "${PREFIX}-vol-a2" box-b

if ! wait_ready "${PREFIX}-a1" || ! wait_ready "${PREFIX}-a2"; then
  fail "containers did not reach a ready state"
  docker logs "${PREFIX}-a1" 2>&1 | tail -30
  docker exec "${PREFIX}-a1" systemctl status ssh --no-pager 2>&1 | tail -15
else
  # SSH actually running on a first boot under systemd. This is the case that was
  # broken: the image ships no host keys, and Debian's inherited
  # `ExecStartPre=/usr/sbin/sshd -t` ran before the step that makes them, so the
  # unit hit its restart limit and never started. It only ever affected the
  # systemd profile, so only a systemd boot can show it - and the symptom is an
  # absent service, which nothing inside the instance is left alive to report.
  if docker exec "${PREFIX}-a1" systemctl is-active ssh >/dev/null 2>&1; then
    pass "sshd starts on a first boot under systemd, with keys made before the config check"
  else
    fail "sshd did not start on a first boot under systemd"
    docker exec "${PREFIX}-a1" systemctl status ssh --no-pager 2>&1 | tail -15
  fi

  # Before the diff: the lazily-created stores have to exist on both, or their
  # shared absence would read as "not instance identity".
  exercise "${PREFIX}-a1"
  exercise "${PREFIX}-a2"
  state1="$(generated_state "${PREFIX}-a1")"
  state2="$(generated_state "${PREFIX}-a2")"
  inventory="$(docker exec "${PREFIX}-a1" /opt/composery/identity.sh paths | tr -d '\r')"

  # Paths present in both boots with different content. Identical content means
  # the file came from the image, not from this machine.
  differing="$(
    join -j 1 <(printf '%s\n' "$state1") <(printf '%s\n' "$state2") 2>/dev/null \
      | awk '$2 != $3 { print $1 }'
  )"
  # Plus paths that exist in one boot and not the other, which is just as much a
  # per-instance artifact as a differing hash.
  only="$(
    comm -3 <(printf '%s\n' "$state1" | cut -d' ' -f1) \
            <(printf '%s\n' "$state2" | cut -d' ' -f1) | tr -d '\t'
  )"

  missing=""
  for path in $differing $only; do
    [ -n "$path" ] || continue
    # The identity record itself differs by design - it *names* the identity - and
    # is the mechanism rather than a secret, so it is not rotated and not listed.
    [ "$path" = "/data/instance/identity" ] && continue
    excluded "$path" && continue
    if ! printf '%s\n' "$inventory" | grep -qxF "$path"; then
      missing="${missing}${path}\n"
    fi
  done

  if [ -n "$missing" ]; then
    fail "files differ between two first boots but are not in identity.sh's inventory:"
    printf "$missing" | sed 's/^/         /'
    note "each is instance identity a copy would inherit - add it to identity_paths()"
  else
    pass "every per-instance file two first boots produced is in the inventory"
  fi
fi

# --- 2. Rotation on a copied disk --------------------------------------------
log "2. A disk copied to a different box rotates every identity file"
before="$(fingerprints "${PREFIX}-a1")"
# The source's CA public key and a certificate it signed, captured before the
# copy so the copy can be tested against them.
source_ca="$(docker exec "${PREFIX}-a1" sh -c 'cat /data/ssh/ca.pub' 2>/dev/null)"
docker stop "${PREFIX}-a1" >/dev/null 2>&1

# Copy the volume, which is what a provider snapshot of the disk amounts to.
fresh_volume "${PREFIX}-vol-copy"
docker run --rm -v "${PREFIX}-vol-a1:/from" -v "${PREFIX}-vol-copy:/to" \
  --entrypoint sh "$IMAGE" -c 'cp -a /from/. /to/' >/dev/null 2>&1

boot "${PREFIX}-copy" "${PREFIX}-vol-copy" box-copied
if ! wait_ready "${PREFIX}-copy"; then
  fail "the copied disk did not boot"
  docker logs "${PREFIX}-copy" 2>&1 | tail -30
else
  after="$(fingerprints "${PREFIX}-copy")"
  unchanged=""
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    path="${line%% *}"; hash="${line#* }"
    [ "$hash" = "-" ] && continue
    if printf '%s\n' "$after" | grep -qxF "$path $hash"; then
      unchanged="${unchanged}${path}\n"
    fi
  done <<<"$before"

  if [ -n "$unchanged" ]; then
    fail "these survived the copy unchanged, so the copy still holds the source's credentials:"
    printf "$unchanged" | sed 's/^/         /'
  else
    pass "every identity file was replaced on the copied disk"
  fi

  # The consequence, not the mechanism: the source's CA must no longer be the
  # authority this instance trusts. This is the actual security claim - a hash
  # comparison alone would pass if rotation swapped one shared key for another.
  copy_ca="$(docker exec "${PREFIX}-copy" sh -c 'cat /data/ssh/ca.pub' 2>/dev/null)"
  trusted="$(docker exec "${PREFIX}-copy" sh -c 'cat /etc/ssh/composery_ca.pub' 2>/dev/null)"
  if [ -z "$source_ca" ] || [ -z "$copy_ca" ]; then
    fail "could not read the certificate authority from one of the instances"
  elif [ "$source_ca" = "$copy_ca" ]; then
    fail "the copy's certificate authority is the source's - every certificate ever issued for the source opens this box"
  elif [ "$trusted" != "$copy_ca" ]; then
    fail "sshd trusts an authority that is not this instance's own CA"
  else
    pass "the copy trusts only its own new authority; source certificates cannot verify"
  fi
fi

# --- 3. The same box does not rotate -----------------------------------------
log "3. A restart under the same box id changes nothing"
fresh_volume "${PREFIX}-vol-stable"
boot "${PREFIX}-s1" "${PREFIX}-vol-stable" box-stable
if ! wait_ready "${PREFIX}-s1"; then
  fail "the stable-case container did not boot"
else
  exercise "${PREFIX}-s1"
  first="$(fingerprints "${PREFIX}-s1")"
  docker rm -f "${PREFIX}-s1" >/dev/null 2>&1
  boot "${PREFIX}-s2" "${PREFIX}-vol-stable" box-stable
  if ! wait_ready "${PREFIX}-s2"; then
    fail "the stable-case container did not boot a second time"
  else
    second="$(fingerprints "${PREFIX}-s2")"
    # The host certificate is re-signed every boot by design (ssh.sh), so compare
    # the durable identity - the CA and the API store - rather than everything.
    a="$(printf '%s\n' "$first"  | grep -E '/(ca|ca\.pub|keys\.json|enrollments\.json)$')"
    b="$(printf '%s\n' "$second" | grep -E '/(ca|ca\.pub|keys\.json|enrollments\.json)$')"
    if [ "$a" = "$b" ]; then
      pass "an ordinary restart keeps the instance's authority and keys"
    else
      fail "a restart under the same box id rotated identity - every owner certificate would break on each reboot"
      diff <(printf '%s\n' "$a") <(printf '%s\n' "$b") | sed 's/^/         /'
    fi
  fi
fi

# --- 4. Self-hosting never rotates -------------------------------------------
log "4. With no cloud box id, identity is recorded once and never rotated"
fresh_volume "${PREFIX}-vol-self"
boot "${PREFIX}-self1" "${PREFIX}-vol-self"
if ! wait_ready "${PREFIX}-self1"; then
  fail "the self-hosted container did not boot"
  docker logs "${PREFIX}-self1" 2>&1 | tail -30
else
  exercise "${PREFIX}-self1"
  recorded="$(docker exec "${PREFIX}-self1" cat /data/instance/identity 2>/dev/null | tr -d '\r\n')"
  first="$(fingerprints "${PREFIX}-self1" | grep -E '/(ca|ca\.pub|keys\.json|enrollments\.json)$')"
  docker rm -f "${PREFIX}-self1" >/dev/null 2>&1
  # A different container on the same volume: the self-hoster's replacement
  # machine. Nothing about the instance has changed, so nothing may rotate.
  boot "${PREFIX}-self2" "${PREFIX}-vol-self"
  if ! wait_ready "${PREFIX}-self2"; then
    fail "the self-hosted container did not boot on its moved volume"
  else
    second="$(fingerprints "${PREFIX}-self2" | grep -E '/(ca|ca\.pub|keys\.json|enrollments\.json)$')"
    if [ "$recorded" != "self-hosted" ]; then
      fail "expected the self-hosted sentinel to be recorded, got '$recorded'"
    elif [ "$first" = "$second" ]; then
      pass "a self-hosted instance keeps its authority across a moved volume"
    else
      fail "a self-hosted instance rotated its authority - a restored backup would lose every issued certificate"
    fi
  fi
fi

log "Summary"
if [ "$FAILED" -eq 0 ]; then
  printf '  All identity checks passed.\n'
else
  printf '  One or more identity checks FAILED.\n'
fi
exit "$FAILED"
