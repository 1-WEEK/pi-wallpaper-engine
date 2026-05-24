# Pi Wallpaper Engine — Current Project Spec (v4)

> Updated: 2026-05-24. This supersedes the old v3 assumption that NAS
> transcoding is required for the mainline product. The current implementation
> is a Phase 1 direct-play player with optional managed SMB storage. Phase 2
> transcoding remains reserved but is not wired.

## Product Goal

Run a Wallpaper Engine **Video** wallpaper player on a Raspberry Pi 4B. The web
UI browses Steam Workshop, starts SteamCMD downloads, stores downloaded video
wallpapers, and controls mpv fullscreen loop playback on the Pi-attached display.

Current baseline:

- Video wallpapers only. `project.json.type !== "video"` fails fast during
  download finalization and the partial `source/<id>/` directory is cleaned up.
- Source files are played directly by mpv. No transcoding runs in Phase 1.
- Storage can be local SD/SSD or one SMB share managed by the app.
- The SQLite state DB is always local and never follows media storage.
- Application-layer auth is not implemented yet.

## Runtime Environment

| Item | Current assumption |
|---|---|
| Device | Raspberry Pi 4B |
| OS | Debian GNU/Linux 13 (Trixie) aarch64 |
| Runtime | Bun 1.2+ |
| Backend | Elysia + Effect-TS on port 8080 |
| Frontend | Vite + React, dev port 5173 |
| Player | mpv spawned by backend, JSON IPC over Unix socket |
| Download | Valve SteamCMD tarball through box86 wrapper at `/usr/local/bin/steamcmd` |
| Storage | local `paths.data_root` or app-managed SMB share |
| State DB | `~/.local/state/pi-wallpaper-engine/pi-wallpaper-engine.db` |

Do not use Debian's `steamcmd:i386` package on Trixie aarch64. The installer
sets up armhf multiarch, box86, Valve's official SteamCMD tarball, and the
wrapper script.

## Workspace Layout

```text
pi-wallpaper-engine/
├── packages/shared     # Effect Schema, tagged errors, shared API/data types
├── packages/backend    # Elysia routes, Effect services, DB, mpv, SteamCMD
├── packages/frontend   # Vite + React app
├── packages/migrate    # rsync copy/verify/remove helpers for storage moves
├── packages/worker     # Phase 2 placeholder only
├── docs                # operator docs
├── plans               # design records and implementation plans
├── scripts             # privileged SMB helper source
└── install-pi.sh       # Pi installer and preflight driver
```

## Architecture

```text
Browser
  -> Vite dev server :5173, or backend static frontend :8080
  -> Elysia routes
  -> Effect ManagedRuntime
       ├─ SteamWorkshop: Steam Web API search/details
       ├─ SteamCmd: async Workshop download through box86 SteamCMD
       ├─ WallpaperFile + ffprobe: resolve project.json and video metadata
       ├─ Library: relative media paths in SQLite
       ├─ DownloadTasks: SQLite-backed task progress and startup reconcile
       ├─ Storage: local root or one SMB root, 30s reconcile loop
       ├─ Migrate: background rsync media moves between roots
       ├─ Mpv: backend-owned mpv process + queued IPC commands
       ├─ Display: optional argv-based display power commands
       ├─ PlayerState/PlayerPower: display-off restore intent and power saving
       └─ TranscodeQueueNoop: Phase 1 marks all rows skipped
```

Effect is used inside services for resource lifecycle, typed failures, DB
transactions, background fibers, and cancellation semantics. HTTP route handlers
remain ordinary Elysia handlers bridged through `runtime.runPromise(...)`.

Layer assembly in `packages/backend/src/runtime.ts` uses chained
`Layer.provideMerge(...)`. Do not replace it with `Layer.mergeAll(...)`; the
dependencies are cross-linked and order-sensitive.

## Storage Model

Media paths stored in SQLite are relative paths, for example:

```text
source/<workshopId>/.../wallpaper.mp4
optimized/<workshopId>.mp4
```

At runtime every consumer resolves through `Storage.mediaRoot()`.

Local mode:

```text
paths.data_root/source
paths.data_root/optimized
```

SMB mode:

```text
/run/pwe/mounts/smb/<smb.path>/source
/run/pwe/mounts/smb/<smb.path>/optimized
```

`storage.smb.path` is a relative media directory inside the share. Empty path is
allowed for compatibility with share-root storage, but the UI defaults new
configs to `pi-wallpaper-engine`.

The SMB share root must contain:

```text
.pwe-mounted-root
```

The backend mounts through `/usr/local/lib/pwe-storage-helper` via sudoers
NOPASSWD. Backend code never calls `mount` directly. SMB credentials are stored
with `Bun.secrets`, not in `config.json`.

Switching storage mode with a non-empty library starts a background migration:

1. Copy every media directory (`source/`, `optimized/`) to the target root.
2. Verify every directory with rsync dry-run.
3. Persist the target `storage.mode`.
4. Delete the old source directories.
5. For NAS→local, unmount SMB only after remote cleanup.

Downloads are blocked while migration runs. Migration is rejected if mpv is
currently playing from the source root.

## Configuration

`config.example.json` is the current schema shape:

```json
{
  "steam": {
    "username": "",
    "web_api_key": "",
    "steamcmd_path": "/usr/local/bin/steamcmd"
  },
  "paths": {
    "data_root": "",
    "source_dir": "source",
    "optimized_dir": "optimized"
  },
  "storage": {
    "mode": "local",
    "smb": null
  },
  "screen": {
    "width": 1200,
    "height": 1080,
    "default_display_mode": "fill"
  },
  "mpv": {
    "binary_path": "mpv",
    "ipc_socket": "/tmp/pi-wallpaper-engine-mpv.sock",
    "hwdec": "auto",
    "gpu_api": "opengl"
  },
  "transcode": {
    "target_codec": "hevc",
    "target_quality": 23,
    "heartbeat_timeout_ms": 60000
  },
  "server": {
    "host": "0.0.0.0",
    "port": 8080
  },
  "display": {
    "on_command": ["display-on"],
    "off_command": ["display-off"],
    "status_command": ["display-status"]
  }
}
```

`display` is optional. Commands are argv arrays run directly with `Bun.spawn`,
without shell parsing. Missing display config makes `/api/display/*` return 503
without affecting download, storage, or playback.

## API Surface

Implemented routes:

```text
GET  /api/health

GET  /api/workshop/search?q=&cursor=&pageSize=&tags=&sort=
GET  /api/workshop/item/:workshopId

POST /api/download/:workshopId              # returns 202; workflow continues in background
GET  /api/download/tasks
DELETE /api/download/tasks/:workshopId      # dismisses a task row; not SteamCMD cancellation
WS   /api/download/progress/:workshopId

GET    /api/library
PATCH  /api/library/:workshopId             # display_mode only
DELETE /api/library/:workshopId

POST /api/player/play/:workshopId
POST /api/player/pause
POST /api/player/resume
POST /api/player/stop
POST /api/player/display-mode
GET  /api/player/status

POST /api/display/on
POST /api/display/off
GET  /api/display/status

GET  /api/storage
PUT  /api/storage
POST /api/storage/cancel

GET  /api/system/summary
```

Not implemented:

```text
/api/transcode/*
WS /api/player/watch
real SteamCMD cancellation for an active process
application auth/session routes
```

## Database

`library` stores one row per wallpaper. `source_path` and `transcoded_path` are
relative to the current media root.

`download_tasks` stores current and recently finished download progress:
`stage`, message, preview metadata, adult metadata hints, percent, bytes done,
bytes total, start time, and finish time. Startup reconcile marks interrupted
in-flight tasks as errors and cleans orphan source directories when possible.

`transcode_jobs` exists for Phase 2 and is intentionally retained. With
`TranscodeQueueNoop` active, Phase 1 downloads mark `library.transcode_status`
as `skipped` and leave `transcode_jobs` empty.

## Playback

mpv is spawned by the backend, not managed as a separate systemd unit. Backend
restart means a short playback interruption.

Current mpv flags are based on Pi testing:

```text
--idle=yes
--loop=inf
--fullscreen
--no-osc
--no-input-default-bindings
--no-audio
--hwdec=<config.mpv.hwdec>      # default auto
--gpu-api=<config.mpv.gpu_api>  # default opengl
--keepaspect=yes
--panscan=1.0
```

Display modes:

- `fill`: keep aspect, panscan 1.0
- `fit`: keep aspect, panscan 0.0
- `stretch`: disable keepaspect, panscan 0.0

Playback and display power are linked for resource saving:

- `/api/player/stop` records the current wallpaper, stops mpv, and starts a
  30-second auto-off timer.
- `/api/display/off` records the current wallpaper when one is active, stops
  mpv, then turns the display off.
- `/api/display/on` turns the display on and tries to restore the saved
  wallpaper from the beginning.
- Restore intent is stored in the local `player_state` singleton table.
- `pause` does not participate in display power saving.

## Frontend

Current pages:

- Browse: Steam Workshop search, pagination, tags, sort, mobile filter sheet,
  existing-library/download status awareness.
- Library: grid/list desktop views, mobile grid, safe/adult visibility toggle,
  play/delete/display-mode controls.
- Downloads: active/finished task rows, structured progress, elapsed time,
  mature-item hiding, dismiss controls.
- Settings: Steam/config summary, display/mpv status, declarative local/SMB
  storage card, migration progress and cancellation.

The frontend uses plain CSS in `packages/frontend/src/styles.css`. Do not add
Tailwind, CSS Modules, or component-local hardcoded color systems.

## Installation And Operation

Development setup:

```bash
bash install-pi.sh
bun run dev
```

Deployment setup:

```bash
bash install-pi.sh --service
systemctl --user status pi-wallpaper-engine
journalctl --user -u pi-wallpaper-engine -f
```

Validation:

```bash
bun test
bun run typecheck
bun run check
bun run --filter @pwe/frontend build
```

`bun run check` is the Pi preflight. It checks config, key binaries, Steam Web
API, SteamCMD login state, local/SMB storage prerequisites, SQLite state root,
port availability, and mpv hardware decode when a graphical session is present.

## Phase Status

| Phase | Current status |
|---|---|
| Phase 1: direct-play player | Active and usable |
| Phase 1 storage productization | Implemented: declarative SMB + migration |
| Phase 2: NAS transcoding Worker | Reserved only: schemas/table/service draft exist, routes/worker not implemented |
| Auth/passkey | Planned only in `plans/auth-passkey-betterauth.md` |
| Player/display linkage | Implemented; needs Pi manual validation |
| Playback queue/random/restore | Not implemented |
| Ink TUI | Not implemented |

## Do Not Regress

- Do not make `POST /api/download/:id` wait synchronously for SteamCMD.
- Do not store absolute media paths in SQLite library rows.
- Do not read `config.paths.data_root` directly when resolving playable media.
- Do not mount SMB from backend code except through the storage helper.
- Do not add `RequiresMountsFor=` to the service; SMB is optional.
- Do not delete `transcode_jobs`, `WorkerProtocol`, or `TranscodeQueueLive`.
- Do not document passkey/auth as implemented until code, config schema, and
  route guards actually exist.
