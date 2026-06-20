# pwe-worker — built from the monorepo root.
# Build:  docker buildx build --platform linux/amd64 -f packages/worker/Dockerfile -t ghcr.io/<owner>/pwe-worker:<tag> .
# (run from the monorepo root so the workspace context is intact)
#
# Distribution target: linux/amd64 NAS with Intel iGPU. ARM64 builds also work
# (auto fall-back to libx265). The QSV runtime detection in src/ffmpeg.ts
# probes the device at startup — no build-arg gate needed.

# ── stage 1: install workspace deps once, reuse across rebuilds ────────────
FROM oven/bun:1.3-debian AS deps

WORKDIR /app

# Lockfile + manifests first → Docker layer cache keeps the install layer warm
# across source changes.
COPY package.json bun.lock ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/worker/package.json ./packages/worker/

# `bun install` honors the workspace `workspaces` field in the root
# package.json and links @pwe/shared into the worker via the workspace
# protocol. Frozen lockfile ensures reproducible image builds.
RUN bun install --frozen-lockfile

# ── stage 2: runtime image with ffmpeg + Intel media driver ────────────────
FROM oven/bun:1.3-debian AS runtime

# `intel-media-va-driver-non-free` ships the modern iHD driver used by
# Tiger Lake and later Intel iGPUs. Add `i965-va-driver` for very old chips.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ffmpeg \
       intel-media-va-driver-non-free \
       ca-certificates \
       tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Bring deps from the deps stage; node_modules holds the entire workspace.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/bun.lock ./bun.lock

# Bring source for the two packages the worker actually runs.
COPY packages/shared ./packages/shared
COPY packages/worker ./packages/worker
COPY tsconfig.base.json ./

ENV NODE_ENV=production
ENV PWE_WORK_DIR=/tmp/pwe-worker

# tini reaps zombie ffmpeg children and forwards SIGTERM cleanly so the
# worker's graceful shutdown path (finish current job, then exit) actually
# fires when `docker compose down` runs.
ENTRYPOINT ["/usr/bin/tini", "--", "bun", "run", "packages/worker/src/index.ts"]
