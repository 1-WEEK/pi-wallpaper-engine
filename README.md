# Pi Wallpaper Engine

Wallpaper Engine Video wallpaper player for Raspberry Pi 4B. The backend uses
Bun + Elysia to manage SteamCMD downloads, mpv fullscreen playback, and storage
migration. The frontend is a Vite + React web UI.

By default the app plays source video files directly. When
`PWE_WORKER_API_KEY` is configured, Phase 2 transcoding is enabled and a
separate Worker can process jobs. Non-Video Wallpaper Engine projects fail fast
during download finalization and partial files are cleaned up.

## Current Status

- Phase 1 is the active product line: browse, download (cancelable, with live
  progress over WebSocket), library management, mpv playback with a live player
  WebSocket, playlist rotation (sequential/shuffle/single with prev/next and a
  configurable interval), a sleep timer, display power controls, mobile UI, and
  media-directory migration are implemented.
- Phase 2 transcoding is implemented but inactive by default. The `@pwe/worker`
  package is a working NAS-side ffmpeg worker (hardware HEVC/QSV with a libx265
  fallback, shipped as a Docker image). The Worker is a compute node: it
  downloads source bytes from the Pi and uploads the optimized artifact back;
  the Pi owns final storage placement. The Pi runs `TranscodeQueueNoop` until
  `PWE_WORKER_API_KEY` is set, which switches it to `TranscodeQueueLive` and
  mounts `/api/transcode/*`. Worker deployment is documented in
  [packages/worker/README.md](packages/worker/README.md).
- Optional Passkey authentication via Better Auth is implemented for public
  exposure (Cloudflare Tunnel, reverse proxy, etc.). Off by default for LAN-only
  setups. See [docs/auth.md](docs/auth.md) for the enable flow.

## Requirements

- Raspberry Pi 4B
- Debian 13 Trixie aarch64
- Bun 1.2+
- Steam Web API key
- SteamCMD account login

On the Pi, SteamCMD is installed through box86 plus Valve's official tarball.
Do not use Debian's `steamcmd:i386` package on Trixie aarch64.

## Install

Run from the project root on the Pi:

```bash
bash install-pi.sh
```

The installer will:

- Install system packages: mpv, ffmpeg, rsync, and supporting tools
- Install box86 and the `/usr/local/bin/steamcmd` wrapper
- Install Bun workspace dependencies
- Build the frontend into `packages/frontend/dist/`
- Create and populate `config.json`
- Check SteamCMD login state
- Run `bun run check`

By default, the installer stops after setup and preflight so you can run the app
in development mode. To also install and start the systemd user service:

```bash
bash install-pi.sh --service
```

## Configure

`config.json` is the local runtime config and is gitignored. On first install,
`install-pi.sh` copies `config.example.json` and asks for the key fields:

- `steam.username`
- `steam.web_api_key`
- `steam.steamcmd_path`
- `paths.data_root`

Local media files live under the current media directory in `source/` and
`optimized/`. By default this is `paths.data_root`; Settings can later switch to
another directory and migrate the existing files. The SQLite state database
always stays local at:

```text
~/.local/state/pi-wallpaper-engine/
```

It does not move when the media directory changes.

## Start

Start backend and frontend together in development mode:

```bash
bun run dev
```

Open:

```text
http://localhost:5173
http://<pi-ip>:5173
```

Start only the backend:

```bash
bun run dev:backend
```

Start only the frontend:

```bash
bun run dev:frontend
```

In service mode, the backend serves the built frontend on port 8080:

```bash
bun run service:start
bun run service:status
bun run service:restart
bun run service:stop
```

Follow logs:

```bash
journalctl --user -u pi-wallpaper-engine -f
```

To run production mode manually without systemd:

```bash
bun run build
bun run --filter @pwe/backend start
```

Open:

```text
http://<pi-ip>:8080
```

## Development

Common commands:

```bash
bun install
bun run dev
bun test
bun run typecheck
bun run check
bun run --filter @pwe/frontend build
```

Run a single test file:

```bash
bun test packages/backend/src/transcode/decide.test.ts
```

The backend entrypoint is `packages/backend/src/index.ts`. Effect Layer assembly
lives in `packages/backend/src/runtime.ts`. The frontend entrypoint is
`packages/frontend/src/App.tsx`.

The Vite dev server listens on port 5173, binds to `0.0.0.0`, and proxies
`/api` to the backend.

Workspace packages:

- `@pwe/shared` — schemas, tagged errors, shared browser/backend types
- `@pwe/backend` — Elysia API, Effect services, mpv, SteamCMD, storage
- `@pwe/frontend` — Vite + React UI
- `@pwe/migrate` — small rsync wrapper used by storage migration
- `@pwe/worker` — NAS-side ffmpeg transcode worker (Phase 2), shipped as a
  Docker image; inactive until `PWE_WORKER_API_KEY` is set on the Pi

## Media Directory

By default, wallpapers are stored under `paths.data_root` on the Pi. In
**Settings** → **Storage**, you can:

- browse a limited set of safe root directories
- enter subdirectories and create a new directory
- validate the selected target before applying it
- migrate `source/` and `optimized/` to the new directory in the background

If the library is empty, switching only updates the active directory. If the
library already has wallpapers, the backend copies files first, verifies the
result, updates `storage.root`, and only then removes the old files. Downloads
are blocked while migration is running.

## Roadmap

Open near-term work:

1. Validate media-directory migration on the real Pi with removable storage.
2. Deploy and validate the Phase 2 transcode Worker on a real NAS.

See [plans/roadmap.md](plans/roadmap.md) for the working roadmap and history of
completed items.

## Validation And Troubleshooting

Run the full preflight:

```bash
bun run check
```

It checks config, Bun, mpv, SteamCMD, ffprobe, rsync, data directories, Steam
Web API access, SteamCMD login state, server port availability, SQLite state
storage, and the mpv hardware decode environment.

Uninstall instructions are in [docs/uninstall.md](docs/uninstall.md).
