# Node major is pinned by the IDE (its native modules target this ABI). Builder and
# runtime share this one ARG; bump both together when the IDE moves Node major.
ARG NODE_IMAGE=node:24.18.1-trixie-slim@sha256:ac39e4b5fcb2b1b34b20364fd58b2e898f3bb80731ee6f62a7536f9df3d6aadc

# Keep the exact Caddy release aligned with the outer-edge Compose recipes.
FROM caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 AS caddy-bin

# Build the IDE from the in-repo hard fork.
FROM ${NODE_IMAGE} AS ide-base

# Apt packages are intentionally unpinned: the Debian suite comes from the base
# image, and the image digest is the reproducibility boundary.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    git \
    git-lfs \
    jq \
    libkrb5-dev \
    libsecret-1-dev \
    libx11-dev \
    libxkbfile-dev \
    patch \
    pkg-config \
    python-is-python3 \
    quilt \
    rsync \
    unzip \
  && rm -rf /var/lib/apt/lists/*

# The IDE build uses the upstream npm toolchain inside the cloned tree.
WORKDIR /src

# Clone pristine upstream at the pinned commit (no git context after COPY, so
# fetch directly, not via the dev submodule); it brings its own VS Code submodule.
# This intentionally happens before any local IDE files are copied, so normal
# patch and overlay edits reuse the large checkout. Must match the
# packages/ide/upstream submodule pin (tested in IDE patch tests).
ARG COMPOSERY_IDE_UPSTREAM_COMMIT=1e6ed874e3138141a5636f6e0dbe8570aa6cd001
RUN git init -q packages/ide/upstream \
  && git -C packages/ide/upstream remote add origin https://github.com/coder/code-server.git \
  && git -C packages/ide/upstream fetch --depth 1 origin "${COMPOSERY_IDE_UPSTREAM_COMMIT}" \
  && git -C packages/ide/upstream checkout -q FETCH_HEAD \
  && git -C packages/ide/upstream submodule update --init --recursive --depth 1

# Pre-install upstream's npm dependencies (the root postinstall fans out to
# lib/vscode) in this layer, keyed only by the upstream commit: native module
# compiles are the expensive part and must not rerun on every overlay/patch
# edit. build.sh reuses the node_modules copied with the tree and skips npm ci.
RUN --mount=type=cache,id=composery-ide-npm,target=/root/.npm,sharing=locked \
  cd packages/ide/upstream && CI=true npm ci

FROM ide-base AS ide-builder

COPY packages/ide/package.json ./packages/ide/package.json
COPY packages/ide/overlay ./packages/ide/overlay
COPY packages/ide/patches ./packages/ide/patches
COPY packages/ide/scripts ./packages/ide/scripts
COPY packages/shared/*.ts ./packages/shared/

WORKDIR /src/packages/ide

# Lay our overlay + patches over pristine upstream and build the release. The
# npm download cache remains useful even when local IDE sources invalidate this
# layer; node_modules still live only in the disposable build tree.
RUN --mount=type=cache,id=composery-ide-npm,target=/root/.npm,sharing=locked \
  npm run build

RUN printf 'source=https://github.com/coder/code-server\ncommit=%s\n' "${COMPOSERY_IDE_UPSTREAM_COMMIT}" \
    > build/release/.composery-upstream

# Build the Composery CLI. cargo-chef caches the dependency compile so source-only edits skip it.
FROM rust:1.97.1-slim-trixie@sha256:5c6f46a6e4472ab1ca7ba7d494e6677f2f219ebc02f32025d3986f057635ec9c AS cli-chef
# renovate: datasource=crate depName=cargo-chef
ARG CARGO_CHEF_VERSION=0.1.77
RUN cargo install cargo-chef --version "${CARGO_CHEF_VERSION}" --locked
WORKDIR /src/cli

FROM cli-chef AS cli-planner
COPY packages/cli/ .
RUN cargo chef prepare --recipe-path /recipe.json

FROM cli-chef AS cli-builder
COPY --from=cli-planner /recipe.json /recipe.json
RUN --mount=type=cache,id=composery-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
  --mount=type=cache,id=composery-cli-target,target=/src/cli/target,sharing=locked \
  cargo chef cook --release --recipe-path /recipe.json
COPY packages/cli/ .
RUN --mount=type=cache,id=composery-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
  --mount=type=cache,id=composery-cli-target,target=/src/cli/target,sharing=locked \
  cargo build --release --locked --bin composery \
  && install -D target/release/composery /out/composery

# Assemble the runtime image.
FROM ${NODE_IMAGE} AS runtime

# renovate: datasource=npm depName=bun
ARG BUN_VERSION=1.3.14
# renovate: datasource=npm depName=npm
ARG NPM_VERSION=12.0.2
# renovate: datasource=npm depName=pnpm
ARG PNPM_VERSION=11.18.0

ENV BROWSER="/opt/composery/ide/current/lib/vscode/bin/helpers/browser.sh" \
  EDITOR="code --wait" \
  GIT_EDITOR="code --wait" \
  KUBE_EDITOR="code --wait" \
  LANG="C.UTF-8" \
  VISUAL="code --wait" \
  VSCODE_PROXY_URI="/proxy/{{port}}/" \
  XDG_RUNTIME_DIR="/run/user/1000"
# LANG sets a UTF-8 default; LC_ALL is intentionally unpinned so the user can
# override the locale per session (a deployment-provided LC_ALL is still honored).

# Put the user's bin dirs on PATH at the process level (not just interactive shells)
# so ~/.local/bin works everywhere that inherits this env: integrated terminals and
# the no-startup-file `bash -c` shells an AI agent spawns. Login shells layer rc-file
# PATH edits on top.
ENV PATH="/home/user/.local/bin:/home/user/bin:${PATH}"

# Apt is unpinned (the base-image digest is the reproducibility boundary). APT lists
# are kept so `sudo apt install` works out of the box; persistence persists changes.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    cron \
    curl \
    desktop-file-utils \
    file \
    git \
    git-lfs \
    gnupg \
    iproute2 \
    jq \
    less \
    libfile-mimeinfo-perl \
    lsof \
    mailcap \
    nano \
    openssh-client \
    openssh-server \
    pipx \
    procps \
    python3 \
    python3-pip \
    python3-venv \
    ripgrep \
    rsync \
    shared-mime-info \
    sudo \
    supervisor \
    systemd \
    tar \
    tmux \
    unzip \
    vim \
    wget \
    xdg-user-dirs \
    xdg-utils \
    xz-utils \
    zip

# Native modules are the common case, not the exception: node-gyp needs a compiler
# and `npm install` failing is the worst possible first minute. Shipping the
# toolchain also costs *less* than letting each owner install it themselves -
# persistence would store a private copy of the same packages in every delta.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential \
    pkg-config \
    python3-dev

# Docker, from Docker's own apt repository - the vendor's documented install path,
# not get.docker.com piped into a build and not Debian's `docker.io` fork. Apt stays
# unpinned here for the same reason as the block above.
RUN install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian %s stable\n' \
    "$(dpkg --print-architecture)" "$(. /etc/os-release && echo "$VERSION_CODENAME")" \
    > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    containerd.io \
    docker-buildx-plugin \
    docker-ce \
    docker-ce-cli \
    docker-compose-plugin

# Debian marks the system Python externally managed, which makes `pip install` refuse
# to run at all. Nothing in the image imports the system site-packages, so the marker
# only removes a capability owners expect; pip falls back to a ~/.local install,
# which is already on PATH and already persisted. venv and pipx stay available for
# anyone who wants isolation. No -f: if the path moves, fail the build rather than
# quietly restore the block.
RUN rm /usr/lib/python3*/EXTERNALLY-MANAGED

# cron's PAM stack fails `pam_loginuid.so` in an unprivileged container (no writable
# /proc/self/loginuid), silently killing cron jobs. Make it optional so crontab works.
RUN sed -i 's/session\s\+required\s\+pam_loginuid/session optional pam_loginuid/' /etc/pam.d/cron

# openssh-server's postinst generates host keys at install time, which would bake
# one SSH identity into the image and hand it to every instance that ever pulls it -
# anyone with the image could then impersonate any of them. Delete them here; ssh.sh
# runs `ssh-keygen -A` at first boot so each instance generates its own, and
# persistence keeps them.
RUN rm -f /etc/ssh/ssh_host_*

RUN npm install --global \
    "bun@${BUN_VERSION}" \
    "npm@${NPM_VERSION}" \
    "pnpm@${PNPM_VERSION}" \
  && npm cache clean --force

RUN groupmod --new-name user node \
  && usermod --login user --home /home/user --move-home node \
  && mkdir -p /home/user \
  # Docker's group is joined here, not where Docker is installed: this is the
  # step that creates the account, and `usermod -aG` on a user that does not
  # exist yet fails the build.
  && usermod -aG docker user

COPY --from=ide-builder /src/packages/ide/build/release /opt/composery/ide/current
COPY --from=cli-builder /out/composery /opt/composery/bin/composery
COPY --from=caddy-bin /usr/bin/caddy /usr/local/bin/caddy
COPY rootfs/ /

# Show only the working dir in the prompt, not user@host. The stock skel ~/.bashrc
# sets user@host; the last PS1 wins, so appending here overrides it. In the baseline.
RUN printf '%s\n' \
    '' \
    '# Composery: show only the working directory in the prompt.' \
    'PS1='\''${debian_chroot:+($debian_chroot)}\[\033[01;34m\]\w\[\033[00m\]\$ '\''' \
    >> /home/user/.bashrc

# Final runtime wiring: create the user's bin dirs (so ~/.profile adds them to PATH),
# fix ownership (home + /usr/local for sudo-less global installs), permissions, unit
# symlinks, and desktop/mime caches, then snapshot the persistence baseline.
RUN find /home/user -name .gitkeep -type f -delete \
  && mkdir -p /data /etc/systemd/system/multi-user.target.wants \
  && mkdir -p /home/user/.local/bin /home/user/bin \
  && rm -f /etc/machine-id \
  && touch /etc/machine-id \
  && chown -R user:user /home/user \
  && chmod 0440 /etc/sudoers.d/user \
  && chmod +x /opt/composery/*.sh /opt/composery/init/*.sh \
  && chmod +x /usr/local/bin/xclip /usr/local/bin/xsel /usr/local/bin/wl-paste /usr/local/bin/wl-copy \
  && rm -f /etc/systemd/system/multi-user.target.wants/supervisor.service \
  && ln -sf /dev/null /etc/systemd/system/systemd-modules-load.service \
  && ln -sf /usr/lib/systemd/system/persistence.service /etc/systemd/system/multi-user.target.wants/persistence.service \
  && ln -sf /usr/lib/systemd/system/ide.service /etc/systemd/system/multi-user.target.wants/ide.service \
  && ln -sf /usr/lib/systemd/system/caddy.service /etc/systemd/system/multi-user.target.wants/caddy.service \
  && ln -sf /usr/lib/systemd/system/composery-watchdog.service /etc/systemd/system/multi-user.target.wants/composery-watchdog.service \
  && ln -sf /dev/null /etc/systemd/system/ssh.socket \
  && ln -sf /lib/systemd/system/ssh.service /etc/systemd/system/multi-user.target.wants/ssh.service \
  && ln -sf /lib/systemd/system/containerd.service /etc/systemd/system/multi-user.target.wants/containerd.service \
  && ln -sf /lib/systemd/system/docker.service /etc/systemd/system/multi-user.target.wants/docker.service \
  && ln -sf /opt/composery/ide/current/lib/vscode/bin/remote-cli/ide /usr/local/bin/code \
  && ln -sf /opt/composery/ide/current/bin/ide /usr/local/bin/ide \
  && ln -sf /opt/composery/bin/composery /usr/local/bin/composery \
  && update-desktop-database /usr/share/applications \
  && update-mime-database /usr/share/mime \
  && chown -R user:user /usr/local \
  && /opt/composery/bin/composery persistence __generate-baseline --root / --output /opt/persistence/baseline.sqlite

# Volatile release metadata belongs after every expensive filesystem layer.
# A new commit SHA should only create a tiny config layer, not reinstall the OS.
ARG COMPOSERY_BUILD_VERSION=unknown
ARG COMPOSERY_BUILD_REVISION=unknown
ARG COMPOSERY_BUILD_SOURCE=https://github.com/sloikodavid/composery-ide

LABEL org.opencontainers.image.title="Composery" \
  org.opencontainers.image.description="A secure cloud computer with a powerful UI, usable from any phone or browser." \
  org.opencontainers.image.source="${COMPOSERY_BUILD_SOURCE}" \
  org.opencontainers.image.revision="${COMPOSERY_BUILD_REVISION}" \
  org.opencontainers.image.version="${COMPOSERY_BUILD_VERSION}" \
  org.opencontainers.image.licenses="Apache-2.0"

ENV COMPOSERY_BUILD_VERSION="${COMPOSERY_BUILD_VERSION}" \
  COMPOSERY_BUILD_REVISION="${COMPOSERY_BUILD_REVISION}" \
  COMPOSERY_BUILD_SOURCE="${COMPOSERY_BUILD_SOURCE}"

# No USER directive: persistence needs root to rebuild the filesystem on boot; supervisor
# drops to the unprivileged `user` for the IDE. Root is intentional.
EXPOSE 8080

# Liveness through the internal ingress to the IDE's reserved health route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD curl -fsS "http://localhost:${PORT:-8080}/_composery/healthz" > /dev/null || exit 1

ENTRYPOINT ["/opt/composery/entrypoint.sh"]
