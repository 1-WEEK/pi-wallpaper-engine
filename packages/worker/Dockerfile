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

# ── stage 2: minimal runtime — FFmpeg 9.x + Intel media driver + the bundle ─
FROM oven/bun:1.3.14-slim AS runtime

ARG TARGETARCH

# On Debian 13 (Trixie), install Intel media drivers for VA-API / oneVPL hardware acceleration.
# FFmpeg 9.0.1 (gpl static build) is installed from official BtbN builds for amd64 and arm64.
RUN sed -i 's/^Components: main$/Components: main non-free non-free-firmware/' \
       /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && EXTRA_PKGS="" \
  && if [ "$TARGETARCH" = "amd64" ] || [ -z "$TARGETARCH" ]; then \
       dpkg --print-architecture | grep -q amd64 && EXTRA_PKGS="intel-media-va-driver-non-free libmfx-gen1.2" || true; \
     fi \
  && apt-get install -y --no-install-recommends \
       $EXTRA_PKGS \
       ca-certificates \
       curl \
       xz-utils \
       tini \
  && ARCH_SUFFIX="linux64" \
  && if [ "$TARGETARCH" = "arm64" ]; then ARCH_SUFFIX="linuxarm64"; fi \
  && curl -fsSL "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-${ARCH_SUFFIX}-gpl-9.0.tar.xz" | tar -xJ -C /tmp/ \
  && mv /tmp/ffmpeg-n9.0-latest-${ARCH_SUFFIX}-gpl-9.0/bin/ffmpeg /usr/local/bin/ffmpeg \
  && mv /tmp/ffmpeg-n9.0-latest-${ARCH_SUFFIX}-gpl-9.0/bin/ffprobe /usr/local/bin/ffprobe \
  && rm -rf /tmp/ffmpeg-n9.0-latest-* \
  && apt-get purge -y --auto-remove curl xz-utils \
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
