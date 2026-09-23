# syntax=docker/dockerfile:1.7
#
# pai-pro — production image.
#
# Multi-stage:
#   builder  rebuilds native node modules (node-pty, sharp) against
#            linux/glibc and produces web/dist from the React+Vite source.
#   runtime  slim image with ffmpeg + poppler + cloudflared + supported
#            agent CLIs, running as non-root `node` user.

ARG NODE_TAG=22-slim
# Pinned cloudflared. Releases ship every 2-4 weeks; using `latest` lets
# transient CDN replication windows during a new-release publish 404 our
# build. Bump via
# `docker compose build --build-arg CLOUDFLARED_VERSION=<x>` to test.
ARG CLOUDFLARED_VERSION=2026.8.2
ARG CODEX_VERSION=latest
ARG CLAUDE_VERSION=latest

# ─── builder ──────────────────────────────────────────────────────────
FROM node:${NODE_TAG} AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Server deps (production-only). node-pty is optionalDeps — npm continues
# if its native build fails, matching host behavior.
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund

# Web deps (full — needed for `npm run build`).
COPY web/package.json web/package-lock.json* ./web/
RUN cd web && npm ci --no-audit --no-fund

# Source.
COPY server/ ./server/
COPY web/ ./web/

# Produce web/dist.
RUN cd web && npm run build

# ─── runtime ──────────────────────────────────────────────────────────
FROM node:${NODE_TAG} AS runtime
ARG CODEX_VERSION
ARG CLAUDE_VERSION

# Runtime system binaries.
#   ffmpeg          reel stitching (reel_stitch.js)
#   poppler-utils   pdftotext for script-compose skill
#   zip             packages a VN draft into .vn (cawcut vn project pack)
#   tini            PID 1, signal forwarding
#   curl            healthcheck + cloudflared install
#   bubblewrap      Codex sandboxing on Linux
#   ca-certificates HTTPS to providers
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      poppler-utils \
      zip \
      tini \
      curl \
      bubblewrap \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# cloudflared (architecture-aware, pinned version).
ARG CLOUDFLARED_VERSION
RUN ARCH="$(dpkg --print-architecture)" && \
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${ARCH}" \
      -o /usr/local/bin/cloudflared && \
    chmod +x /usr/local/bin/cloudflared && \
    cloudflared --version

WORKDIR /repo

# Built artifacts.
COPY --from=builder /build/server /repo/server
COPY --from=builder /build/web/dist /repo/web/dist

# Skills are bundled in-image (NOT bind-mounted from host — avoids the
# host/container target-collision when the same skill set is also installed
# in the user's ~/.claude/skills/ on the host).
COPY skills/ /repo/skills/

# Project-level agent grounding — the CLAUDE.md instructions and the
# .claude/hooks that enforce --stage / run_in_background must be in
# the container, otherwise the embedded agent fires generations
# without the draft gate.
COPY CLAUDE.md /repo/CLAUDE.md
COPY agent-templates/ /repo/agent-templates/
COPY .claude/ /repo/.claude/

# Entrypoint.
COPY docker/entrypoint.sh /usr/local/bin/pai-entrypoint.sh
RUN chmod +x /usr/local/bin/pai-entrypoint.sh

# Ensure node user owns everything it needs to write (incl. ~/.local for
# the claude CLI install in the next step).
RUN mkdir -p /repo/projects /home/node/.claude/skills /home/node/.codex /home/node/.local/bin && \
    chown -R node:node /repo /home/node

# Advisory — keeps customer data out of the writable container layer if
# they forget to mount a volume.
VOLUME ["/repo/projects"]

ENV NODE_ENV=production \
    VIEWER_PORT=7488 \
    VIEWER_BIND=0.0.0.0 \
    PAI_REPO_ROOT=/repo \
    HOME=/home/node \
    PATH=/home/node/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    SHELL=/bin/bash

EXPOSE 7488

USER node

# Claude Code CLI — default to npm's latest dist-tag so fresh Docker builds
# pick up Claude updates. Override CLAUDE_VERSION to reproduce a specific
# release. Install as node into /home/node/.local/bin, which is on PATH.
# If the install fails the build continues so a Codex-selected deployment
# can still run; the entrypoint refuses to boot a Claude-selected
# deployment without the Claude CLI.
# CLAUDE_INSTALL_REFRESH lets scripts invalidate only this install layer.
ARG CLAUDE_INSTALL_REFRESH=manual
RUN echo "[build] claude install refresh ${CLAUDE_INSTALL_REFRESH}" >/dev/null && \
    npm config set prefix /home/node/.local && \
    (npm install -g "@anthropic-ai/claude-code@${CLAUDE_VERSION}" --no-audit --no-fund && \
     claude --version || \
     echo "[build] claude CLI install failed — PTY tab will be degraded")

# Codex CLI — default to npm's latest dist-tag so fresh Docker builds pick
# up Codex updates. Override CODEX_VERSION to reproduce a specific release.
# CODEX_INSTALL_REFRESH lets scripts invalidate only this install layer.
# Install as node into /home/node/.local/bin, which is on PATH.
ARG CODEX_INSTALL_REFRESH=manual
RUN echo "[build] codex install refresh ${CODEX_INSTALL_REFRESH}" >/dev/null && \
    npm config set prefix /home/node/.local && \
    (npm install -g "@openai/codex@${CODEX_VERSION}" --no-audit --no-fund && \
     codex --version || \
     echo "[build] codex CLI install failed - Codex PTY will be degraded")

# CawCut CLI — the bundled skills/cawcut-vn skill drives it to build VN
# drafts. `--ignore-scripts` keeps the package postinstall from writing its
# own skill set into ~/.claude/skills, which would shadow the bundled
# cawcut-vn the entrypoint links there.
RUN npm config set prefix /home/node/.local && \
    npm install -g @ubnt/cawcut --ignore-scripts

# tini → entrypoint → node. Three layers but each does one thing.
ENTRYPOINT ["tini", "--", "/usr/local/bin/pai-entrypoint.sh"]
