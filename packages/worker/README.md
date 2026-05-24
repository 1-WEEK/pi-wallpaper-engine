# @pwe/worker

Phase 2 — transcoding worker that runs in Docker on a NAS, pulls jobs from the Pi
backend, transcodes WE wallpapers with Intel QSV, writes the result back via the
shared filesystem.

Not implemented in Phase 1. The Pi backend plays source files directly; 4K and
oddly-shaped sources are handled by mpv at runtime (CPU-heavy but functional).

Current repository state:

- `packages/worker` has no Worker implementation, Dockerfile, or compose file.
- `@pwe/shared/schema/WorkerProtocol` defines the intended request/response
  schemas.
- `packages/backend/src/services/TranscodeQueue.ts` contains `TranscodeQueueLive`,
  but runtime currently wires `TranscodeQueueNoop`.
- No `/api/transcode/*` routes are mounted yet.

When implementing:

- Long-poll `POST /api/transcode/claim` on the Pi
- ffmpeg with `hevc_qsv` + `scale_qsv` + `crop` for aspect-correct fill
- Write `<id>.mp4.partial` then rename to `<id>.mp4` on success (idempotent re-claims)
- Heartbeat to `/api/transcode/:jobId/heartbeat` every 15s
- Report progress to `/api/transcode/:jobId/progress`
- Report completion / failure to `/api/transcode/:jobId/complete` or `/fail`

Schemas in `@pwe/shared/schema/WorkerProtocol` are the draft contract to wire
against when Phase 2 starts.
