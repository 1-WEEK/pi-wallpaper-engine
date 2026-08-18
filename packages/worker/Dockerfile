# pwe-worker — built from the monorepo root.
# Build:  docker buildx build --platform linux/amd64 -f packages/worker/Dockerfile -t ghcr.io/<owner>/pwe-worker:<tag> .
# (run from the monorepo root so the workspace context is intact)
#
# Distribution target: linux/amd64 NAS with Intel iGPU. ARM64 builds also work
# (auto fall-back to libx265). The QSV runtime detection in src/ffmpeg.ts
# probes the device at startup — no build-arg gate needed.
#
# The worker's only non-built-in import is a type-only `import type` from
# @pwe/shared, so its runtime third-party footprint is zero. We bundle the
# entrypoint into a single self-contained file in a builder stage and ship only
# that — the runtime image carries no node_modules and runs no `bun install`.

# ── stage 1: bundle the worker into one self-contained file ────────────────
FROM oven/bun:1.3.14-debian AS builder

WORKDIR /app

# Only the source the bundle touches. No install needed: type-only imports are
# erased by the transpiler, so `bun build` resolves with the source alone.
COPY tsconfig.base.json package.json ./
COPY packages/shared ./packages/shared
COPY packages/worker ./packages/worker

# Tree-shaking bundle targeting the bun runtime. Emits dist/index.js plus a
# linked dist/index.js.map so stack traces from the running worker stay
# readable. (bun 1.3's --outfile drops external source maps; --outdir keeps
# them, so we use --outdir and run the resulting dist/index.js.)
RUN bun build packages/worker/src/index.ts \
      --target=bun \
      --outdir dist \
      --sourcemap=linked

# ── stage 2: minimal runtime — ffmpeg + Intel media driver + the bundle ────
FROM oven/bun:1.3.14-slim AS runtime

ARG TARGETARCH

# On Debian 13 (Trixie), FFmpeg 7.x/9.x uses oneVPL (`libvpl2`) for Intel QSV.
# `libmfx-gen1.2` provides the oneVPL Intel GPU user-space runtime driver
# (`libmfx-gen.so.1.2`). `intel-media-va-driver-non-free` ships the iHD VA-API
# driver for Gen8+ Intel iGPUs. These packages are amd64-specific (Intel hardware);
# on arm64 (Apple Silicon / ARM NAS) the worker falls back to libx265 software encoding.
RUN sed -i 's/^Components: main$/Components: main non-free non-free-firmware/' \
       /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && EXTRA_PKGS="" \
  && if [ "$TARGETARCH" = "amd64" ] || [ -z "$TARGETARCH" ]; then \
       dpkg --print-architecture | grep -q amd64 && EXTRA_PKGS="intel-media-va-driver-non-free libmfx-gen1.2" || true; \
     fi \
  && apt-get install -y --no-install-recommends \
       ffmpeg \
       $EXTRA_PKGS \
       ca-certificates \
       tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The self-contained bundle is the entire application — no node_modules.
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV PWE_WORK_DIR=/tmp/pwe-worker

# tini reaps zombie ffmpeg children and forwards SIGTERM cleanly so the
# worker's graceful shutdown path (finish current job, then exit) actually
# fires when `docker compose down` runs.
ENTRYPOINT ["/usr/bin/tini", "--", "bun", "run", "dist/index.js"]
