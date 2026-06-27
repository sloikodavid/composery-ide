#!/usr/bin/env bash
set -euo pipefail

# The Docker pair (containerd + dockerd), and the one gate that decides whether
# either may run. Both init profiles call this, so the decision and its message
# exist once.
#
# dockerd is pointed at the system containerd on purpose. Left alone it starts a
# containerd child of its own "with a generated config-file, which only contains
# the options needed for dockerd" - which would silently ignore
# /etc/containerd/config.toml and put every image layer back on the root
# filesystem while the config file sat there looking authoritative. Running
# containerd as its own service is also what Docker's own systemd packaging does,
# so both profiles end up with the same arrangement rather than two.
CONTAINERD_SOCKET=/run/containerd/containerd.sock

# Probe by doing, the same way `persistence select-engine` picks its engine: a
# real bind mount either works or it does not. dockerd needs CAP_SYS_ADMIN to
# mount layers, and reading the capability set out of /proc would mean 64-bit hex
# arithmetic in shell for a worse answer.
has_mount_privilege() {
	local probe
	probe="$(mktemp -d)"
	if mount --bind "$probe" "$probe" 2>/dev/null; then
		umount "$probe" 2>/dev/null || true
		rmdir "$probe" 2>/dev/null || true
		return 0
	fi
	rmdir "$probe" 2>/dev/null || true
	return 1
}

# Exit 0 to run, 1 to stay down. Never silently: a Docker that is not running is
# reported with the reason, because the failure mode this guards against is an
# owner who thinks they have Docker and finds out at the worst moment.
check() {
	case "${COMPOSERY_DISABLE_DOCKER:-}" in
		1 | true)
			printf 'Docker is off because COMPOSERY_DISABLE_DOCKER is set.\n' >&2
			return 1
			;;
	esac

	if ! has_mount_privilege; then
		printf 'Docker cannot start: this container has no CAP_SYS_ADMIN, so containerd cannot mount image layers. Run the container privileged to use Docker inside Composery. See docs/persistence.md.\n' >&2
		return 1
	fi

	return 0
}

# 78 is this image's existing "configured not to run" code - see the refused PORT
# setting in entrypoint.sh. Both init systems are told to treat it as a
# decision rather than a fault: supervisor lists it in `exitcodes` so the program
# is not restarted, and systemd reads it from ExecCondition as "skip this unit"
# rather than "this unit failed". A crash exits with anything else and is
# restarted normally.
readonly REFUSED=78

case "${1:-}" in
	check)
		check || exit "${REFUSED}"
		;;
	containerd)
		check || exit "${REFUSED}"
		exec /usr/bin/containerd
		;;
	dockerd)
		check || exit "${REFUSED}"
		exec /usr/bin/dockerd --containerd "${CONTAINERD_SOCKET}"
		;;
	*)
		printf 'Usage: docker.sh check|containerd|dockerd\n' >&2
		exit 64
		;;
esac
