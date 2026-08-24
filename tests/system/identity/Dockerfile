# syntax=docker/dockerfile:1
#
# Representative test image for instance-identity rotation. NOT the real
# Composery image (no IDE - the editor build is far too slow to bring into a
# test): Debian + systemd + openssh + the *real* rootfs/ tree + a *real*
# composery binary built from packages/cli, so the boot that runs is the real
# entrypoint, the real identity.sh and the real ssh.sh. See run.sh, which states
# exactly what this image can and cannot prove.

ARG RUST_IMAGE

FROM ${RUST_IMAGE} AS cli-builder
WORKDIR /src/cli
COPY packages/cli/ .
RUN --mount=type=cache,id=composery-identity-test-target,target=/src/cli/target,sharing=locked \
  --mount=type=cache,id=composery-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
  cargo build --release --locked --bin composery \
  && install -D target/release/composery /out/composery

FROM debian:trixie-slim AS runtime

# systemd for the init profile the harness boots, util-linux/mount for the
# overlay engine's pivot, and openssh-server because sshd's host keys and the
# CA that signs their certificate are most of what instance identity *is* - an
# image without it could not surface the files this test exists to find.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    systemd systemd-sysv util-linux mount procps attr ca-certificates \
    openssh-server openssh-client \
  && rm -rf /var/lib/apt/lists/*

# The uid 1000 `user` the real image ships and the entrypoint chowns /data to.
RUN groupadd -g 1000 user \
  && useradd -u 1000 -g 1000 -m -d /home/user user

COPY rootfs/ /
COPY --from=cli-builder /out/composery /opt/composery/bin/composery

# The real image deletes the host keys Debian's postinst generates, so that an
# instance's identity is made on the instance and never shipped. Repeated here
# because it is the precondition for everything this test measures: a host key
# baked into the image would be identical on both containers and the diff would
# report no identity at all.
RUN find /home/user -name .gitkeep -type f -delete \
  && rm -f /etc/ssh/ssh_host_* \
  && rm -f /etc/machine-id && touch /etc/machine-id \
  && mkdir -p /data /etc/systemd/system/multi-user.target.wants \
  && chown -R user:user /home/user \
  && chmod +x /opt/composery/*.sh /opt/composery/init/*.sh \
  && ln -sf /opt/composery/bin/composery /usr/local/bin/composery \
  && ln -sf /lib/systemd/system/multi-user.target /etc/systemd/system/default.target \
  && ln -sf /dev/null /etc/systemd/system/systemd-modules-load.service \
  && ln -sf /usr/lib/systemd/system/persistence.service /etc/systemd/system/multi-user.target.wants/persistence.service \
  && ln -sf /lib/systemd/system/ssh.service /etc/systemd/system/multi-user.target.wants/ssh.service

RUN /opt/composery/bin/composery persistence __generate-baseline --root / --output /opt/persistence/baseline.sqlite

ENTRYPOINT ["/opt/composery/entrypoint.sh"]
