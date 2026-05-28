#!/usr/bin/env bash
# Run backend (Bun + Elysia, port 8080) and frontend (Vite dev server, port 5173)
# together. Vite proxies /api requests to the backend so the UI works as one
# coherent app at http://localhost:5173 with HMR.
#
# Ctrl+C stops both.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

if [ ! -f config.json ]; then
  echo "✗ config.json not found. Run ./install-pi.sh first." >&2
  exit 1
fi

BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  trap '' INT TERM EXIT
  echo ""
  echo "Shutting down..."
  if [ -n "$BACKEND_PID" ]; then kill "$BACKEND_PID" 2>/dev/null || true; fi
  if [ -n "$FRONTEND_PID" ]; then kill "$FRONTEND_PID" 2>/dev/null || true; fi
  wait 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM EXIT

PORT="$(bun -e "console.log(JSON.parse(require('fs').readFileSync('config.json','utf-8')).server.port)")"
export VITE_BACKEND_PORT="$PORT"

bun run --filter @pwe/backend dev 2>&1 | sed -u 's/^/[backend ] /' &
BACKEND_PID=$!

bun run --filter @pwe/frontend dev 2>&1 | sed -u 's/^/[frontend] /' &
FRONTEND_PID=$!

PI_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"

cat <<EOF

════════════════════════════════════════════════════════════
  Dev mode running.

  UI (HMR):   http://localhost:5173       (or http://${PI_IP:-<pi-ip>}:5173)
  Backend:    http://localhost:${PORT}
  Vite dev server proxies /api → backend automatically.

  Ctrl+C to stop both.
════════════════════════════════════════════════════════════

EOF

wait
