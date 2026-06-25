# AGENTS.md — pi-wallpaper-engine

This file provides guidance to coding agents (Claude Code, Codex, etc.) when working with code in this repository.

## What this is

A Wallpaper Engine **Video** wallpaper player for the Raspberry Pi 4B (Debian 13 Trixie aarch64). The web UI browses Steam Workshop, downloads items, and plays them with mpv in fullscreen loop. Phase 1 streams the source file directly with no transcode; Phase 2 adds a NAS Docker transcode worker (implemented in `@pwe/worker`, inactive until `PWE_WORKER_API_KEY` is set).

## Common commands

```
bash install-pi.sh              # Install deps + configure + preflight, stop here (dev mode)
bash install-pi.sh --service    # Also install and enable the systemd user service (deploy mode)

bun run dev                     # Frontend + backend together (frontend 5173 HMR + backend 8080)
bun run dev:backend             # Backend only
bun run dev:frontend            # Frontend only

bun test                        # Run tests (transcode/decide, Storage validation, etc.)
bun run check                   # Preflight: 13 diagnostic checks
bun x tsc --noEmit              # Typecheck (cleanest from inside packages/backend/)
bun run --filter @pwe/frontend build   # Build frontend into packages/frontend/dist

bun run service:restart         # Guarded release command: dirty-tree gate + DB snapshot + health probe
bun run service:restart -- --force   # Skip the dirty-tree gate (only when you know what you're doing)
bun run service:{start,stop,status}  # Plain systemctl wrappers, no guards
```

Filter a single test: `bun test packages/backend/src/transcode/decide.test.ts`

CI (`.github/workflows/ci.yml`) runs `bun test` + `bun run typecheck` + `bun run build` on every PR and on push to `main` — the hardware-free machine gates. Report-first: not a required status check yet (see `plans/acceptance-free-iteration.md`).

## Code reading

When a task requires understanding code, architecture, data flow, call chains, or a bug path, use codegraph first. Start with `codegraph_explore` (one call returns the relevant symbols' source grouped by file — usually the only call you need), then use `codegraph_search` (locate a symbol by name), `codegraph_callers` (who calls a symbol), or `codegraph_node` (one symbol's details) for focused follow-up. Use `rg` and direct file reads after codegraph when you need exact text, non-indexed files, tests, config, docs, or generated output.

## Architecture

**Bun workspaces monorepo**:
- `@pwe/shared` — Effect Schema, Data.TaggedError, cross-package types
- `@pwe/backend` — Bun + Elysia + Effect-TS, port 8080
- `@pwe/frontend` — Vite + React, port 5173 in dev (HMR + proxies `/api` to backend)
- `@pwe/migrate` — Phase 1 storage migration: a thin rsync wrapper, no Effect/Elysia
- `@pwe/worker` — Phase 2 NAS-side ffmpeg transcode worker (hardware HEVC/QSV + libx265 fallback), shipped as a Docker image; inactive until `PWE_WORKER_API_KEY` is set

**Effect Layer wiring (`packages/backend/src/runtime.ts`)**: chained via `.pipe(Layer.provideMerge(...))`, **order matters** — leaf dependencies (Config, Logger) go at the end of the chain. `Layer.mergeAll` does no cross-resolution; don't use it. The runtime is `ManagedRuntime.make(buildLayer(configPath))`; Elysia routes bridge to business logic via `runtime.runPromise(Effect.gen(...))`.

**Service Tag convention**: each service file exports a `class XxxLive` Layer plus a `class Xxx extends Context.Tag(...)` tag. `Db.ts` manages the SQLite connection with `acquireRelease`; `Mpv.ts` manages the mpv subprocess + Unix socket with `acquireRelease`; `SteamCmd.ts` likewise wraps the box86 subprocess with `acquireUseRelease`.

**Effect-TS is used only for the business-logic layer** (resource / error / cancellation semantics); HTTP routes stay as plain Elysia handlers.

## Key design constraints

- **Downloads must be async**: `POST /api/download/:id` returns 202 immediately and forks the workflow in the background. SteamCMD runs for 30–60+ seconds; a synchronous handler is timed out by the browser/proxy as a 500. Progress streams over WS `/api/download/progress/:id`.
- **Paths in the DB are stored relative** (e.g. `source/<id>/.../foo.mp4`) and resolved against the current media root at runtime. Always go through `Storage.mediaRoot()` — **don't read `config.paths.data_root` directly**. The Phase 2 worker never receives media-root paths; it pulls source bytes from the Pi and uploads the finished artifact back to the Pi, which owns final placement.
- **`library.source_path` invariant**: must land under `source/<id>/steamapps/workshop/content/<weAppId>/<id>/`. SteamCMD's "Success. Downloaded item" line sometimes reports the transient `.../downloads/<weAppId>/<id>` staging path; once SteamCMD finishes validation it moves the files to `content/`, and the stdout-reported path goes stale. Normalize to content/ before persisting (the prefer-content fallback at the end of `SteamCmd.ts` is the single source of truth). `Library` boots a `reconcilePaths` step that retroactively rewrites any leftover downloads/ rows back to content/.
- **Non-video wallpapers fail fast**: `WallpaperFile.resolveWallpaperFiles` reads `project.json.type` and throws `NotVideoWallpaperError` for anything other than `video`; the route catches it and cleans up the half-written `source/<id>/`. The Workshop `requiredtags=Video` search filter is unreliable, so this layer is the real gate.
- **Playback rotation is interval-timer driven, not end-file**: mpv runs with `--loop=inf` so the current file never ends and never fires an end-file event, and the IPC layer only parses command responses (no mpv event handling). So `Rotation` (a backend service) keeps an in-memory sequence plus a `setInterval` that calls `Mpv.play` (`loadfile replace`) every `rotation_interval_sec`. `play_mode` (single/sequential/shuffle) and the interval persist in the `playback_prefs` singleton table; `single` is the default and preserves the legacy single-loop behavior. Routes: `POST /api/player/{mode,next,prev}`. Manual next/prev anchor on the wallpaper actually on screen via `mpv.status()`, and rotation skips items missing on disk.
- **Sleep timer**: `SleepTimer.set(minutes)` arms a `setTimeout` that disarms rotation, then calls `PlayerPower.displayOff()`, falling back to `stopForIdle()` when no display command is configured. `POST /api/player/sleep` with `minutes<=0` cancels; state surfaces in the system summary as `sleep:{active,deadline}`.
- **Transcode queue is env-gated**: `transcodeMode()` in `runtime.ts` reads `PWE_WORKER_API_KEY` — absent (or under 8 chars) selects `TranscodeQueueNoop` (every download row gets `transcode_status="skipped"`, `/api/transcode/*` stays unmounted, `transcode_jobs` stays empty); present selects `TranscodeQueueLive` and mounts the worker routes. The same key is the shared secret the Worker presents on claim, source download, artifact upload, heartbeat, progress, and failure reports.
- **Errors use `Data.TaggedError`** (in `@pwe/shared/errors.ts`): `SteamCmdError` (with `kind: AuthRequired | NotSubscribed | Timeout | BinaryNotFound | UnknownFailure`), `WorkshopApiError`, `MpvIpcError`, `NotVideoWallpaperError`, `DisplayError`, etc. Route catches dispatch on `err._tag` to choose the status code.
- **`display` config is optional**: `on_command` / `off_command` / `status_command` are argv arrays (`Bun.spawn` runs them directly — no shell parsing, no command injection). The commands must be non-interactive (use sudo NOPASSWD). When the `display` section is missing, `/api/display/*` returns 503 while everything else keeps working. A 5-second timeout kills the child to surface a blocked sudo prompt.
- **Storage is the directory model**: the `storage` config carries only `{ root?: string | null }`. `null` means use `paths.data_root`; non-null is the current media directory. Settings exposes a directory browser so the user picks a directory the Pi can reach; the supporting endpoints are `GET /api/storage/locations`, `GET /api/storage/directories?path=...`, `POST /api/storage/directories`, `POST /api/storage/validate-target`, `POST /api/storage/root`, and `POST /api/storage/cancel`. Directory browsing is fenced inside the allowed roots and rejects boundary crossing, symlink escape, control characters, and relative paths.
- **SQLite state lives locally — always**: in `~/.local/state/pi-wallpaper-engine/` (`statePath.ts`), decoupled from the media root and never moved with `storage.root`. Older installs kept the db under `data_root`; `DbLive` performs a one-time best-effort migration at startup.
- **Switching the media directory = background migration**: when the library is non-empty, `POST /api/storage/root` triggers `Migrate.start(targetRoot)`, which rsyncs `source/` and `optimized/` in the background. The sequence is: copy first, then full-content verify, then persist the new `storage.root`, then delete the old source. The API returns 202 and the frontend polls `GET /api/storage` for the `migration` field. Downloads and active transcode jobs are blocked during migration; switching mid-playback returns 409.
- **Auth is optional and off by default**: Better Auth + Passkey is implemented (see `docs/auth.md`). When `config.auth.enabled=false`, business APIs skip session checks — LAN-only deploys can run this way. Public exposure (Cloudflare Tunnel, etc.) requires `enabled=true`: originGuard validates `trusted_origins`, sessionGuard puts a 401 wall in front of `/api/*` (public exceptions are `/api/health` and `/api/auth/*`), and the WebSocket goes through the session too. Setup completeness is derived from "at least one passkey exists" — there's no separate flag, so an interrupted sign-up never permanently locks you out. If you lose your passkey, run `bun run --filter @pwe/backend auth:reset -- --yes` to reset auth.db.
- **JS `try/catch/finally` inside `Effect.gen` does not catch Effect failures**: a failing `yield*` short-circuits and neither `catch` nor `finally` runs. Recover with `Effect.catchAll` / `tapError`; clean up with `Effect.ensuring`.

## Pi / SteamCMD specifics

- **steamcmd runs via box86 + Valve's official tarball**, **not** the Debian apt package. On Trixie aarch64, `steamcmd:i386` won't install due to libc version conflicts. `install-pi.sh` does `dpkg --add-architecture armhf` + `libc6:armhf`, installs box86 from `Itai-Nelken/weekly-box86-debs`, extracts the tarball to `~/.local/share/steamcmd/`, and writes a wrapper at `/usr/local/bin/steamcmd` that invokes box86.
- **SteamCMD's config lives at `~/Steam/config/config.vdf`** (not `~/.steam/steam/config/loginusers.vdf` — that one belongs to the Steam client). preflight and `install-pi.sh` check for `Accounts.<username>` to determine login state.
- **SteamCMD success/failure cannot be judged by exit code or directory existence alone**: on the Pi it can `exit 0` while printing `ERROR! ...`, and it can also sit silent for a long time while still writing into `downloads/`. Before declaring "done", confirm the download directory contents have stabilized — file appearance alone is not enough.
- **mpv flags that actually work**: `--hwdec=auto --gpu-api=opengl` (Pi 4B V3D driver), not the spec's `auto-safe` + `vo=gpu`. The `mpv.hwdec` and `mpv.gpu_api` config fields are tunable.
- **mpv is spawned by the backend** (not a sibling systemd unit), with `acquireRelease` managing its lifecycle. Restarting the backend = a brief screen blackout.

## Frontend design system

**Logo**: `packages/frontend/public/favicon.svg` (256×256 SVG) and `packages/frontend/public/favicon.ico` (16/32/48px multi-size).

**Color tokens** (defined in `packages/frontend/src/styles.css` `:root`):
- `--ink: #0E1116` — body background (matches the logo's ink color)
- `--ink-1: #131820` — card / panel surface
- `--ink-2: #1a2030` — input / button
- `--paper: #F4EFE6` — primary text (warm cream)
- `--accent: #7C5CFF` — primary accent (purple)
- `--accent-2: #B7A7FF` — secondary accent (light purple)
- `--accent-border: rgba(124,92,255,0.22)` — accent border

**CSS strategy**: plain CSS (no Tailwind, no CSS Modules). Don't introduce a second CSS system. Colors flow entirely through CSS custom properties — don't hardcode hex values in components.

**Favicon generation**: to regenerate the `.ico`, install `@resvg/resvg-js` in a temp directory (arm64-linux-gnu has a prebuilt binary) and run a Bun script that renders SVG → PNG → ICO. `librsvg2-bin` is not installed; do not use `rsvg-convert`.

## Vite and LAN access

`packages/frontend/vite.config.ts` sets `server.host: true` to bind 0.0.0.0; otherwise phones / laptops hitting `http://<pi-ip>:5173` get connection refused. Production (`--service`) serves the prebuilt `packages/frontend/dist/` from the backend on port 8080.

## Configuration

`~/.config/pi-wallpaper-engine/config.json` is the user's actual config (including the API key); `config.example.json` is the template. The schema lives in `packages/shared/src/schema/Config.ts` and is validated by Effect Schema at startup — missing fields fail fast. `paths.data_root` is the default media directory; if `storage.root` is set, that directory becomes the active media root at runtime. The `PWE_CONFIG` environment variable overrides the config path.

## Don't

- Don't make SteamCmd synchronously await an HTTP response — it will time out.
- Don't put services that need cross-resolution into `Layer.mergeAll` — use the `provideMerge` chain.
- Don't drop the `transcode_jobs` table or the `WorkerProtocol` schema — Phase 2 needs them.
- Don't assume SteamCMD lives at `/usr/games/steamcmd` (the apt path) — it's actually at `/usr/local/bin/steamcmd` (the box86 wrapper).
- Don't revert the media-directory logic to a SMB / mode-toggle product surface — the current product is "pick a directory + validate + migrate", nothing more.

## Agent skills

### Issue tracker

Issues live in GitHub Issues at `1-WEEK/pi-wallpaper-engine` (use the `gh` CLI). External PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
