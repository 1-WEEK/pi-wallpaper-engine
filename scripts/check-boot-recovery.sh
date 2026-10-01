#!/usr/bin/env bash
# Recorded evidence for ticket 02 of `.scratch/playback-mount-resilience`.
#
# Ticket 02 asks for two facts to be "verified and recorded, not assumed":
#
#   1. with the share deliberately unavailable at start, the service is still
#      running, `systemctl --user is-active` reports `active`, and the API
#      reports the media root as unavailable;
#   2. a wallpaper resumes with no manual action once the share is there.
#
# This drives the *installed* systemd unit — not a script pretending to be one —
# through both states, with an isolated config and an isolated state directory
# so the real deployment, database and wallpaper are untouched.
#
# It does NOT reboot. A reboot is the only way to exercise the boot-time
# ordering itself, and the ordering is known to be inert here (this service is a
# user unit; the shelf mounts are system units, so the name is unresolvable
# while the share is down — see docs/agents/development.md § Media-root ordering).
# What a reboot would additionally prove is that the desktop session comes up
# before the service; everything else on the ticket's list is covered here.
#
# The live deployment is restored on exit, including on failure.
#
# Usage: bash scripts/check-boot-recovery.sh

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user/pi-wallpaper-engine.service.d"
DROP_IN="$UNIT_DIR/zz-evidence.conf"
CHECK="/tmp/pwe-boot-evidence"
MEDIA_ROOT="$CHECK/media"
PORT=8113
BASE="http://127.0.0.1:$PORT"

failures=0
check() {
  local what="$1"
  shift
  if "$@"; then
    printf '  \033[32m✓\033[0m %s\n' "$what"
  else
    printf '  \033[31m✗ %s\033[0m\n' "$what" >&2
    failures=$((failures + 1))
  fi
}
step() { printf '\n\033[1;34m▸ %s\033[0m\n' "$1"; }

restore() {
  rm -f "$DROP_IN"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  systemctl --user restart pi-wallpaper-engine >/dev/null 2>&1 || true
}
trap restore EXIT

if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  echo "port $PORT is busy — refusing to run" >&2
  exit 1
fi

rm -rf "$CHECK"
mkdir -p "$CHECK/state"

# ── The isolated config: no auth (so the API can be read), a media root we
#    control, a headless mpv (this runs on the appliance's own display), and a
#    port that cannot collide with the real deployment.
cat > "$CHECK/mpv-wrapper.sh" <<'WRAP'
#!/usr/bin/env bash
# Evidence only: decode without touching the attached display or audio device.
exec "$(command -v mpv)" --vo=null --ao=null --no-audio "$@"
WRAP
chmod +x "$CHECK/mpv-wrapper.sh"

SRC="$HOME/.config/pi-wallpaper-engine/config.json" DST="$CHECK/config.json" \
  MEDIA="$MEDIA_ROOT" MPV="$CHECK/mpv-wrapper.sh" PORT="$PORT" bun -e '
    const fs = require("fs");
    const c = JSON.parse(fs.readFileSync(process.env.SRC, "utf-8"));
    delete c.auth;                      // read the API without a passkey
    c.storage.root = process.env.MEDIA;
    c.paths.data_root = process.env.MEDIA;
    c.mpv.binary_path = process.env.MPV;
    c.mpv.ipc_socket = process.env.MEDIA + ".sock";
    c.mpv.hwdec = "no";
    c.server.port = Number(process.env.PORT);
    c.display = { on_command: ["/bin/true"], off_command: ["/bin/true"], status_command: ["/bin/true"] };
    fs.writeFileSync(process.env.DST, JSON.stringify(c, null, 2));
  '

mkdir -p "$UNIT_DIR"
# Lexical order matters: override.conf is loaded first, so this must sort LAST
# or it is silently overridden (digits sort before letters).
cat > "$DROP_IN" <<EOF
[Service]
Environment=PWE_CONFIG=$CHECK/config.json
Environment=XDG_STATE_HOME=$CHECK/state
EOF

systemctl --user daemon-reload

seed() {
  bun -e '
    const { Database } = require("bun:sqlite");
    const dir = "/tmp/pwe-boot-evidence/state/pi-wallpaper-engine";
    const file = require("fs").readdirSync(dir).find((f) => f.endsWith(".db"));
    const db = new Database(dir + "/" + file);
    db.prepare(`INSERT OR REPLACE INTO library
      (workshop_id, title, author, preview_url, content_rating, rating_sex, source_path,
       source_resolution, source_codec, source_size, downloaded_at, transcode_status,
       transcode_progress, transcode_error, transcoded_path, transcoded_resolution,
       transcoded_codec, transcoded_size, display_mode, last_played_at)
      VALUES ("123456", "Evidence Wallpaper", "", "", NULL, NULL, "source/123456/video.mp4",
       "320x240", "h264", 1000, ?, "skipped", 0, NULL, NULL, NULL, NULL, NULL, "fill", NULL)`)
      .run(Date.now());
    db.prepare(`INSERT OR REPLACE INTO player_state
      (id, restore_workshop_id, restore_reason, updated_at)
      VALUES ("singleton", "123456", "media_lost", ?)`).run(Date.now());
  '
}

provide_share() {
  mkdir -p "$MEDIA_ROOT/source/123456"
  ffmpeg -y -f lavfi -i "color=c=blue:s=320x240:r=10" -t 3 \
    -c:v libx264 -pix_fmt yuv420p "$MEDIA_ROOT/source/123456/video.mp4" -loglevel error
}

wait_until() {
  local what="$1" tries="$2"
  shift 2
  for _ in $(seq 1 "$tries"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "TIMEOUT: $what" >&2
  return 1
}

# ── Boot with the share absent ───────────────────────────────────────────────
step "Start the unit with the media root absent"
# `restart`, not `start`: the unit is already running the real deployment, and
# starting an active unit is a no-op that would leave the old process (and its
# old config) in place.
systemctl --user restart pi-wallpaper-engine
wait_until "backend health" 60 curl -fsS "$BASE/api/health"
check "systemctl --user is-active reports active" \
  test "$(systemctl --user is-active pi-wallpaper-engine)" = "active"
check "the unit did not fail (Result=success, no restarts)" \
  grep -q "Result=success" <(systemctl --user show pi-wallpaper-engine -p Result)
check "the API reports the media root as unavailable" \
  grep -q '"available":false' <(curl -fsS "$BASE/api/storage")
check "the reported error names the causing path" \
  grep -q "$MEDIA_ROOT" <(curl -fsS "$BASE/api/storage")
echo "    $(curl -fsS "$BASE/api/storage" | bun -e 'const c=await new Response(Bun.stdin.stream()).json(); console.log(c.last_error)')"

# The service needs one run to create its state database before it can be seeded.
systemctl --user stop pi-wallpaper-engine
seed
systemctl --user start pi-wallpaper-engine
wait_until "backend health after seeding" 60 curl -fsS "$BASE/api/health"

# ── The share appears ────────────────────────────────────────────────────────
step "Make the share available; the wallpaper must resume with no manual action"
provide_share
if wait_until "wallpaper resumes by itself" 180 \
  bash -c "curl -fsS $BASE/api/player/status | grep -q '\"playing\":true'"; then
  check "the wallpaper resumed with no manual action" true
else
  check "the wallpaper resumed with no manual action" false
  tail -30 "$CHECK/backend.log" >&2 2>/dev/null || true
fi
echo "    $(curl -fsS "$BASE/api/player/status")"

step "The reported condition clears"
check "the API reports the media root as available again" \
  grep -q '"available":true' <(curl -fsS "$BASE/api/storage")
check "last_error is cleared" \
  grep -q '"last_error":null' <(curl -fsS "$BASE/api/storage")

echo ""
if [ "$failures" -eq 0 ]; then
  printf '\033[32mAll boot-recovery checks passed.\033[0m\n'
else
  printf '\033[31m%d check(s) failed.\033[0m\n' "$failures" >&2
  exit 1
fi
