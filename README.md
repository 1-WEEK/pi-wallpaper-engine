# Pi Wallpaper Engine

Wallpaper Engine Video wallpaper player for Raspberry Pi 4B. The backend uses
Bun + Elysia to manage SteamCMD downloads, mpv fullscreen playback, and storage
migration. The frontend is a Vite + React web UI.

The current phase plays source video files directly. It does not transcode.
Non-Video Wallpaper Engine projects fail fast during download finalization and
partial files are cleaned up.

## Current Status

- Phase 1 is the active product line: browse, download, library management, mpv
  playback, display power controls, mobile UI, and declarative storage are
  implemented.
- Phase 2 transcoding is reserved but not wired. `TranscodeQueueNoop` is active,
  `transcode_jobs` and Worker protocol schemas are kept for the future, and the
  `@pwe/worker` package is still a placeholder.
- SMB storage is optional. The app can mount one SMB share, use a relative media
  path inside that share, and move `source/` plus `optimized/` between local and
  SMB storage.
- Application auth is not implemented yet. Keep the origin behind a trusted LAN,
  Cloudflare Access, or another external access-control layer if exposing it.

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

- Install system packages: mpv, ffmpeg, cifs-utils, gnome-keyring, rsync, and
  supporting tools
- Install box86 and the `/usr/local/bin/steamcmd` wrapper
- Install Bun workspace dependencies
- Build the frontend into `packages/frontend/dist/`
- Create and populate `config.json`
- Install the SMB storage helper and sudoers whitelist
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

Local media files live under `paths.data_root` in `source/` and `optimized/`.
The SQLite state database always stays local at:

```text
~/.local/state/pi-wallpaper-engine/
```

It does not move when the media storage mode changes.

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
- `@pwe/worker` — Phase 2 placeholder, not implemented in Phase 1

## Network Storage

By default, wallpapers are stored on the Pi's SD card. You can also configure
SMB network storage from **Settings** -> **Storage**.

The SMB form includes:

- Server address
- Share name
- Username
- Password
- Storage path

`Storage path` is a relative directory inside the SMB share, for example
`pi-wallpaper-engine`. With that value, files are stored at:

```text
<share>/pi-wallpaper-engine/source
<share>/pi-wallpaper-engine/optimized
```

The SMB share root must still contain the sentinel file:

```bash
touch .pwe-mounted-root
```

When switching between local and SMB storage with an existing library, the
backend migrates `source/` and `optimized/` in the background. Source files are
deleted only after the copy verifies successfully and the mode is committed.
New downloads are blocked while migration is running.

See [docs/optional-nas.md](docs/optional-nas.md) for details.

## Roadmap

Near-term work is ordered as:

1. Documentation cleanup and current-status roadmap. Done.
2. Player/display power linkage. Implemented; needs Pi manual validation.
3. Validate SMB storage migration on the real Pi/NAS setup.
4. Add Passkey authentication for the Cloudflare Tunnel deployment.
5. Implement the Phase 2 NAS transcoding Worker.

See [plans/roadmap.md](plans/roadmap.md) for the working roadmap.

## Validation And Troubleshooting

Run the full preflight:

```bash
bun run check
```

It checks config, Bun, mpv, SteamCMD, ffprobe, rsync, data directories, Steam
Web API access, SteamCMD login state, server port availability, SQLite state
storage, and the mpv hardware decode environment.

Uninstall instructions are in [docs/uninstall.md](docs/uninstall.md).
