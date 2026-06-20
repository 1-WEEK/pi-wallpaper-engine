#!/usr/bin/env bash
# Build + tag (+ optionally push) the pwe-worker image for linux/amd64.
#
# Usage:
#   packages/worker/scripts/release.sh                       # build only, locally
#   packages/worker/scripts/release.sh --push                # build + push to $PWE_WORKER_REGISTRY
#   PWE_WORKER_TAG=0.2.0 packages/worker/scripts/release.sh  # explicit tag
#
# Env:
#   PWE_WORKER_REGISTRY   default: ghcr.io/${USER}/pwe-worker
#   PWE_WORKER_TAG        default: read from packages/worker/package.json .version
#
# For ghcr.io pushes, this script depends on the GitHub CLI (gh) being installed
# and logged in. It runs `gh auth token | docker login ghcr.io` automatically.

set -euo pipefail

cd "$(dirname "$0")/../../.."   # → monorepo root

REGISTRY="${PWE_WORKER_REGISTRY:-ghcr.io/${USER}/pwe-worker}"
TAG="${PWE_WORKER_TAG:-$(grep '"version"' packages/worker/package.json | head -1 | sed -E 's/.*"([0-9][^"]*)".*/\1/')}"

PLATFORM="linux/amd64"
PUSH=0
LOAD=0

for arg in "$@"; do
  case "$arg" in
    --push)   PUSH=1 ;;
    --load)   LOAD=1 ;;
    --multi)  PLATFORM="linux/amd64,linux/arm64" ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

if ! docker buildx version >/dev/null 2>&1; then
  echo "✗ docker buildx is required. Install Docker Desktop or enable the buildx plugin." >&2
  exit 2
fi

IMAGE_REF_VERSIONED="${REGISTRY}:${TAG}"
IMAGE_REF_LATEST="${REGISTRY}:latest"

ensure_ghcr_login() {
  if [[ "${REGISTRY}" != ghcr.io/* ]]; then
    return 0
  fi

  if ! gh --version >/dev/null 2>&1; then
    echo "✗ Pushing to ghcr.io requires the GitHub CLI (gh). Install it and run 'gh auth login'." >&2
    exit 2
  fi

  if ! gh auth status >/dev/null 2>&1; then
    echo "✗ 'gh auth login' is required to push to ghcr.io." >&2
    exit 2
  fi

  local github_user
  github_user="$(gh api user -q .login)"
  echo "▶ Logging into ghcr.io as ${github_user} via gh"
  gh auth token | docker login ghcr.io -u "${github_user}" --password-stdin
}

if [[ "${PUSH}" == "1" ]]; then
  ensure_ghcr_login
fi

echo "▶ Building ${IMAGE_REF_VERSIONED} for ${PLATFORM}"

BUILDX_ARGS=(
  buildx build
  --platform "${PLATFORM}"
  --file packages/worker/Dockerfile
  --tag "${IMAGE_REF_VERSIONED}"
  --tag "${IMAGE_REF_LATEST}"
)

if [[ "${PUSH}" == "1" ]]; then
  BUILDX_ARGS+=(--push)
elif [[ "${LOAD}" == "1" ]]; then
  if [[ "${PLATFORM}" == *","* ]]; then
    echo "✗ --load is incompatible with multi-arch builds. Use --push or pick one platform." >&2
    exit 2
  fi
  BUILDX_ARGS+=(--load)
else
  # buildx without --push or --load doesn't keep the image on disk by default.
  # Default to --load for the common single-arch case so the user sees it
  # via `docker images`.
  BUILDX_ARGS+=(--load)
fi

docker "${BUILDX_ARGS[@]}" .

echo "✓ ${IMAGE_REF_VERSIONED}"
if [[ "${PUSH}" == "1" ]]; then
  echo "  Pushed to ${REGISTRY}. On the NAS:"
  echo "    PWE_WORKER_IMAGE=${IMAGE_REF_VERSIONED} docker compose pull && docker compose up -d"
else
  echo "  Loaded locally. To distribute via tarball:"
  echo "    docker save ${IMAGE_REF_VERSIONED} | gzip > pwe-worker-${TAG}.tar.gz"
  echo "    scp pwe-worker-${TAG}.tar.gz nas:/tmp/"
  echo "    ssh nas 'docker load < /tmp/pwe-worker-${TAG}.tar.gz'"
fi
