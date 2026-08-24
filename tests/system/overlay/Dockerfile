# syntax=docker/dockerfile:1
#
# Representative test image for the overlay persistence engine. NOT the real
# Composery image (no IDE - the editor build is far too slow to bring into a
# test): just Debian + systemd + the *real* rootfs/ tree + a *real* composery
# binary built from packages/cli, so the test exercises the real entrypoint,
# select-engine, init/overlay.sh, and the upper-hygiene pass. See run.sh.

# Keep the toolchain identical to the shipped binary (the cli-chef line in the
# top-level Dockerfile). Passed in by run.sh, which reads that one line; no
# default here, so a run.sh that fails to pass it fails loudly at FROM instead
# of silently building with a stale second copy of the version.
ARG RUST_IMAGE
ARG FIXTURE_VERSION=1

FROM ${RUST_IMAGE} AS cli-builder
WORKDIR /src/cli
COPY packages/cli/ .
RUN --mount=type=cache,id=composery-overlay-test-target,target=/src/cli/target,sharing=locked \
  --mount=type=cache,id=composery-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
  cargo build --release --locked --bin composery \
  && install -D target/release/composery /out/composery

FROM debian:trixie-slim AS runtime
ARG FIXTURE_VERSION

# systemd (+sysv wrappers) and util-linux/mount for the overlay mount + pivot,
# plus attr for the hygiene pass's xattr reads. supervisor for the copy-engine
# unprivileged-fallback case.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    systemd systemd-sysv util-linux mount procps attr ca-certificates supervisor \
  && rm -rf /var/lib/apt/lists/*

# The uid 1000 `user` the real image ships and the entrypoint chowns /data to.
RUN groupadd -g 1000 user \
  && useradd -u 1000 -g 1000 -m -d /home/user user

# The real runtime tree: entrypoint, init/overlay.sh + init/*.sh, the systemd
# units, remove-password.sh, supervisor config, Caddyfile, etc.
COPY rootfs/ /
COPY --from=cli-builder /out/composery /opt/composery/bin/composery

# Final wiring the real Dockerfile does, minus the IDE/caddy binaries this image
# does not ship. Enable only persistence.service so "a unit is active" is an
# unambiguous check; ide/caddy units exist but are not wanted here.
RUN find /home/user -name .gitkeep -type f -delete \
  && mkdir -p /data /etc/systemd/system/multi-user.target.wants \
  && chown -R user:user /home/user \
  && chmod +x /opt/composery/entrypoint.sh /opt/composery/init/*.sh /opt/composery/remove-password.sh \
  && ln -sf /opt/composery/bin/composery /usr/local/bin/composery \
  && ln -sf /lib/systemd/system/multi-user.target /etc/systemd/system/default.target \
  && ln -sf /dev/null /etc/systemd/system/systemd-modules-load.service \
  && ln -sf /usr/lib/systemd/system/persistence.service /etc/systemd/system/multi-user.target.wants/persistence.service

# Fixtures keyed by the image "version" so the upgrade + hygiene cases can tell a
# new lower from an old one:
#   composery-test-marker   present in both, user never touches -> shows v2 after upgrade
#   composery-edit          present in both, user edits on v1    -> upper wins over v2
#   composery-hygiene-changed present in both, DIFFERENT content -> user deletes on v1;
#                             hygiene drops the whiteout on v2 (changed) and delivers v2
#   composery-hygiene-same  present in both, SAME content        -> user deletes on v1;
#                             hygiene keeps the whiteout (unchanged) - stays deleted
#   composery-hygiene-dir/  user replaces on v1 (opaque)         -> v2's new c is reported, hidden
#   composery-only-v2       added only in v2                     -> new lower file appears
RUN set -eu; \
  echo "v${FIXTURE_VERSION}" > /etc/composery-test-marker; \
  echo "v${FIXTURE_VERSION}" > /etc/composery-edit; \
  echo "v${FIXTURE_VERSION}" > /etc/composery-hygiene-changed; \
  echo "constant" > /etc/composery-hygiene-same; \
  mkdir -p /etc/composery-hygiene-dir; \
  echo "a-v${FIXTURE_VERSION}" > /etc/composery-hygiene-dir/a; \
  echo "b" > /etc/composery-hygiene-dir/b; \
  if [ "${FIXTURE_VERSION}" = 2 ]; then \
    echo "v2-only" > /etc/composery-only-v2; \
    echo "c-new" > /etc/composery-hygiene-dir/c; \
  fi

# Snapshot the persistence baseline exactly like the real image: after the rootfs
# tree and the fixtures, so it records this image's lower content and hashes.
RUN /opt/composery/bin/composery persistence __generate-baseline --root / --output /opt/persistence/baseline.sqlite

ENTRYPOINT ["/opt/composery/entrypoint.sh"]
