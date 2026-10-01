#!/usr/bin/env bash
# Live smoke for `.scratch/playback-mount-resilience` ticket 01.
#
# Runs this checkout's backend, unmodified, in a private mount namespace against
# a disposable media root, so the media root can be made to disappear and come
# back underneath a running process. What is verified, through the real HTTP
# surface and a real mpv:
#
#   1. a wallpaper plays from a mounted media root;
#   2. the root vanishing is reported by `GET /api/storage` as an explicit
#      unavailable condition whose `last_error` names the causing path;
#   3. when the current file stops while the root is down, the backend stops
#      reporting it as playing, holds the wallpaper, and says why;
#   4. the root returning makes the backend restore that wallpaper by itself —
#      no service restart, no user action — and clears the reported error.
#
# On the mid-playback file stop: a locally-mounted media root cannot be made to
# fail reads under an open file (mpv keeps reading from its fd and the page
# cache; `umount` is refused while it holds the file). The file stop is
# therefore induced through mpv's own IPC socket, which is honest here: the
# backend's decision is driven by the `end-file` event plus a probe of the root,
# and it cannot tell — and must not need to tell — how the end came about.
#
# Everything it creates is under /tmp; nothing touches the installed service,
# the user's database, or the running mpv.
#
# Usage: bash scripts/smoke-media-root-recovery.sh

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOKE_ROOT="/tmp/pwe-smoke"
INSIDE_ROOT="/tmp/pwe-mnt/media"
CONFIG="$SMOKE_ROOT/config.json"
PORT=8099

rm -rf "$SMOKE_ROOT"
mkdir -p "$SMOKE_ROOT" "$SMOKE_ROOT/media"

# Locked down to the transport: mpv must decode without touching this
# machine's GPU or audio, so the smoke cannot disturb the running wallpaper.
cat > "$CONFIG" <<JSON
{
  "steam": { "username": "smoke", "web_api_key": "smoke", "steamcmd_path": "/bin/true" },
  "paths": {
    "data_root": "$INSIDE_ROOT",
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

# The backend owns mpv's argv. `mpv.*` config carries flags, not extra argv, so
# the smoke wraps the binary to append the transport that keeps this run off the
# real display and audio device.
cat > "$SMOKE_ROOT/mpv-wrapper.sh" <<'WRAP'
#!/usr/bin/env bash
# Smoke only: force a headless, silent mpv. The backend's own flags are kept.
exec "$(command -v mpv)" --vo=null --ao=null --no-audio "$@"
WRAP
chmod +x "$SMOKE_ROOT/mpv-wrapper.sh"

cat > "$SMOKE_ROOT/run-inside.sh" <<'INNER'
#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:?PROJECT_ROOT must be exported by the caller}"
SMOKE_ROOT=/tmp/pwe-smoke
INSIDE_ROOT=/tmp/pwe-mnt/media
CONFIG="$SMOKE_ROOT/config.json"
PORT=8099
BASE="http://127.0.0.1:$PORT"
MPV_SOCK="$SMOKE_ROOT/mpv.sock"

# A previous run that was interrupted can leave its backend and mpv behind
# (they are reparented, not killed, when the namespace dies). Talking to a
# stray backend on this port would silently invalidate every check below, so
# refuse to run rather than report a false result.
if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  echo "FAIL: something is already listening on port $PORT — a previous smoke run did not clean up" >&2
  echo "      kill it and re-run: pkill -f pwe-smoke" >&2
  exit 1
fi

# A previous run's mountpoint directory lives on the host's /tmp (mounts made
# inside a private namespace do not), and a directory that exists is exactly
# what "the media root is available" means. Clear it so the run really does
# start with the share absent.
rm -rf /tmp/pwe-mnt

mkdir -p "$SMOKE_ROOT/tmp" "$SMOKE_ROOT/media"
export TMPDIR="$SMOKE_ROOT/tmp"
export XDG_STATE_HOME="$SMOKE_ROOT/state"
export PWE_CONFIG="$CONFIG"
export XDG_RUNTIME_DIR="$SMOKE_ROOT/runtime"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

step() { printf '\n\033[1;34m▸ %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# mpv IPC, for the induced file stop (see the script header).
mpv_cmd() {
  SOCK="$MPV_SOCK" CMD="$1" bun -e "
    const socket = await Bun.connect({
      unix: process.env.SOCK,
      socket: { data() {}, error() {}, close() {} },
    });
    socket.write(JSON.stringify({ command: JSON.parse(process.env.CMD) }) + '\n');
    await Bun.sleep(200);
    socket.end();
  "
}

status()  { curl -fsS "$BASE/api/storage"; }
player()  { curl -fsS "$BASE/api/player/status"; }

wait_until() {
  local what="$1"; shift
  for _ in $(seq 1 120); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "TIMEOUT waiting for: $what" >&2
  tail -30 "$SMOKE_ROOT/backend.log" >&2
  return 1
}

create_media() {
  mkdir -p "$INSIDE_ROOT/source/123456"
  ffmpeg -y -f lavfi -i "color=c=blue:s=320x240:r=10" -t 3 \
    -c:v libx264 -pix_fmt yuv420p "$INSIDE_ROOT/source/123456/video.mp4" -loglevel error
}

# ── The media root is deliberately absent at boot: the late-mount case ───────
# Two boots, not one: the first creates and seeds the state database, the
# second is the boot whose startup restore has to survive the missing mount.
# Seeding a running backend instead would race its startup restore.
step "0. Seed state, then boot with the media root not mounted"
bun run "$PROJECT_ROOT/packages/backend/src/index.ts" > "$SMOKE_ROOT/seed.log" 2>&1 &
SEED_PID=$!
BACKEND_PID=""
# Guarded: the trap is installed before BACKEND_PID has a value, and `set -u`
# would otherwise turn a failure in between into "unbound variable" instead of
# the real error — while leaking the seed backend on port 8099.
trap 'kill ${SEED_PID:-} ${BACKEND_PID:-} 2>/dev/null || true' EXIT

wait_until "backend health" curl -fsS "$BASE/api/health"
ok "backend is up"

# Layers are built on first use, so the state database only exists once
# something asks the storage stack for an answer.
curl -fsS "$BASE/api/storage" >/dev/null
wait_until "state database created" test -d "$SMOKE_ROOT/state/pi-wallpaper-engine"
ok "state database exists"

# Seed one library row pointing at the file that will appear on the share, and
# a restore hold, exactly as a previous session would have left them.
bun -e "
  const { Database } = require('bun:sqlite');
  const dir = '$SMOKE_ROOT/state/pi-wallpaper-engine';
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
  db.prepare(\`INSERT OR REPLACE INTO player_state
    (id, restore_workshop_id, restore_reason, updated_at)
    VALUES ('singleton', '123456', 'display_off', ?)\`).run(Date.now());
"
ok "seeded a library row and a wallpaper to restore"

kill "$SEED_PID" 2>/dev/null || true
wait "$SEED_PID" 2>/dev/null || true
wait_until "smoke port released" bash -c "! ss -ltn 2>/dev/null | grep -q ':$PORT '"

bun run "$PROJECT_ROOT/packages/backend/src/index.ts" > "$SMOKE_ROOT/backend.log" 2>&1 &
BACKEND_PID=$!
wait_until "backend health" curl -fsS "$BASE/api/health"
ok "backend booted with the share absent"

# ── 1. The absent media root is reported as such ────────────────────────────
step "1. An absent media root is an explicit, named condition"
wait_until "storage reports unavailable" bash -c "curl -fsS $BASE/api/storage | grep -q '\"available\":false'"
status | tee "$SMOKE_ROOT/1-down.json"
grep -q 'pwe-mnt/media' "$SMOKE_ROOT/1-down.json" \
  || die "last_error does not name the causing path"
ok "available=false with the causing path in last_error"

# ── 2. The mount arrives late: the backend resumes on its own ───────────────
grep -q 'Could not restore 123456 on startup' "$SMOKE_ROOT/backend.log" \
  || die "the startup restore did not attempt-and-fail as the ticket describes"
ok "startup restore failed against the absent share"

step "2. Mount the share late; the wallpaper must resume with no user action"
mkdir -p "$INSIDE_ROOT"
mount -t tmpfs -o size=64m tmpfs "$INSIDE_ROOT"
create_media
ok "share mounted and populated"

wait_until "wallpaper resumed" bash -c "curl -fsS $BASE/api/player/status | grep -q '\"playing\":true'"
player
grep -q 'after the media root came back' "$SMOKE_ROOT/backend.log" \
  || die "recovery was not logged"
ok "restored by itself: $(player)"

step "3. Recovery clears the reported error"
status | tee "$SMOKE_ROOT/3-up.json"
grep -q '"available":true' "$SMOKE_ROOT/3-up.json" || die "storage still unavailable after recovery"
grep -q '"last_error":null' "$SMOKE_ROOT/3-up.json" || die "last_error did not clear"
ok "available=true and last_error=null"

# ── 4. The file stops while the share is down ───────────────────────────────
step "4. A file that stops while the share is down is held, and named"
# Lazy, because mpv holds the video open and refuses a plain umount. The
# underlying directory then has to go as well: a lazy unmount detaches the
# filesystem but leaves the mountpoint path behind, and a path that exists and
# is accessible is exactly what "the media root is available" means.
umount -l "$INSIDE_ROOT"
rm -rf "$INSIDE_ROOT"
wait_until "storage reports unavailable again" \
  bash -c "curl -fsS $BASE/api/storage | grep -q '\"available\":false'"

# mpv still holds the old file open and keeps looping from it; end that state
# the way a dying share does, with an `end-file` the backend observes.
mpv_cmd '["loadfile","/tmp/pwe-mnt/media/source/123456/gone.mp4","replace"]'

wait_until "player converges to not-playing" bash -c "curl -fsS $BASE/api/player/status | grep -q '\"playing\":false'"
player
grep -q 'because the media root is unavailable' "$SMOKE_ROOT/backend.log" \
  || die "no log line naming the media-root loss"
ok "converged to not-playing and logged the cause"

step "5. The share returns again: the held wallpaper comes back"
mkdir -p "$INSIDE_ROOT"
mount -t tmpfs -o size=64m tmpfs "$INSIDE_ROOT"
create_media

wait_until "wallpaper resumed a second time" bash -c "curl -fsS $BASE/api/player/status | grep -q '\"playing\":true'"
ok "resumed again: $(player)"

status | tee "$SMOKE_ROOT/5-up.json"
grep -q '"available":true' "$SMOKE_ROOT/5-up.json" || die "storage still unavailable"
ok "storage available and clear"

echo ""
printf '\033[32mALL SMOKE STEPS PASSED\033[0m\n'
INNER

chmod +x "$SMOKE_ROOT/run-inside.sh"

echo "Running smoke inside a private mount namespace (media root: $INSIDE_ROOT)"
export PROJECT_ROOT
# --kill-child: when this script is interrupted (or `timeout` fires), everything
# unshare started dies with it, instead of being reparented and left listening
# on the smoke port.
unshare --mount --map-root-user --propagation private --kill-child \
  bash "$SMOKE_ROOT/run-inside.sh"
