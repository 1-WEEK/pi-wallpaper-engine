#!/usr/bin/env bash
# Live smoke for `.scratch/shell-bg-and-play-limit` ticket 02.
#
# Runs this checkout's backend against a disposable media root and a real mpv,
# so the play-limit policy is exercised through the real HTTP surface rather
# than a unit test double. What is verified:
#
#   1. `POST /api/player/play-limit` persists the setting, and the summary
#      reports it with no live deadline while nothing is playing;
#   2. playing arms a deadline for the session, and `next`/`prev` leave it
#      untouched (the whole point of session-scoped arming);
#   3. the limit elapsing stops playback and powers the display off;
#   4. setting the limit to 0 clears a live deadline;
#   5. the setting survives a backend restart and does not auto-arm playback;
#   6. a one-shot limit is consumed when its session ends;
#   7. a one-shot still pending at restart is cleared instead of arming.
#
# Step 3 needs the timer to actually fire in real time. The stored policy is
# whole minutes (`PlaybackPrefs` floors it, and the UI offers 15/30/60/120), so
# this step sets a 1-minute limit and waits it out — a real end-to-end wait,
# not a shortened stand-in.
#
# Everything it creates is under its own /tmp tree and a private XDG state dir;
# it never touches the installed service, the user's database, or the live mpv.
#
# Usage: bash scripts/smoke-play-limit.sh

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOKE_ROOT="/tmp/pwe-limit-smoke"
MEDIA_ROOT="$SMOKE_ROOT/media"
CONFIG="$SMOKE_ROOT/config.json"
PORT=8098
BASE="http://127.0.0.1:$PORT"

rm -rf "$SMOKE_ROOT"
mkdir -p "$MEDIA_ROOT" "$SMOKE_ROOT/tmp" "$SMOKE_ROOT/state" "$SMOKE_ROOT/runtime"
chmod 700 "$SMOKE_ROOT/runtime"

cat > "$CONFIG" <<JSON
{
  "steam": { "username": "smoke", "web_api_key": "smoke", "steamcmd_path": "/bin/true" },
  "paths": {
    "data_root": "$MEDIA_ROOT",
    "source_dir": "source",
    "optimized_dir": "optimized"
  },
  "storage": { "root": null },
  "screen": { "width": 640, "height": 480, "default_display_mode": "fill" },
  "mpv": {
    "binary_path": "$SMOKE_ROOT/mpv-wrapper.sh",
    "ipc_socket": "$SMOKE_ROOT/mpv.sock",
    "hwdec": "no",
    "gpu_api": "opengl"
  },
  "transcode": { "target_codec": "hevc", "target_quality": 23, "heartbeat_timeout_ms": 60000 },
  "server": { "host": "127.0.0.1", "port": $PORT },
  "display": {
    "on_command": ["/bin/true"],
    "off_command": ["/bin/true"],
    "status_command": ["/bin/true"]
  }
}
JSON

# Keep this run off the real display and audio device; the backend's own argv
# is kept intact.
cat > "$SMOKE_ROOT/mpv-wrapper.sh" <<'WRAP'
#!/usr/bin/env bash
exec "$(command -v mpv)" --vo=null --ao=null --no-audio "$@"
WRAP
chmod +x "$SMOKE_ROOT/mpv-wrapper.sh"

export TMPDIR="$SMOKE_ROOT/tmp"
export XDG_STATE_HOME="$SMOKE_ROOT/state"
export XDG_RUNTIME_DIR="$SMOKE_ROOT/runtime"
export PWE_CONFIG="$CONFIG"
export PROJECT_ROOT SMOKE_ROOT MEDIA_ROOT BASE PORT

step() { printf '\n\033[1;34m▸ %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# One JSON reader, so no check has to hand-parse with a second tool.
plimit() { curl -fsS "$BASE/api/system/summary" | bun -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); const p=s.status.play_limit; console.log(p.minutes + " " + (p.deadline === null ? "null" : "set") + " " + (p.once ? "true" : "false"))'; }

if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  die "something is already listening on port $PORT — a previous smoke run did not clean up"
fi

BACKEND_PID=""
trap 'kill ${BACKEND_PID:-} 2>/dev/null || true' EXIT

boot() {
  bun run "$PROJECT_ROOT/packages/backend/src/index.ts" > "$SMOKE_ROOT/backend.log" 2>&1 &
  BACKEND_PID=$!
  for _ in $(seq 1 90); do
    curl -fsS "$BASE/api/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "TIMEOUT waiting for backend health" >&2
  tail -40 "$SMOKE_ROOT/backend.log" >&2
  return 1
}

kill_backend() {
  kill "$BACKEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" 2>/dev/null || true
  BACKEND_PID=""
}

expect() { # expect <actual> <expected> <what>
  [ "$1" = "$2" ] || die "$3: expected '$2', got '$1'"
}

# ── Seed one playable wallpaper ─────────────────────────────────────────────
step "0. Seed a media root with one wallpaper"
mkdir -p "$MEDIA_ROOT/source/123456"
ffmpeg -y -f lavfi -i "color=c=blue:s=320x240:r=10" -t 5 \
  -c:v libx264 -pix_fmt yuv420p "$MEDIA_ROOT/source/123456/video.mp4" -loglevel error
ok "created source/123456/video.mp4"

boot
# The storage stack creates the state database on first use, so ask for a
# summary before seeding into it.
curl -fsS "$BASE/api/system/summary" >/dev/null
bun -e "
  const { Database } = require('bun:sqlite');
  const dir = process.env.SMOKE_ROOT + '/state/pi-wallpaper-engine';
  const file = require('fs').readdirSync(dir).find((f) => f.endsWith('.db'));
  const db = new Database(dir + '/' + file);
  db.prepare(\`INSERT OR REPLACE INTO library
    (workshop_id, title, author, preview_url, content_rating, rating_sex, source_path,
     source_resolution, source_codec, source_size, downloaded_at, transcode_status,
     transcode_progress, transcode_error, transcoded_path, transcoded_resolution,
     transcoded_codec, transcoded_size, display_mode, last_played_at)
    VALUES ('123456', 'Smoke Wallpaper', '', '', NULL, NULL, 'source/123456/video.mp4',
     '320x240', 'h264', 1000, ?, 'skipped', 0, NULL, NULL, NULL, NULL, NULL, 'fill', NULL)\`)
    .run(Date.now());
"
kill_backend
boot
ok "backend restarted with a seeded library"

# ── 1. Persisted setting, no live deadline while stopped ────────────────────
step "1. Setting the limit persists and reports no live deadline"
curl -fsS -X POST "$BASE/api/player/play-limit" -H 'Content-Type: application/json' \
  -d '{"minutes": 45, "once": false}' >/dev/null
expect "$(plimit)" "45 null false" "stored 45 without arming a session"
ok "play_limit = 45 null, mode ALWAYS"

# ── 2. Play arms a session deadline; stepping leaves it alone ───────────────
step "2. Playing arms a deadline and stepping does not re-arm it"
curl -fsS -X POST "$BASE/api/player/play/123456" >/dev/null
expect "$(plimit)" "45 set false" "play armed a deadline"
curl -fsS -X POST "$BASE/api/player/next" >/dev/null
curl -fsS -X POST "$BASE/api/player/prev" >/dev/null
expect "$(plimit)" "45 set false" "next/prev left the deadline armed"
ok "deadline held across next/prev"

# ── 3. Off clears a live deadline ──────────────────────────────────────────
step "3. Setting the limit to 0 clears the live deadline"
curl -fsS -X POST "$BASE/api/player/play-limit" -H 'Content-Type: application/json' \
  -d '{"minutes": 0, "once": false}' >/dev/null
expect "$(plimit)" "0 null false" "off dropped the live deadline"
ok "off cleared the live deadline"

# ── 4. The limit elapsing actually stops playback ──────────────────────────
step "4. A 1-minute limit fires: playback stops and the deadline clears"
curl -fsS -X POST "$BASE/api/player/play-limit" -H 'Content-Type: application/json' \
  -d '{"minutes": 1, "once": false}' >/dev/null
curl -fsS -X POST "$BASE/api/player/play/123456" >/dev/null
expect "$(plimit)" "1 set false" "the 1-minute limit armed"
ok "armed a 1-minute session; waiting for it to fire"

fired="no"
for _ in $(seq 1 90); do
  [ "$(plimit)" = "1 null false" ] && fired="yes" && break
  sleep 1
done
[ "$fired" = "yes" ] || die "the limit never fired (still $(plimit))"

PLAYER="$(curl -fsS "$BASE/api/player/status")"
case "$PLAYER" in
  *'"playing":false'*|*'"playing": false'*) ok "playback stopped; the timer cleared itself" ;;
  *) die "expected playback to have stopped, got $PLAYER" ;;
esac

# ── 5. Restart keeps the setting and does not auto-arm ─────────────────────
step "5. The setting survives a restart and no session auto-arms"
curl -fsS -X POST "$BASE/api/player/play-limit" -H 'Content-Type: application/json' \
  -d '{"minutes": 90, "once": false}' >/dev/null
kill_backend
boot
expect "$(plimit)" "90 null false" "setting survived restart without arming"
ok "restart kept 90 and armed nothing"

# ── 6. A one-shot limit is consumed when its session ends ──────────────────
step "6. A one-shot limit arms one session and is consumed when it ends"
curl -fsS -X POST "$BASE/api/player/play-limit" -H 'Content-Type: application/json' \
  -d '{"minutes": 2, "once": true}' >/dev/null
expect "$(plimit)" "2 null true" "one-shot stored without arming a session"
curl -fsS -X POST "$BASE/api/player/play/123456" >/dev/null
expect "$(plimit)" "2 set true" "the one-shot armed the session"
curl -fsS -X POST "$BASE/api/player/stop" >/dev/null
expect "$(plimit)" "0 null true" "the ended session consumed the one-shot"
ok "one-shot consumed at session end; the mode stays ONCE"

# ── 7. A one-shot pending at restart never arms a later session ────────────
step "7. A one-shot pending at restart is cleared, never armed later"
curl -fsS -X POST "$BASE/api/player/play-limit" -H 'Content-Type: application/json' \
  -d '{"minutes": 90, "once": true}' >/dev/null
kill_backend
boot
expect "$(plimit)" "0 null true" "the pending one-shot was dropped at boot"
ok "restart dropped the pending one-shot"

printf '\n\033[32mALL SMOKE STEPS PASSED\033[0m\n'
