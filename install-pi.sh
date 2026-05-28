#!/usr/bin/env bash
# Pi Wallpaper Engine — one-shot installer for Raspberry Pi 4B running Debian 13 aarch64.
# Idempotent: re-runnable, skips steps already completed.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

# --service: also install + enable the systemd user unit (deploy mode).
# Default behaviour is dev — install deps, run preflight, exit. User then runs
# `bun run dev:backend` manually.
INSTALL_SERVICE=0
for arg in "$@"; do
  case "$arg" in
    --service) INSTALL_SERVICE=1 ;;
    --help|-h)
      cat <<'USAGE'
Usage: bash install-pi.sh [--service]

  --service   Also install and enable the pi-wallpaper-engine systemd user
              unit. By default the installer stops after preflight so you can
              run `bun run dev:backend` manually during development.
USAGE
      exit 0
      ;;
  esac
done

step() { printf "\n\033[1;34m▶ %s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m⚠\033[0m %s\n" "$1"; }
err()  { printf "  \033[31m✗\033[0m %s\n" "$1" >&2; }

# ── 1. Sanity: OS + arch ──────────────────────────────────────────────────────
step "Checking environment"
if [ "$(uname -m)" != "aarch64" ]; then
  err "This installer is for aarch64 (Raspberry Pi 4B). Detected: $(uname -m)"
  exit 1
fi
ok "Architecture: aarch64"

if [ ! -f /etc/os-release ]; then
  err "No /etc/os-release — unsupported OS"
  exit 1
fi
. /etc/os-release
ok "OS: ${PRETTY_NAME:-unknown}"

# ── 2. sudo check ─────────────────────────────────────────────────────────────
if ! sudo -n true 2>/dev/null; then
  warn "This script will use sudo. You may be prompted for your password."
fi

# ── 3. APT packages (mpv, ffmpeg, deps for box86 install) ─────────────────────
# Note: Debian's steamcmd package is broken on Trixie/aarch64 (libc6:i386
# version conflict with libc6:arm64 2.41+). We install SteamCMD via box86 +
# Valve's official tarball below instead.
step "Installing system packages (mpv ffmpeg + tools)"
sudo apt-get update -qq
sudo apt-get install -y mpv ffmpeg wget gpg ca-certificates rsync
ok "System packages installed"

# ── 4. box86 (x86 binary translator for SteamCMD) ─────────────────────────────
step "Installing box86 (for SteamCMD)"
# box86 is an armhf binary — needs armhf multiarch + libc6:armhf to run on aarch64
if ! dpkg --print-foreign-architectures | grep -q armhf; then
  sudo dpkg --add-architecture armhf
  ok "Added armhf foreign architecture"
fi

if command -v box86 >/dev/null 2>&1 && box86 --version >/dev/null 2>&1; then
  ok "box86 already present and runnable"
else
  BOX86_KEY="/usr/share/keyrings/box86-archive-keyring.gpg"
  BOX86_LIST="/etc/apt/sources.list.d/box86.list"
  if [ ! -s "$BOX86_KEY" ]; then
    sudo wget -O "$BOX86_KEY" https://Itai-Nelken.github.io/weekly-box86-debs/debian/KEY.gpg
    ok "Added box86 signing key"
  fi
  if [ ! -f "$BOX86_LIST" ]; then
    echo "deb [signed-by=$BOX86_KEY] https://Itai-Nelken.github.io/weekly-box86-debs/debian ./" \
      | sudo tee "$BOX86_LIST" >/dev/null
    ok "Added box86 apt source"
  fi
  sudo apt-get update -qq
  # libc6:armhf must be installed alongside box86 — apt resolves it but we list
  # it explicitly so the user sees what's going in
  sudo apt-get install -y libc6:armhf box86
  ok "box86 installed"
fi

# ── 5. SteamCMD tarball + wrapper ─────────────────────────────────────────────
step "Installing SteamCMD via box86"
STEAMCMD_DIR="$HOME/.local/share/steamcmd"
STEAMCMD_WRAPPER="/usr/local/bin/steamcmd"

if [ ! -f "$STEAMCMD_DIR/steamcmd.sh" ]; then
  mkdir -p "$STEAMCMD_DIR"
  ( cd "$STEAMCMD_DIR" && \
    wget -q https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz && \
    tar -xzf steamcmd_linux.tar.gz && \
    rm steamcmd_linux.tar.gz )
  ok "SteamCMD tarball extracted to $STEAMCMD_DIR"
else
  ok "SteamCMD tarball already at $STEAMCMD_DIR"
fi

if [ ! -x "$STEAMCMD_WRAPPER" ]; then
  sudo tee "$STEAMCMD_WRAPPER" >/dev/null <<EOF
#!/bin/bash
# Pi Wallpaper Engine wrapper: run Valve's x86 SteamCMD via box86.
cd "\$HOME/.local/share/steamcmd" || exit 1
exec box86 ./steamcmd.sh "\$@"
EOF
  sudo chmod +x "$STEAMCMD_WRAPPER"
  ok "Wrote wrapper $STEAMCMD_WRAPPER"
else
  ok "SteamCMD wrapper already at $STEAMCMD_WRAPPER"
fi

# First-run self-update — fetches linux32/ subdirectory needed for actual ops.
# Run quietly; if it fails the user will see it in the SteamCMD step below.
if [ ! -d "$STEAMCMD_DIR/linux32" ]; then
  warn "SteamCMD has not self-updated yet — running once to download linux32/..."
  "$STEAMCMD_WRAPPER" +quit || warn "First SteamCMD run reported errors — may be normal on first launch"
fi
ok "SteamCMD ready"

# ── 6. Bun runtime ────────────────────────────────────────────────────────────
step "Installing Bun"
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  ok "Bun installed"
else
  ok "Bun already present ($(bun --version))"
fi

# ── 7. Workspace deps ─────────────────────────────────────────────────────────
step "Installing workspace dependencies"
bun install
ok "Dependencies installed"

# ── 8. Build frontend ─────────────────────────────────────────────────────────
step "Building frontend"
bun run --filter @pwe/frontend build
ok "Frontend built to packages/frontend/dist/"

# ── 9. config.json interactive setup ─────────────────────────────────────────
step "Configuring"
CONFIG_DIR="$HOME/.config/pi-wallpaper-engine"
CONFIG_PATH="$CONFIG_DIR/config.json"
mkdir -p "$CONFIG_DIR"
DEFAULT_DATA_ROOT="$HOME/pi-wallpaper-engine-data"
if [ ! -f "$CONFIG_PATH" ]; then
  cp config.example.json "$CONFIG_PATH"
  ok "Copied config.example.json → $CONFIG_PATH"

  echo ""
  read -rp "Steam username: " STEAM_USER
  echo ""
  echo "Get a free Steam Web API key at: https://steamcommunity.com/dev/apikey"
  read -rp "Steam Web API key: " STEAM_KEY
  echo ""
  read -rp "Data root [${DEFAULT_DATA_ROOT}]: " DATA_ROOT
  DATA_ROOT="${DATA_ROOT:-$DEFAULT_DATA_ROOT}"

  bun -e "
    const fs = require('fs');
    const path = process.env.CONFIG_PATH;
    const c = JSON.parse(fs.readFileSync(path, 'utf-8'));
    c.steam.username = process.argv[1];
    c.steam.web_api_key = process.argv[2];
    c.steam.steamcmd_path = process.argv[3];
    c.paths.data_root = process.argv[4];
    fs.writeFileSync(path, JSON.stringify(c, null, 2));
  " "$STEAM_USER" "$STEAM_KEY" "$STEAMCMD_WRAPPER" "$DATA_ROOT"
  ok "config.json populated"
else
  ok "config.json already exists — leaving unchanged"
  # Patch steamcmd_path in case the user upgraded from an older config
  CURRENT_STEAMCMD="$(CONFIG_PATH="$CONFIG_PATH" bun -e "console.log(JSON.parse(require('fs').readFileSync(process.env.CONFIG_PATH,'utf-8')).steam.steamcmd_path)")"
  if [ "$CURRENT_STEAMCMD" = "/usr/games/steamcmd" ]; then
    CONFIG_PATH="$CONFIG_PATH" bun -e "
      const fs = require('fs');
      const path = process.env.CONFIG_PATH;
      const c = JSON.parse(fs.readFileSync(path, 'utf-8'));
      c.steam.steamcmd_path = process.argv[1];
      fs.writeFileSync(path, JSON.stringify(c, null, 2));
    " "$STEAMCMD_WRAPPER"
    ok "Updated stale steamcmd_path → $STEAMCMD_WRAPPER"
  fi
fi

DATA_ROOT="$(CONFIG_PATH="$CONFIG_PATH" bun -e "console.log(JSON.parse(require('fs').readFileSync(process.env.CONFIG_PATH,'utf-8')).paths.data_root)")"
DATA_ROOT="${DATA_ROOT/#\~/$HOME}"
mkdir -p "$DATA_ROOT/source" "$DATA_ROOT/optimized"
ok "Created $DATA_ROOT/{source,optimized}"

# ── 10. Generate mpv test asset for preflight ────────────────────────────────
step "Generating mpv test asset"
TEST_ASSET="$PROJECT_ROOT/packages/backend/src/test-assets/sample-1080p.mp4"
if [ ! -f "$TEST_ASSET" ]; then
  ffmpeg -y -f lavfi -i "color=c=blue:s=1920x1080:r=30" -t 5 -c:v libx264 -pix_fmt yuv420p "$TEST_ASSET" -loglevel error
  ok "Generated $TEST_ASSET"
else
  ok "Test asset already present"
fi

# ── 11. SteamCMD login (manual, requires user interaction for 2FA) ────────────
step "Checking SteamCMD login state"
STEAM_USER="$(CONFIG_PATH="$CONFIG_PATH" bun -e "console.log(JSON.parse(require('fs').readFileSync(process.env.CONFIG_PATH,'utf-8')).steam.username)")"
# SteamCMD records auth in ~/Steam/config/config.vdf under "Accounts" + "ConnectCache".
# Successful login leaves an entry like:
#   "Accounts" { "<user>" { "SteamID" "..." } }
if [ -f "$HOME/Steam/config/config.vdf" ] && grep -q "\"$STEAM_USER\"" "$HOME/Steam/config/config.vdf" 2>/dev/null; then
  ok "SteamCMD session for $STEAM_USER exists"
else
  warn "SteamCMD has not been logged in as $STEAM_USER yet."
  echo ""
  echo "  Open another terminal and run (it will prompt for password + Steam Guard 2FA):"
  echo ""
  echo "    steamcmd +login $STEAM_USER"
  echo ""
  echo "  After SteamCMD shows 'Logged in OK' and exits, return here and press ENTER."
  read -rp "  Press ENTER when done... "
fi

# ── 12. Preflight diagnostics ─────────────────────────────────────────────────
step "Running preflight diagnostics"
if ! bun run check; then
  err "Preflight failed. Fix the issues above and re-run install-pi.sh."
  exit 1
fi

# ── 13. systemd user unit (deploy mode only) ─────────────────────────────────
PI_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
PORT="$(CONFIG_PATH="$CONFIG_PATH" bun -e "console.log(JSON.parse(require('fs').readFileSync(process.env.CONFIG_PATH,'utf-8')).server.port)")"

if [ "$INSTALL_SERVICE" -eq 1 ]; then
  step "Installing systemd user service"
  mkdir -p "$HOME/.config/systemd/user"
  SERVICE_DST="$HOME/.config/systemd/user/pi-wallpaper-engine.service"
  BUN_BIN="$(command -v bun)"
  if [ -z "$BUN_BIN" ]; then
    err "Cannot find 'bun' binary — abort"
    exit 1
  fi
  sed "s|@@PROJECT_ROOT@@|$PROJECT_ROOT|g; s|@@HOME@@|$HOME|g; s|@@BUN_BIN@@|$BUN_BIN|g" \
    "$PROJECT_ROOT/pi-wallpaper-engine.service" > "$SERVICE_DST"
  ok "Wrote $SERVICE_DST"

  if ! loginctl show-user "$USER" 2>/dev/null | grep -q "Linger=yes"; then
    sudo loginctl enable-linger "$USER"
    ok "Enabled linger for $USER"
  else
    ok "Linger already enabled"
  fi

  systemctl --user daemon-reload
  systemctl --user enable --now pi-wallpaper-engine.service
  ok "Service enabled and started"

  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "  Pi Wallpaper Engine is running as a service."
  echo ""
  echo "  Web UI:    http://${PI_IP:-<pi-ip>}:${PORT}"
  echo "  Logs:      journalctl --user -u pi-wallpaper-engine -f"
  echo "  Restart:   systemctl --user restart pi-wallpaper-engine"
  echo "  Stop:      systemctl --user stop pi-wallpaper-engine"
  echo "════════════════════════════════════════════════════════════"
else
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "  Setup complete. Ready for development."
  echo ""
  echo "  Start everything:   bun run dev          (frontend + backend)"
  echo "  Backend only:       bun run dev:backend  (port ${PORT}, no HMR)"
  echo "  Frontend only:      bun run dev:frontend (port 5173, with HMR)"
  echo "  Tests:              bun test"
  echo "  Re-check:           bun run check"
  echo ""
  echo "  Dev UI (HMR):       http://${PI_IP:-<pi-ip>}:5173"
  echo ""
  echo "  When ready to deploy as a background service:"
  echo "  bash install-pi.sh --service"
  echo "════════════════════════════════════════════════════════════"
fi
