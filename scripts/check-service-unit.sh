#!/usr/bin/env bash
# Verifies scripts/render-service-unit.sh against the ticket-02 contract:
# the unit is ordered after the configured media root's mount attempt with
# non-requiring semantics, derived from configuration rather than hardcoded.
#
# Run from the repository root: bash scripts/check-service-unit.sh

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$PROJECT_ROOT/pi-wallpaper-engine.service"
RENDER="$PROJECT_ROOT/scripts/render-service-unit.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0

check() {
  local what="$1"
  shift
  if "$@"; then
    printf '  \033[32m✓\033[0m %s\n' "$what"
  else
    printf '  \033[31m✗\033[0m %s\n' "$what" >&2
    failures=$((failures + 1))
  fi
}

write_config() {
  local media_root="$1"
  local path="$2"
  bun -e "
    const fs = require('fs');
    fs.writeFileSync(process.argv[1], JSON.stringify({
      steam: { username: 'u', web_api_key: 'k', steamcmd_path: '/x' },
      paths: { data_root: process.argv[2], source_dir: 'source', optimized_dir: 'optimized' },
      storage: { root: null },
      screen: { width: 1200, height: 1080, default_display_mode: 'fill' },
      mpv: { binary_path: 'mpv', ipc_socket: '/tmp/x.sock', hwdec: 'auto', gpu_api: 'opengl' },
      transcode: { target_codec: 'hevc', target_quality: 23, heartbeat_timeout_ms: 60000 },
      server: { host: '0.0.0.0', port: 8080 },
    }, null, 2));
  " "$path" "$media_root"
}

render() {
  local config="$1"
  local out="$2"
  PROJECT_ROOT="$PROJECT_ROOT" HOME="${HOME:-/home/test}" BUN_BIN="/usr/bin/bun" \
    bash "$RENDER" "$config" "$TEMPLATE" "$out"
}

echo "render-service-unit"

# ── data_root drives the mount unit when storage.root is null ────────────────
CONFIG="$WORK/config-default.json"
OUT="$WORK/unit-default.service"
write_config "/home/pi/pi-wallpaper-engine-data" "$CONFIG"

UNIT="$(render "$CONFIG" "$OUT")"
check "media root comes from paths.data_root" test "$UNIT" = "home-pi-pi\\x2dwallpaper\\x2dengine\\x2ddata.mount"
check "After= names the derived mount unit" grep -qxF "After=$UNIT" "$OUT"
check "Wants= names the derived mount unit" grep -qxF "Wants=$UNIT" "$OUT"
check "no RequiresMountsFor" bash -c "! grep -qi RequiresMountsFor '$OUT'"
check "no Requires= on the mount unit" bash -c "! grep -qxF \"Requires=$UNIT\" '$OUT'"
check "placeholder fully substituted" bash -c "! grep -q '@@' '$OUT'"
check "ExecStart and Environment survive rendering" grep -q '^ExecStart=/usr/bin/bun run packages/backend/src/index.ts$' "$OUT"

# ── a differing deployment path is not hardcoded ─────────────────────────────
OTHER="$WORK/config-other.json"
OTHER_OUT="$WORK/unit-other.service"
write_config "/srv/media" "$OTHER"

OTHER_UNIT="$(render "$OTHER" "$OTHER_OUT")"
check "a different media root yields a different unit" test "$OTHER_UNIT" = "srv-media.mount"
check "other unit is ordered after its own mount" grep -qxF "After=srv-media.mount" "$OTHER_OUT"
check "previous ordering does not leak into the re-render" test "$OTHER_UNIT" != "$UNIT"

# ── re-running over an existing output replaces it ───────────────────────────
render "$CONFIG" "$OTHER_OUT" >/dev/null
check "re-render overwrites the previous unit in place" grep -qxF "After=$UNIT" "$OTHER_OUT"
check "re-render leaves no stale ordering behind" bash -c "! grep -q 'srv-media.mount' '$OTHER_OUT'"

# ── a path needing real escaping ─────────────────────────────────────────────
ESCAPED="$WORK/config-escaped.json"
ESCAPED_OUT="$WORK/unit-escaped.service"
write_config "/mnt/My Share/media" "$ESCAPED"
ESCAPED_UNIT="$(render "$ESCAPED" "$ESCAPED_OUT")"
check "spaces in the path are escaped, not guessed" test "$ESCAPED_UNIT" = "mnt-My\\x20Share-media.mount"
check "escaped unit is used verbatim in After=" grep -qxF "After=$ESCAPED_UNIT" "$ESCAPED_OUT"

echo ""
if [ "$failures" -eq 0 ]; then
  printf '\033[32mAll service-unit checks passed.\033[0m\n'
else
  printf '\033[31m%d service-unit check(s) failed.\033[0m\n' "$failures" >&2
  exit 1
fi
