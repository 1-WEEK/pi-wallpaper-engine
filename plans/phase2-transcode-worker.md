# Plan — Phase 2 NAS Transcoding Worker

> Status: in implementation. Bundled single-release milestone (backend + Worker
> ship together — no `transcode.enabled` config gate). Target deployment:
> x86 NAS with Intel QSV, NAS-shared filesystem reachable from Pi.

## Goal

Turn the existing Phase 2 placeholders (`TranscodeQueueLive`, `WorkerProtocol`,
`transcode_jobs` table) into a working end-to-end system:

- The Pi backend creates transcode jobs after downloads finish.
- A NAS-side Docker Worker pulls jobs, transcodes with ffmpeg, and writes results
  back via the shared filesystem.
- The Pi plays `optimized/` files automatically when available, falling back to
  `source/` originals.

## Pre-implementation verification (do once, before writing code)

Phase 2 is **only** viable when the Pi and the NAS Worker container both see
the same media files at the same logical path. Verify:

1. `GET /api/system/summary` → `status.storage.data_root` returns the NAS-shared
   mount path on the Pi (not the SD card).
2. From the NAS, `ls $PWE_MEDIA_ROOT/source/<some-id>/` lists the same files the
   Pi sees at `data_root/source/<some-id>/`.

If `storage.root === null` (defaults to SD card), switch storage root via the
Settings UI to the NAS mount before Phase 2 deployment. Backend + Worker will
still build cleanly without this — but jobs will sit pending indefinitely
because the Worker cannot read source paths.

## Context: Current Repository State

Already in place (do not rewrite):

- `packages/shared/src/schema/WorkerProtocol.ts` — request/response schemas.
- `packages/backend/src/services/TranscodeQueue.ts` — `TranscodeQueueLive` with
  `enqueue` and `claim`; wired as `TranscodeQueueNoop` in `runtime.ts`.
- `packages/backend/src/db/migrations/001_init.sql` — `transcode_jobs` table.
- `packages/backend/src/transcode/decide.ts` — `decideTranscode` rules.
- `packages/shared/src/schema/Library.ts` — `transcode_status` through
  `transcoded_size` columns.
- `packages/backend/src/services/Library.ts` — `playablePath` already prefers
  `transcoded_path ?? source_path`.
- `packages/frontend/src/pages/Library.tsx` — already shows `transcode_status`
  badges for `pending`/`running`/`claimed`/`failed`.

Missing:

- `/api/transcode/*` routes (claim, heartbeat, progress, complete, fail).
- `TranscodeQueueImpl` extensions (heartbeat, progress, complete, fail).
- Heartbeat timeout monitor / stale-job reaper.
- Worker authentication guard.
- Worker Docker runtime (Dockerfile, compose, main loop, ffmpeg wrapper,
  HTTP client).
- `runtime.ts` one-line swap from `TranscodeQueueNoop` to `TranscodeQueueLive`.

## Approach

Split into two independently mergeable phases. After Phase 1 the system is
usable (Pi plays source, jobs queue up). After Phase 2 the Worker closes the
loop.

---

## Phase 1: Pi Backend Worker Protocol Closure

### 1.1 Extend `TranscodeQueueImpl`

Add to the interface in `packages/backend/src/services/TranscodeQueue.ts`:

- `heartbeat(jobId: string): Effect<void, DbError>`
- `progress(jobId: string, percent: number): Effect<void, DbError>`
- `complete(jobId: string, report: CompleteReport): Effect<void, DbError>`
- `fail(jobId: string, error: string): Effect<void, DbError>`

Implement in `TranscodeQueueLive`:

- `heartbeat` — `UPDATE transcode_jobs SET status = 'running', last_heartbeat = ?`.
- `progress` — update `transcode_jobs.progress` and `library.transcode_progress`.
- `complete` — set `status = 'completed'`, `completed_at = ?`, update
  `library` with `transcoded_path`, `transcoded_resolution`, `transcoded_codec`,
  `transcoded_size`, `transcode_status = 'completed'`.
- `fail` — set `status = 'failed'`, `error = ?`, update
  `library.transcode_status = 'failed'`, `transcode_error = ?`.

Implement no-op stubs in `TranscodeQueueNoop` so the interface stays uniform.

### 1.2 `TranscodeMonitor` service

New file: `packages/backend/src/services/TranscodeMonitor.ts`

- `Layer.scoped` with a `forkScoped` background fiber.
- Repeats every `30 seconds` via `Effect.repeat(Schedule.spaced("30 seconds"))`.
- Each tick: query `transcode_jobs` for rows with `status IN ('claimed','running')`
  and `last_heartbeat < Date.now() - config.transcode.heartbeat_timeout_ms`.
- For stale rows: reset `status = 'pending'`, `worker = NULL`, `claimed_at = NULL`,
  `last_heartbeat = NULL`, and mirror to `library.transcode_status = 'pending'`.
- Log each recovery so operators can see Worker drop-offs.
- Wrap the forked fiber with `Effect.ensuring(logger.info("TranscodeMonitor stopped"))`
  so `runtime.dispose()` produces a visible shutdown line — silent fiber death
  is the most common reason operators think the system "hung".

### 1.3 Worker authentication guard

New file: `packages/backend/src/middleware/workerGuard.ts`

- Reads `process.env.PWE_WORKER_API_KEY` at startup.
- `PWE_WORKER_API_KEY` is loaded by the same `auth.env` auto-loader pattern in
  `packages/backend/src/index.ts:30-41` — operators put it in
  `~/.config/pi-wallpaper-engine/auth.env` next to `PWE_AUTH_*`. No new loader.
- Validates the `X-Worker-Key` request header. Mismatch → 401.
- No dependency on Better Auth / sessions. This is machine-to-machine auth.
- If the env var is unset at startup, **fail fast with a clear error** rather
  than booting with an empty key (which would silently accept all requests).

### 1.4 Transcode routes

New file: `packages/backend/src/routes/transcode.ts`

Five endpoints, all protected by `workerGuard`:

```
POST /api/transcode/claim
  body: { worker: string }
  → 200 + TranscodeJob | 204 (no pending jobs)

POST /api/transcode/:jobId/heartbeat
  → 200 { ok: true } | 404 (unknown/stale job)

POST /api/transcode/:jobId/progress
  body: { progress: number }
  → 200 { ok: true }

POST /api/transcode/:jobId/complete
  body: { output_relative_path, output_size, duration_ms }
  → 200 { ok: true }

POST /api/transcode/:jobId/fail
  body: { error: string }
  → 200 { ok: true }
```

Implementation bridges to `TranscodeQueue` methods via
`runtime.runPromise(Effect.gen(...))`.

**sessionGuard interaction.** `sessionGuard` is registered via
`onBeforeHandle({ as: "global" })`, so Elysia `.use()` ordering does NOT exempt
`/api/transcode/*` from the session wall. Real fix: append `/api/transcode/`
to `PUBLIC_PREFIXES` in `packages/backend/src/middleware/sessionGuard.ts:4`.
`workerGuard` then becomes the sole authentication for those routes — by
design, since machine-to-machine auth (shared API key) is incompatible with
Better Auth's cookie-based sessions.

### 1.5 Wire into runtime and server

- `packages/backend/src/runtime.ts`:
  - Replace `TranscodeQueueNoop` with `TranscodeQueueLive`.
  - Insert `TranscodeMonitorLive` into the `provideMerge` chain (any position
    before leaf layers; order-insensitive relative to other non-leaf services).
- `packages/backend/src/index.ts`: register `transcodeRoutes(runtime)`.
- `packages/backend/src/routes/system.ts`: add transcode counts to summary:
  ```ts
  transcode: {
    pending: number,
    running: number,
    completed: number,
    failed: number,
  }
  ```

### 1.6 Frontend enhancements (minimal)

- `packages/frontend/src/pages/Library.tsx`:
  - `showsTranscodeBadge` already covers the active states.
  - When `transcoded_size` exists, show a small indicator and space-saved
    percentage in the card/list meta line.

### Phase 1 state after merge

- New downloads that `decideTranscode` flags for transcoding create pending jobs.
- Library shows `pending` badge until a Worker claims and completes the job.
- Pi continues playing `source/` files (fallback). The system is fully usable
  without a Worker.

---

## Phase 2: NAS Worker Docker Runtime

### 2.1 Worker package layout

```
packages/worker/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── README.md
├── tsconfig.json
└── src/
    ├── index.ts    # main loop
    ├── client.ts   # HTTP API client
    └── ffmpeg.ts   # ffmpeg command builder + spawn
```

### 2.2 Dockerfile

Base: `debian:bookworm-slim`

Install:
- `ffmpeg`
- `intel-media-va-driver-non-free` (Intel QSV support)
- `nodejs` (or keep the image Bun-free and use the host-installed runtime)

The image should be runnable on both Intel QSV-capable NASes and generic
x86_64/ARM64 hosts. ffmpeg hardware detection is done at runtime, not build
time.

### 2.3 docker-compose.yml (image-only, no build on NAS)

```yaml
services:
  pwe-worker:
    image: ${PWE_WORKER_IMAGE:?set PWE_WORKER_IMAGE to the full image ref}
    environment:
      PWE_BACKEND_URL: ${PWE_BACKEND_URL:?}
      PWE_WORKER_API_KEY: ${PWE_WORKER_API_KEY:?}
      PWE_WORKER_NAME: ${PWE_WORKER_NAME:-nas-01}
      PWE_MEDIA_ROOT: /data
    volumes:
      - ${PWE_MEDIA_HOST:?}:/data
    devices:
      - /dev/dri:/dev/dri   # Required for QSV. Container without this falls back to libx265.
    restart: unless-stopped
```

The NAS never builds the image. The dev machine builds + tags +
pushes (`packages/worker/scripts/release.sh --push`) to ghcr.io or Docker
Hub; the NAS only needs `docker-compose.yml` + `.env`. Tarball alternative
documented in the Worker README for offline NAS hosts.

The `devices: /dev/dri:/dev/dri` mapping is the difference between QSV and a
software-encoded fallback. The Worker's runtime device probe (§2.5) detects
either configuration automatically.

`PWE_MEDIA_ROOT` is where the Worker resolves relative paths from `TranscodeJob`.
The Pi resolves the same relative paths against its own `storage.mediaRoot()`.

### 2.4 HTTP client (`src/client.ts`)

Plain `fetch`-based client (no Elysia, no Effect, minimal dependencies):

- `claim(workerName)` — POST `/api/transcode/claim` with `X-Worker-Key`.
  On 204 / empty body, return `null` and let the caller sleep ~10s before
  retrying.
- `heartbeat(jobId)` — POST `/api/transcode/:jobId/heartbeat`.
- `progress(jobId, percent)` — POST `/api/transcode/:jobId/progress`.
- `complete(jobId, report)` — POST `/api/transcode/:jobId/complete`.
- `fail(jobId, error)` — POST `/api/transcode/:jobId/fail`.

All errors are thrown as plain `Error` with a `.code` property for the caller
to decide retry vs fatal.

### 2.5 ffmpeg wrapper (`src/ffmpeg.ts`)

Input: a `TranscodeJob` object.

Steps:
1. Resolve absolute paths:
   - source: `${PWE_MEDIA_ROOT}/${job.source_relative_path}`
   - output: `${PWE_MEDIA_ROOT}/${job.output_relative_path}.partial`
   - final: `${PWE_MEDIA_ROOT}/${job.output_relative_path}`
2. Verify source exists; throw if missing.
3. Ensure the output directory exists (`mkdir -p`). `<optimized_dir>` may not
   exist on the first transcoded item.
4. **Cleanup stale `.partial`** before spawn:
   `await unlink(partialPath).catch(() => {})`. A previous Worker crash or a
   stale NFS lock can leave an open-by-no-one file that blocks ffmpeg's
   output open.
5. Detect QSV availability:
   - Encoder support: `ffmpeg -hide_banner -encoders` parsed for `hevc_qsv`.
   - **Device probe**: run a one-frame `ffmpeg -f lavfi -i nullsrc=s=64x64:d=0.04
     -c:v hevc_qsv -f null -` against the actual device. Encoder-list presence
     does NOT guarantee `/dev/dri/renderD128` is mapped into the container.
   - If both pass: use `-c:v hevc_qsv -global_quality <quality>` with
     `-vf "scale_qsv=w=<target_width>:h=<target_height>:mode=hq"`.
   - Otherwise: fall back to `-c:v libx265 -crf <quality>` with a software
     scale/crop filter that fills the target resolution with aspect-correct
     crop/pad.
6. Spawn ffmpeg as a child process.
7. Parse stderr progress lines (if feasible) or simply wait for exit.
8. On exit 0: rename `.partial` → final name.
9. On non-zero exit: throw with the last ~20 stderr lines as context.

### 2.6 Main loop (`src/index.ts`)

```
while (running) {
  const job = await client.claim(workerName)
  if (!job) { sleep(10s); continue }

  // Start heartbeat interval (every 15s)
  const heartbeatInterval = setInterval(() => client.heartbeat(job.id), 15_000)

  try {
    await ffmpeg.transcode(job, (pct) => client.progress(job.id, pct))
    const stats = await stat(finalPath)
    await client.complete(job.id, {
      output_relative_path: job.output_relative_path,
      output_size: stats.size,
      duration_ms: Date.now() - startTime,
    })
  } catch (err) {
    await client.fail(job.id, err.message)
  } finally {
    clearInterval(heartbeatInterval)
  }
}
```

The Worker handles exactly one job at a time. This is intentional: it limits
NAS resource usage and removes the need for Worker-side concurrency management.

### Phase 2 state after merge

- Worker container starts, begins long-polling.
- Pending jobs are claimed and processed.
- Transcoded files appear under `optimized/`.
- Pi playback automatically switches to optimized files on next play.

---

## Data Flow

```
Pi Backend                                        NAS Worker
  │                                                  │
  │  POST /api/transcode/claim  ─────────────────────┤
  │  ← TranscodeJob                                  │
  │                                                  ▼
  │                                            ffmpeg transcode
  │  POST /api/transcode/:id/heartbeat  ←────────────┤
  │  POST /api/transcode/:id/progress   ←────────────┤
  │                                                  ▼
  │  POST /api/transcode/:id/complete   ←────────────┤ (rename .partial)
  │                                                  │
  ▼                                                  ▼
library.transcoded_path updated              job loop restarts
playablePath now prefers optimized
```

Filesystem assumption (shared namespace):

```
Pi:   /mnt/nas/media/source/<id>/.../wallpaper.mp4
       /mnt/nas/media/optimized/<id>.mp4
Worker: /data/source/<id>/.../wallpaper.mp4
         /data/optimized/<id>.mp4
```

Relative paths in DB (`source/<id>/...`, `optimized/<id>.mp4`) are identical;
only the prefix differs.

---

## Configuration Changes

No changes to `config.example.json` or `packages/shared/src/schema/Config.ts`.

New environment variables (both sides read from `process.env` / `Bun.env`):

| Variable | Used by | Purpose |
|---|---|---|
| `PWE_WORKER_API_KEY` | Pi backend + Worker | Shared secret for machine auth. Pi reads via `~/.config/pi-wallpaper-engine/auth.env` auto-loader. |
| `PWE_BACKEND_URL` | Worker | Pi backend base URL (e.g. `http://pi.local:8080`). Prefer LAN IP/hostname over public Cloudflare Tunnel origin. |
| `PWE_WORKER_NAME` | Worker | Identifier reported during claim (e.g. `nas-01`). |
| `PWE_MEDIA_ROOT` | Worker | Local mount point for shared media (default `/data` inside container). |

---

## State Machine

```
pending ──claim──→ claimed ──heartbeat──→ running ──complete──→ completed
    │                │           │
    │                │           └─fail────→ failed
    │                └─timeout──→ pending
    └─timeout────────────────────→ pending
```

- `claim` is atomic (`UPDATE ... RETURNING`).
- `heartbeat` moves `claimed` → `running` on first call.
- `TranscodeMonitor` moves stale `claimed`/`running` → `pending`.
- `complete` writes the optimized file metadata into `library`.
- `fail` writes the error into `library.transcode_error`.

---

## Test Plan

### Automated

- `TranscodeQueueLive`:
  - `enqueue` creates a pending job + updates library.
  - `claim` atomically returns the oldest pending job and updates status.
  - `heartbeat`/`progress`/`complete`/`fail` update DB correctly.
- `TranscodeMonitor`:
  - Simulate a stale `last_heartbeat`; assert job resets to `pending`.
- `workerGuard`:
  - Missing header → 401.
  - Wrong key → 401.
  - Correct key → passes through.
- Routes (integration-style via Elysia handler tests):
  - Claim with no jobs → 204.
  - Full claim → heartbeat → progress → complete cycle.
  - Claim → heartbeat timeout → Monitor resets → re-claim succeeds.

### Manual (Pi + real NAS or shared mount)

1. Download a 4K wallpaper → Library shows `pending`.
2. Start Worker container → Worker logs show claim + ffmpeg start.
3. Watch progress updates in DB / Library badge.
4. Completion → `optimized/<id>.mp4` exists; Library shows completed indicator.
5. Play the wallpaper → `library.playablePath` resolves to optimized file.
6. Stop Worker mid-job → wait for heartbeat timeout → job returns to `pending`.
7. Restart Worker → re-claims and finishes the same job (ffmpeg overwrites
   `.partial` idempotently).

---

## Rollback

- **Disable Worker system**: change one line in `runtime.ts` back to
  `TranscodeQueueNoop`. New downloads will mark `transcode_status = "skipped"`
  again. Existing `transcode_jobs` rows are harmless.
- **Remove Worker endpoint exposure**: delete `transcodeRoutes` registration in
  `index.ts`.
- **Delete optimized files**: optional; `playablePath` will automatically fall
  back to `source/`.

---

## File Checklist

### New files

1. `packages/backend/src/routes/transcode.ts`
2. `packages/backend/src/middleware/workerGuard.ts`
3. `packages/backend/src/services/TranscodeMonitor.ts`
4. `packages/worker/src/index.ts`
5. `packages/worker/src/client.ts`
6. `packages/worker/src/ffmpeg.ts`
7. `packages/worker/Dockerfile`
8. `packages/worker/docker-compose.yml`

### Modified files

9. `packages/backend/src/services/TranscodeQueue.ts` (extend interface + Live/Noop)
10. `packages/backend/src/runtime.ts` (swap Layer)
11. `packages/backend/src/index.ts` (mount routes)
12. `packages/backend/src/routes/system.ts` (transcode stats)
13. `packages/frontend/src/pages/Library.tsx` (completed indicator)
14. `packages/worker/package.json` (add scripts/dependencies)
15. `packages/worker/README.md` (rewrite as deploy docs)

---

## Risk & Assumptions

- **Filesystem sharing is required**. If Pi `storage.root` is a local SD card path
  that the NAS cannot reach, the Worker cannot read source or write optimized
  files. In that scenario jobs remain pending forever. The system still works
  (source playback) but Phase 2 provides no value. Document this prerequisite
  clearly.
- **ffmpeg hardware compatibility**. Intel QSV flags vary by generation. The
  Worker must detect QSV at runtime and fall back to software encoding.
- **Network reachability**. Worker must reach Pi backend over HTTP. If Pi is
  behind Cloudflare Tunnel, `PWE_BACKEND_URL` should point to the internal LAN
  IP, not the public origin, to avoid routing the Worker through the internet.
