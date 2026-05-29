#!/usr/bin/env bash
# Restart the production pi-wallpaper-engine systemd service with three guards:
#   1. Refuse to restart on a dirty working tree (unless --force).
#   2. Snapshot the SQLite state db (db + db-shm + db-wal) before restart.
#   3. Health-check after restart; print a rollback hint if it fails.
#
# Usage:
#   scripts/restart-prod.sh           # safe path
#   scripts/restart-prod.sh --force   # skip the dirty-tree guard
set -euo pipefail

PROJECT_ROOT="/home/one-week/Documents/pi-wallpaper-engine"
STATE_DIR="$HOME/.local/state/pi-wallpaper-engine"
SNAPSHOT_DIR="$STATE_DIR/snapshots"
HEALTH_URL="http://localhost:8080/api/health"
SERVICE="pi-wallpaper-engine.service"
SNAPSHOT_KEEP=10

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help)
      sed -n '2,9p' "$0"
      exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# --- 1. dirty-tree guard ----------------------------------------------------
cd "$PROJECT_ROOT"
dirty="$(git status --porcelain)"
if [[ -n "$dirty" && "$FORCE" -eq 0 ]]; then
  echo "✗ working tree is dirty — refusing to restart."
  echo "  uncommitted changes:"
  git status --short | sed 's/^/    /'
  echo ""
  echo "  options:"
  echo "    - commit first, then re-run"
  echo "    - bash scripts/restart-prod.sh --force   (skip this guard)"
  exit 1
fi

# --- 2. db snapshot ---------------------------------------------------------
ts="$(date +%Y%m%d-%H%M%S)"
snap="$SNAPSHOT_DIR/$ts"
mkdir -p "$snap"
# WAL-mode SQLite needs all three files copied together; rsync is atomic enough
# for our purposes because the db is bun-only and we restart it right after.
for f in pi-wallpaper-engine.db pi-wallpaper-engine.db-shm pi-wallpaper-engine.db-wal; do
  if [[ -f "$STATE_DIR/$f" ]]; then
    cp -a "$STATE_DIR/$f" "$snap/$f"
  fi
done
echo "✓ db snapshot → $snap"

# Trim old snapshots, keep the most recent $SNAPSHOT_KEEP.
mapfile -t old < <(ls -1t "$SNAPSHOT_DIR" 2>/dev/null | tail -n +$((SNAPSHOT_KEEP + 1)))
for d in "${old[@]}"; do
  rm -rf "$SNAPSHOT_DIR/$d"
done

# --- 3. restart + health check ---------------------------------------------
systemctl --user restart "$SERVICE"
echo "✓ restart issued, waiting for health…"

for i in 1 2 3 4 5 6 7 8; do
  sleep 1
  if curl -sf -m 2 "$HEALTH_URL" >/dev/null 2>&1; then
    echo "✓ health OK after ${i}s"
    exit 0
  fi
done

echo ""
echo "✗ health check failed after 8s — service may be crashed or restarting."
echo "  diagnose:    journalctl --user -u $SERVICE -n 80 --no-pager"
echo "  rollback:    git reset --hard HEAD^ && bash scripts/restart-prod.sh --force"
echo "  db restore:  cp -a $snap/* $STATE_DIR/   (then restart)"
exit 1
