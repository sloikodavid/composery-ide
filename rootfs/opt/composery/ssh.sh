#!/usr/bin/env bash
set -euo pipefail

# The SSH service: the gate that decides whether it runs, where its identity comes
# from, and where deployment-supplied keys land. Both init profiles call this, so
# each of those exists once.
#
# Nothing here publishes a port. sshd listens on 22 inside the container and the
# deployment decides whether anything reaches it - a compose port mapping, a
# platform service, the cloud's host networking. That is what makes shipping it on
# by default safe: the exposure is the operator's act, not ours.

# 78 is this image's "configured not to run" code (see entrypoint.sh). Supervisor
# lists it in `exitcodes` and systemd reads it from ExecCondition, so a refusal is
# a decision in both rather than a service that restarts for ever.
readonly REFUSED=78
readonly MANAGED_KEYS_DIR=/etc/ssh/authorized_keys.d
readonly MANAGED_KEYS="${MANAGED_KEYS_DIR}/user"

# The instance's certificate authority. One CA per instance, never one per fleet:
# sshd accepts any certificate its trusted CA signed, so a shared CA would make
# every certificate valid on every instance that trusts it. Per-instance makes
# cross-instance access unrepresentable rather than merely disallowed - there is no
# principals list to get wrong, and a compromised CA reaches exactly the one
# machine that was already compromised.
#
# It lives on the volume beside the API key store, owned by the same account, for
# the same reason that one does: `user` has passwordless sudo, so root ownership
# would buy no protection from the only person who can reach it, and would stop
# the editor issuing certificates without a privileged helper.
readonly CA_DIR=/data/ssh
readonly CA_KEY="${CA_DIR}/ca"
readonly TRUSTED_CA=/etc/ssh/composery_ca.pub
# The revocation list sits beside the CA rather than in /etc because the editor
# revokes a certificate the moment an owner asks, and /etc is root-owned. Making it
# writable by the account costs nothing real: that account already has passwordless
# sudo, so a root-owned list would stop nobody who wanted to edit it.
readonly KRL="${CA_DIR}/krl"
readonly HOST_KEY=/etc/ssh/ssh_host_ed25519_key

check() {
	case "${COMPOSERY_DISABLE_SSH:-}" in
		1 | true)
			printf 'SSH is off because COMPOSERY_DISABLE_SSH is set.\n' >&2
			return 1
			;;
	esac
	return 0
}

# Called from entrypoint.sh, not from the service, because only the entrypoint
# reliably has this value.
#
# COMPOSERY_SSH_AUTHORIZED_KEYS holds an authorized_keys file, so it is multi-line
# by nature, and the systemd profile bridges settings to its units through a file
# built with `env | grep` - which keeps the first line of a value and drops the
# rest. Reading it here, before either init system starts, is what makes the two
# profiles behave the same instead of one of them silently honouring one key.
install_keys() {
	# Written every boot, including empty. A key removed from the deployment's
	# configuration has to stop working at the next restart; leaving the last value
	# in place would be a credential nobody can see and nobody revoked.
	install -d -m 0755 "${MANAGED_KEYS_DIR}"
	printf '%s\n' "${COMPOSERY_SSH_AUTHORIZED_KEYS:-}" >"${MANAGED_KEYS}"
	chmod 0644 "${MANAGED_KEYS}"
}

# Host keys are generated on this machine and never shipped in the image.
#
# This is the whole of an instance's SSH identity. An image carrying its own host
# keys would give every Composery the same one, so anybody who pulled the image
# could impersonate any instance and no client could tell. The Dockerfile deletes
# the pair Debian's postinst generates at install time, and `ssh-keygen -A` writes
# only what is missing. Persistence keeps /etc across restarts and image upgrades,
# so an instance's identity is created once and then stays put - which is also what
# keeps a client's known_hosts entry valid.
prepare() {
	install -d -m 0755 /run/sshd
	ssh-keygen -A
	prepare_authority
}

# The certificate half, rebuilt on every boot so it is always consistent with the
# host key above rather than with whatever a previous image left behind.
prepare_authority() {
	install -d -m 0700 -o user -g user "${CA_DIR}"
	if [ ! -f "${CA_KEY}" ]; then
		ssh-keygen -q -t ed25519 -f "${CA_KEY}" -N '' -C "composery-ca-$(cat /etc/machine-id)"
		chown user:user "${CA_KEY}" "${CA_KEY}.pub"
	fi

	install -m 0644 -o root -g root "${CA_KEY}.pub" "${TRUSTED_CA}"

	# The host certificate is what lets a client trust this instance by its CA
	# instead of by a pinned fingerprint, so a rebuilt host stops producing the
	# "REMOTE HOST IDENTIFICATION HAS CHANGED" alarm. It carries no principals,
	# which in a host certificate means "valid for any hostname" - correct here,
	# because we cannot know the name a self-hosted instance answers to, and the
	# client's own known_hosts line is what scopes the trust to one host.
	#
	# Re-signed every boot rather than issued once with a distant expiry: an expired
	# host certificate is a locked door, and a boot is the only moment we are
	# certain to be able to fix it.
	ssh-keygen -q -s "${CA_KEY}" -I "composery-host" -h -V -5m:+52w "${HOST_KEY}.pub"

	# sshd refuses every login if RevokedKeys names a file it cannot parse, so the
	# empty list has to exist before sshd starts and a failure here has to stop the
	# boot rather than leave the option pointing at nothing.
	if [ ! -f "${KRL}" ]; then
		ssh-keygen -q -k -f "${KRL}"
	fi
	chown user:user "${KRL}"
	chmod 0644 "${KRL}"
}

case "${1:-}" in
	check)
		check || exit "${REFUSED}"
		;;
	install-keys)
		install_keys
		;;
	prepare)
		prepare
		;;
	daemon)
		check || exit "${REFUSED}"
		prepare
		# -D keeps sshd in the foreground for both process managers; -e sends its
		# log to stderr, which is where each of them already collects it.
		exec /usr/sbin/sshd -D -e
		;;
	*)
		printf 'Usage: ssh.sh check|install-keys|prepare|daemon\n' >&2
		exit 64
		;;
esac
