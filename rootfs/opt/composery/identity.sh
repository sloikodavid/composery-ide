#!/usr/bin/env bash
set -euo pipefail

# Instance identity: the secrets that say *which* Composery this is, and the one
# thing that decides when they are thrown away and made again.
#
# A disk-level copy of a running instance - Composery Cloud's Duplicate, a
# provider snapshot restored onto a second server, an image of a volume - carries
# every one of them. Without rotation the copy answers to the source's SSH
# certificate authority, so every certificate ever issued for the source logs
# into the copy; it serves the source's API keys; and it presents the source's
# host keys, so no client can tell the two apart. That is not a degraded copy, it
# is a second machine holding the first one's credentials.
#
# **Why this runs in the image's boot path and not from the control plane.** The
# copied disk boots with `restart: always` containers and sshd on the host's
# network stack, trusting the source's CA, on a fresh public IP - all of it
# before any control-plane step can reach the machine. Anyone holding a source
# certificate who finds that IP has a shell in the window between power-on and
# the first bootstrap. A control-plane trigger cannot close that window; only
# rotating before the init system starts sshd can. Doing it here also covers
# every copy this repository did not make, which is the class rather than the one
# instance we know about.
#
# **What decides that this is a copy.** COMPOSERY_CLOUD_BOX_ID names the box the
# control plane thinks it is talking to. It is on `MANAGED_ENV_KEYS`
# (`convex/boxes/infra/artifacts.ts`), so an owner cannot set or forge it, and
# the duplicate's bootstrap renders it from the new box's row. The instance
# records the identity it last rotated for; a disagreement means the disk moved
# to a different box, and disagreement is the only trigger.
#
# **Self-hosting.** With no COMPOSERY_CLOUD_BOX_ID there is nothing to disagree
# with, so the first boot records that and no later boot ever rotates. This is
# deliberate and is not an oversight: a self-hoster restarting, moving their
# volume to a replacement machine, or restoring a backup wants the same identity
# and wants their issued certificates to keep working. Deliberate cloning for
# self-hosters is a job for an explicit CLI verb, where the person asking has
# said which of the two outcomes they want - this file is the seam for it, and
# building the verb is not this file's job.

# Where the volume is. Same contract as the Rust side's `volume_root()`.
VOLUME="${COMPOSERY_DOCKER_VOLUME_PATH:-/data}"
readonly VOLUME

readonly IDENTITY_DIR="${VOLUME}/instance"
readonly IDENTITY_FILE="${IDENTITY_DIR}/identity"

# Recorded for an instance no control plane owns. A literal rather than an empty
# file, so "self-hosted, do not rotate" and "record missing or unreadable, rotate
# to be safe" stay two different states - an empty file could only mean both.
readonly SELF_HOSTED=self-hosted

# THE INVENTORY. Every file that makes this instance *this* instance.
#
# Completeness is not a claim any comment can make good on, so it is checked
# rather than asserted: `tests/system/identity/run.sh` boots two containers from
# one image and diffs their volumes and their /etc. Anything that differs between
# two independent first boots *is* instance identity, and the test fails if it is
# not named here. That is what stops this list rotting as future releases add a
# file nobody thought to add.
#
# Every entry is removed, never edited in place, and the boot that follows makes
# a new one:
#
#   - `/etc/machine-id` is truncated, not deleted, because entrypoint.sh's own
#     first-boot block already regenerates an empty one - so this reuses the
#     mechanism instead of adding a second copy of it.
#   - `ssh.sh prepare` regenerates the host keys (`ssh-keygen -A`), the CA, the
#     host certificate signed by it, and an empty KRL. It runs after this, from
#     the service, on both init profiles.
#   - `/etc/ssh/composery_ca.pub` is the root-owned copy of the CA that sshd
#     actually reads (`TrustedUserCAKeys`). `prepare` reinstalls it from the CA
#     key unconditionally, so listing it changes nothing today - it is here
#     because it is the file that decides who may log in, and a reader must not
#     have to trace another script to satisfy themselves it was handled.
#   - The API key store, the issued-certificate records and the pending
#     enrollment tokens have no regeneration step and need none: their absence is
#     an empty store, and the owner issues what they want again. Records of
#     certificates signed by a CA that no longer exists would be worse than
#     absent - they would describe access nobody has.
#   - Docker's `key.json` is the engine's own identity, under the data root this
#     image configures (`/etc/docker/daemon.json`). The engine writes a new one.
#
# What is deliberately NOT here, and why, so nobody adds it back:
#
#   - The owner's files. Rotation is about credentials; a duplicate exists to
#     keep the files, which is the whole point of the feature.
#   - `composery.env` (the cloud id, the origin and the password hash). The
#     duplicate's bootstrap rewrites it from the new box's row before the stack
#     comes up, so it is already correct by a different mechanism.
#   - Caddy's `/data` and `/config` volumes, which hold the source's certificate
#     and its ACME account key. They are Docker volumes on the *host*, outside
#     this container's filesystem entirely, so no code in here can reach them.
#     They are wiped host-side by the duplicate's bootstrap. Keeping the two
#     halves apart is the point: a reader of this file must not believe the Caddy
#     volumes are handled here.
identity_paths() {
	printf '%s\n' \
		/etc/machine-id \
		"${VOLUME}/ssh/ca" \
		"${VOLUME}/ssh/ca.pub" \
		/etc/ssh/composery_ca.pub \
		"${VOLUME}/ssh/krl" \
		"${VOLUME}/ssh/certificates.json" \
		"${VOLUME}/ssh/enrollments.json" \
		"${VOLUME}/api/keys.json" \
		"${VOLUME}/docker/key.json"
	# Globbed rather than listed: the host key set is whatever `ssh-keygen -A`
	# made, which follows the OpenSSH build rather than a list kept here. A
	# key type added upstream must not survive a rotation because this file
	# had not heard of it.
	printf '%s\n' /etc/ssh/ssh_host_*
}

# What this instance last rotated for. Absent or unreadable reads as "unknown",
# which rotates: the protection here is the rotation, so an unreadable record
# must fail towards doing it rather than towards skipping it.
recorded_identity() {
	if [ -r "${IDENTITY_FILE}" ]; then
		head -n 1 "${IDENTITY_FILE}" 2>/dev/null || printf ''
	else
		printf ''
	fi
}

current_identity() {
	printf '%s' "${COMPOSERY_CLOUD_BOX_ID:-${SELF_HOSTED}}"
}

record_identity() {
	install -d -m 0755 -o root -g root "${IDENTITY_DIR}"
	printf '%s\n' "$1" >"${IDENTITY_FILE}"
	chmod 0644 "${IDENTITY_FILE}"
}

rotate() {
	while IFS= read -r path; do
		[ -n "${path}" ] || continue
		case "${path}" in
			/etc/machine-id)
				# Truncated, so entrypoint.sh's first-boot block writes a new one.
				: >/etc/machine-id
				;;
			*)
				rm -f "${path}"
				;;
		esac
	done <<<"$(identity_paths)"
}

# The whole decision, in one place so no caller can reach a rotation by another
# route. Prints what it did, because a rotation that happened silently and a
# rotation that never ran look identical afterwards - and one of those is a
# security failure.
apply() {
	local current recorded
	current="$(current_identity)"
	recorded="$(recorded_identity)"

	if [ -z "${recorded}" ]; then
		# First boot on this volume. Nothing was issued under a previous identity,
		# so there is nothing to invalidate - record and carry on.
		record_identity "${current}"
		printf 'Instance identity recorded for %s.\n' "${current}" >&2
		return 0
	fi

	if [ "${recorded}" = "${current}" ]; then
		return 0
	fi

	printf 'This disk was last used by %s and is now %s, so its SSH authority, host keys, API keys and machine id are being replaced.\n' \
		"${recorded}" "${current}" >&2
	rotate
	record_identity "${current}"
}

case "${1:-}" in
	apply)
		apply
		;;
	paths)
		# The inventory, for the test that checks it is complete.
		identity_paths
		;;
	*)
		printf 'Usage: identity.sh apply|paths\n' >&2
		exit 64
		;;
esac
