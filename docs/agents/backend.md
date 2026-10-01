# Backend Guide

Read the relevant section before changing backend behavior or shared contracts.
Service links point to the owning module.

## Effect and HTTP

- Follow the APIs used in the installed Effect version. Services use
  `class Xxx extends Context.Service<Xxx, XxxImpl>()("Xxx")`; `XxxLive` is a Layer
  value or factory, typically built with `Layer.effect`.
- [runtime.ts](../../packages/backend/src/runtime.ts) builds the managed runtime
  with chained `Layer.provideMerge`. Dependencies provide for the layers above
  them; leaf services such as Config and Logger go last. `Layer.mergeAll` does
  not resolve dependencies between its siblings.
- Elysia handlers bridge to business effects with `runtime.runPromise`. Keep
  resource ownership, cancellation, and orchestration in services.
- A failed `yield*` short-circuits `Effect.gen`; JavaScript `catch` and `finally`
  cannot handle that failure. Use `Effect.catch` or `Effect.catchTag` to recover,
  `Effect.tapError` to observe, and `Effect.ensuring` or scoped finalizers to clean up.
- Use `Effect.acquireRelease` for scoped resources and `Effect.acquireUseRelease`
  for resources limited to one operation. Db and Mpv own their lifetimes this way.
- Business errors use `Data.TaggedError` in [shared errors](../../packages/shared/src/errors.ts).
  [httpFromError](../../packages/backend/src/routes/httpError.ts) owns the common
  status/body mapping. Preserve route-specific contracts when using it.

## Downloads

[DownloadIntake](../../packages/backend/src/services/DownloadIntake.ts) owns start,
cancel, finalization, and cleanup. Routes adapt these results to HTTP and WebSocket
messages; [Tasks](../../packages/backend/src/services/Tasks.ts) persists activity in
the unified SQLite `tasks` table.

- A newly accepted `POST /api/download/:id` returns 202 while work continues in
  the background. SteamCMD can run for over a minute; keep it outside the HTTP
  request lifetime. Progress streams over `/api/download/progress/:id`.
- [SteamCmd](../../packages/backend/src/services/SteamCmd.ts) owns completion
  detection and content-path normalization. Exit code 0 and an existing directory
  are insufficient: inspect explicit `ERROR!` output and retain the file-count,
  size, and mtime stability checks for quiet downloads.
- With the default source directory, finalized `library.source_path` belongs
  under `source/<id>/steamapps/workshop/content/431960/<id>/`. SteamCMD may report
  a transient `downloads/` path before moving files into `content/`. Preserve its
  prefer-content resolution and [Library](../../packages/backend/src/services/Library.ts)'s
  startup repair of missing paths.
- [WallpaperFile](../../packages/backend/src/services/WallpaperFile.ts) rejects
  declared non-video types and items without a usable video. The Workshop Video
  search tag is not a validation guarantee. Intake cleans failed downloads before
  marking the task terminal, so retries cannot race with deletion.
- [DownloadProcessRegistry](../../packages/backend/src/services/DownloadProcessRegistry.ts)
  connects intake to managed processes;
  [DownloadReconciler](../../packages/backend/src/services/DownloadReconciler.ts)
  handles interrupted and stale tasks. Preserve both cancellation paths.

## Storage and Migration

[Storage](../../packages/backend/src/services/Storage.ts) resolves the active media
root. Config `storage.root` is the custom directory; `null` selects
`paths.data_root`. Use the service for media access, including paths stored in
library rows.

- [StorageRootSelection](../../packages/backend/src/services/StorageRootSelection.ts)
  owns browsing, creation, target validation, and `planSwitch`. Its path-taking
  methods enforce allowed roots, absolute paths, control-character rejection, and
  `realpath` checks against symlink escape. Keep these checks inside the module.
- `planSwitch` returns `noop`, `save`, or `migrate`; the route executes that plan.
  [Migrate](../../packages/backend/src/services/Migrate.ts) depends on Storage, so
  having Storage call Migrate would introduce a Layer dependency cycle.
- Migration copies the source and optimized directories, verifies full contents,
  persists the new root, then removes the old copies, in that order. The rsync
  helpers live in [@pwe/migrate](../../packages/migrate/src/index.ts).
- A migration request returns 202; the UI polls `GET /api/storage` for `migration`.
  Root switching rejects active downloads or transcodes; migration also rejects
  playback from the current root. Migration blocks new downloads and worker claims.
- Business SQLite state uses [statePath.ts](../../packages/backend/src/statePath.ts):
  `$XDG_STATE_HOME/pi-wallpaper-engine/`, defaulting to
  `~/.local/state/pi-wallpaper-engine/`. Media migration never moves it.
  [Db](../../packages/backend/src/services/Db.ts) retains the best-effort migration
  from older installations that kept the database under `data_root`.

## Playback and Display

[Playback](../../packages/backend/src/services/Playback.ts) coordinates play, stop,
stepping, rotation mode, sleep, and display power. Routes call it for these intents.
[PlayerPower](../../packages/backend/src/services/PlayerPower.ts) owns player/display
linkage; [Rotation](../../packages/backend/src/services/Rotation.ts) owns sequences.

- Rotation is interval-driven because mpv loops the current file indefinitely.
  Preserve single/sequential/shuffle modes and preferences in `playback_prefs`;
  `single` is the default and keeps the current wallpaper looping.
  Manual next/prev anchor on mpv's current item; rotation skips missing files.
- Disarm rotation before stop or display-off; arm it after an explicit play.
  Display-on restore re-arms rotation best-effort. Startup restore does not re-arm
  it; that distinction is recorded in [ADR 0009](../adr/0009-playback-orchestration.md).
- `sleep(minutes)` replaces the previous timer; `minutes <= 0` cancels it. Expiry
  disarms rotation, calls display-off, and falls back to `stopForIdle` on failure.
  The summary exposes `sleep: { active, deadline }`, with an epoch-ms deadline.
- Display commands are optional argv arrays executed directly with `Bun.spawn`.
  Keep them non-interactive (including any required sudo configuration) and retain
  the five-second timeout. An unconfigured display operation returns 503.
- Mpv is a backend-owned subprocess. Restarting the backend interrupts playback.
  For Pi flags and installation details, read [Pi Runtime](development.md#pi-runtime).

## Transcoding

`transcodeMode()` selects the queue and route mount together at startup:

| `PWE_WORKER_API_KEY` | Queue and route behavior |
| --- | --- |
| Absent or shorter than 8 characters | Noop enqueue marks the item `skipped`, creates no new jobs, and leaves `/api/transcode/*` unmounted |
| At least 8 characters | Live queue and worker routes are enabled |

Keep `transcode_jobs` and the [WorkerProtocol schema](../../packages/shared/src/schema/WorkerProtocol.ts)
in both modes. [TranscodeQueue](../../packages/backend/src/services/TranscodeQueue.ts)
owns job updates and mirrors progress to library/activity state.
[TranscodeMonitor](../../packages/backend/src/services/TranscodeMonitor.ts) returns
stale claims to `pending` for retry.

The Worker runs Bun and ffmpeg. It downloads source bytes and uploads an artifact;
the Pi validates and places the result under the current media root. Preserve this
ownership when changing uploads, retries, or migration guards. Read the
[deployment guide](../worker-deployment.md) for hardware requirements and encoder configuration.

Every encoder path (QSV, VA-API, libx265/libx264) must crop-to-fill: take the centred
window of the source matching the screen aspect ratio, then scale it to the screen box.
The hardware scalers accept no aspect or crop options, so the crop runs in software on
the source frames before `hwupload` — build it once in `buildFfmpegArgs`
([worker ffmpeg.ts](../../packages/worker/src/ffmpeg.ts)) rather than per encoder.

## Auth Boundaries

Authentication is optional and disabled by default. For public exposure, enable
it using [Authentication](../auth.md).

- With auth enabled, `originGuard` validates browser origins and `sessionGuard`
  protects business APIs. Download WebSockets also check the session.
- Health and auth endpoints bypass the business-session guard. Worker routes
  bypass browser session/origin checks and authenticate separately with
  `workerGuard` using `X-Worker-Key`; preserve that distinction.
- Setup completion means at least one passkey exists. Retain recovery from an
  interrupted signup and the last-passkey deletion guard. Reset instructions live
  in [Authentication](../auth.md#emergency-reset).
