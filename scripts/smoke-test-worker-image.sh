#!/usr/bin/env bash
# Smoke test for the pwe-worker image.
#
# Proves the bundled worker actually runs: it boots, every import resolves, the
# real ffmpeg encoder probe completes, and it reaches the broker-claim stage —
# all without a real broker. A bundle that lost a dependency would instead crash
# with a module-resolution error, which fails this test.
#
# Usage: scripts/smoke-test-worker-image.sh <image-ref>
set -euo pipefail

IMAGE="${1:?usage: smoke-test-worker-image.sh <image-ref>}"
NAME="pwe-worker-smoke-$$"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Unreachable broker → claim() fails fast with a network error (not auth), so
# the worker prints its backoff line and keeps running rather than exiting.
docker run -d --name "$NAME" \
  -e PWE_BACKEND_URL="http://127.0.0.1:1" \
  -e PWE_WORKER_API_KEY="smoke" \
  -e PWE_WORKER_NAME="smoke" \
  "$IMAGE" >/dev/null

# Markers, shallow → deep. Reaching CLAIM proves the most: every import
# resolved, config loaded, and the ffmpeg encoder probe ran to completion.
BOOT="▶ pwe-worker"
ENCODER="encoder:"
CLAIM="claim() failed"
FAILRE="Cannot find module|Could not resolve|Cannot find package|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Fatal:"

logs=""
deadline=$(( $(date +%s) + 120 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  logs="$(docker logs "$NAME" 2>&1 || true)"
  echo "$logs" | grep -qF "$CLAIM" && break
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ] && break
  sleep 3
done

echo "----- worker logs -----"
echo "$logs"
echo "-----------------------"

if echo "$logs" | grep -qE "$FAILRE"; then
  echo "✗ SMOKE FAIL: bundle crashed with a module/resolution error"
  exit 1
fi
for m in "$BOOT" "$ENCODER" "$CLAIM"; do
  if ! echo "$logs" | grep -qF "$m"; then
    echo "✗ SMOKE FAIL: missing expected marker: $m"
    exit 1
  fi
done
echo "✓ SMOKE PASS: worker booted, encoder detected, reached broker-claim stage"
