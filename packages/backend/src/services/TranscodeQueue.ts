import { Context, Effect, Layer } from "effect"
import { ulid } from "ulid"
import type { TranscodeJob } from "@pwe/shared"
import { DbError } from "@pwe/shared"
import type { ScreenSpec, TranscodeDecision } from "../transcode/decide.js"
import { Config } from "./Config.js"
import { Db } from "./Db.js"
import { Library } from "./Library.js"
import { Logger } from "./Logger.js"

export interface CompleteReport {
  readonly output_relative_path: string
  readonly output_size: number
  readonly duration_ms: number
}

export interface TranscodeQueueImpl {
  /**
   * Decide whether to enqueue a transcode job for the given workshop item.
   * - In Live mode: inserts a row into transcode_jobs and marks library.transcode_status = "pending".
   * - In Noop mode: marks library.transcode_status = "skipped" — Phase 1 plays source directly.
   */
  readonly enqueue: (
    workshopId: string,
    decision: TranscodeDecision,
    sourceRelativePath: string
  ) => Effect.Effect<void, DbError>

  /**
   * Worker pull endpoint (Phase 2 only). Atomically claims one pending job.
   * In Noop mode this always returns null — there is no Phase 1 worker.
   */
  readonly claim: (worker: string) => Effect.Effect<TranscodeJob | null, DbError>

  /**
   * Worker liveness ping. Bumps `last_heartbeat`; promotes claimed→running on
   * first call. Returns true if the job is still owned by a worker (false when
   * the row vanished or the monitor already reset it).
   */
  readonly heartbeat: (jobId: string) => Effect.Effect<boolean, DbError>

  /**
   * Mirrors a numeric percent (0..100) into both transcode_jobs and library.
   */
  readonly progress: (jobId: string, percent: number) => Effect.Effect<void, DbError>

  /**
   * Final success. Updates transcode_jobs to completed and writes the optimized
   * file metadata into the library row.
   */
  readonly complete: (
    jobId: string,
    report: CompleteReport,
    targetResolution: string,
    targetCodec: "hevc" | "h264"
  ) => Effect.Effect<void, DbError>

  /**
   * Terminal failure. transcode_jobs.status = failed; library.transcode_error = message.
   */
  readonly fail: (jobId: string, error: string) => Effect.Effect<void, DbError>
}

export class TranscodeQueue extends Context.Tag("TranscodeQueue")<
  TranscodeQueue,
  TranscodeQueueImpl
>() {}

const noopReport = (workshopId: string) => ({
  workshopId,
  reason: "TranscodeQueueNoop: no worker exists in Phase 1, ignoring call",
})

/**
 * Phase 1 active layer. No worker exists, so anything that would need
 * transcoding is marked "skipped" — the Pi plays source files directly.
 * The decision is still logged so we can see what Phase 2 would have done.
 */
export const TranscodeQueueNoop = Layer.effect(
  TranscodeQueue,
  Effect.gen(function* () {
    const library = yield* Library
    const logger = yield* Logger

    return {
      enqueue: (workshopId, decision, _sourceRelativePath) =>
        Effect.gen(function* () {
          yield* logger.info(
            `Transcode decision for ${workshopId}: ${decision.kind} (${decision.reason}) — Noop mode, skipping`
          )
          yield* library.update(workshopId, {
            transcode_status: "skipped",
            transcode_progress: 0,
            transcode_error: null,
          })
        }),

      claim: () => Effect.succeed(null),
      heartbeat: (jobId) =>
        Effect.sync(() => {
          console.warn(`TranscodeQueueNoop.heartbeat(${jobId}) — ignored`)
          return false
        }),
      progress: (jobId) =>
        Effect.sync(() => {
          console.warn(`TranscodeQueueNoop.progress(${jobId}) — ignored`)
        }),
      complete: (jobId) =>
        Effect.sync(() => {
          console.warn(`TranscodeQueueNoop.complete(${jobId}) — ignored`, noopReport(jobId))
        }),
      fail: (jobId, error) =>
        Effect.sync(() => {
          console.warn(`TranscodeQueueNoop.fail(${jobId}, ${error}) — ignored`)
        }),
    }
  })
)

/**
 * Phase 2 layer. Writes a transcode_jobs row, lets the Worker pull it.
 */
export const TranscodeQueueLive = Layer.effect(
  TranscodeQueue,
  Effect.gen(function* () {
    const config = yield* Config
    const db = yield* Db
    const library = yield* Library
    const logger = yield* Logger

    const screen: ScreenSpec = {
      width: config.screen.width,
      height: config.screen.height,
    }

    return {
      enqueue: (workshopId, decision, sourceRelativePath) =>
        Effect.gen(function* () {
          if (decision.kind === "skip") {
            yield* library.update(workshopId, {
              transcode_status: "skipped",
              transcode_progress: 0,
            })
            return
          }

          const jobId = ulid()
          const outputRelativePath = `${config.paths.optimized_dir}/${workshopId}.mp4`

          yield* db.exec(
            `INSERT INTO transcode_jobs (id, workshop_id, status, progress, created_at)
             VALUES (?, ?, 'pending', 0, ?)`,
            [jobId, workshopId, Date.now()]
          )

          yield* library.update(workshopId, {
            transcode_status: "pending",
            transcode_progress: 0,
            transcode_error: null,
          })

          yield* logger.info(`Enqueued transcode job ${jobId} for ${workshopId}`, {
            sourceRelativePath,
            outputRelativePath,
            targetCodec: decision.target_codec,
            screen,
          })
        }),

      claim: (worker) =>
        Effect.gen(function* () {
          // Atomic claim via UPDATE ... RETURNING — Phase 2 wiring.
          const row = yield* db.queryOne<{
            id: string
            workshop_id: string
          }>(
            `UPDATE transcode_jobs
             SET status = 'claimed', worker = ?, claimed_at = ?, last_heartbeat = ?
             WHERE id = (
               SELECT id FROM transcode_jobs
               WHERE status = 'pending'
               ORDER BY created_at ASC
               LIMIT 1
             )
             RETURNING id, workshop_id`,
            [worker, Date.now(), Date.now()]
          )
          if (!row) return null

          const lib = yield* library
            .get(row.workshop_id)
            .pipe(Effect.catchTag("LibraryNotFoundError", () => Effect.succeed(null)))
          if (!lib) return null

          yield* library.update(row.workshop_id, {
            transcode_status: "claimed",
            transcode_progress: 0,
            transcode_error: null,
          })

          return {
            id: row.id,
            workshop_id: row.workshop_id,
            source_relative_path: lib.source_path,
            output_relative_path: `${config.paths.optimized_dir}/${row.workshop_id}.mp4`,
            target_width: config.screen.width,
            target_height: config.screen.height,
            target_codec: config.transcode.target_codec,
            target_quality: config.transcode.target_quality,
          }
        }),

      heartbeat: (jobId) =>
        Effect.gen(function* () {
          // Promote claimed → running on first heartbeat, otherwise just bump
          // last_heartbeat. RETURNING workshop_id lets us also mirror status
          // into library on the first beat.
          const row = yield* db.queryOne<{ workshop_id: string; status: string }>(
            `UPDATE transcode_jobs
             SET last_heartbeat = ?,
                 status = CASE WHEN status = 'claimed' THEN 'running' ELSE status END
             WHERE id = ? AND status IN ('claimed','running')
             RETURNING workshop_id, status`,
            [Date.now(), jobId]
          )
          if (!row) return false

          if (row.status === "running") {
            yield* library.update(row.workshop_id, {
              transcode_status: "running",
            })
          }
          return true
        }),

      progress: (jobId, percent) =>
        Effect.gen(function* () {
          const clamped = Math.max(0, Math.min(100, Math.round(percent)))
          const row = yield* db.queryOne<{ workshop_id: string }>(
            `UPDATE transcode_jobs SET progress = ?, last_heartbeat = ?
             WHERE id = ? AND status IN ('claimed','running')
             RETURNING workshop_id`,
            [clamped, Date.now(), jobId]
          )
          if (!row) return
          yield* library.update(row.workshop_id, {
            transcode_progress: clamped,
          })
        }),

      complete: (jobId, report, targetResolution, targetCodec) =>
        Effect.gen(function* () {
          const row = yield* db.queryOne<{ workshop_id: string }>(
            `UPDATE transcode_jobs
             SET status = 'completed', progress = 100, completed_at = ?, error = NULL
             WHERE id = ? AND status IN ('claimed','running')
             RETURNING workshop_id`,
            [Date.now(), jobId]
          )
          if (!row) {
            yield* logger.warn(`complete(${jobId}) but job missing/stale — ignored`)
            return
          }

          yield* library.update(row.workshop_id, {
            transcode_status: "completed",
            transcode_progress: 100,
            transcode_error: null,
            transcoded_path: report.output_relative_path,
            transcoded_resolution: targetResolution,
            transcoded_codec: targetCodec,
            transcoded_size: report.output_size,
          })

          yield* logger.info(
            `Transcode complete ${jobId} (${row.workshop_id}) — ${report.output_size} bytes in ${report.duration_ms}ms`
          )
        }),

      fail: (jobId, error) =>
        Effect.gen(function* () {
          const row = yield* db.queryOne<{ workshop_id: string }>(
            `UPDATE transcode_jobs
             SET status = 'failed', error = ?, completed_at = ?
             WHERE id = ?
             RETURNING workshop_id`,
            [error, Date.now(), jobId]
          )
          if (!row) return

          yield* library.update(row.workshop_id, {
            transcode_status: "failed",
            transcode_error: error,
          })

          yield* logger.warn(`Transcode failed ${jobId} (${row.workshop_id}): ${error}`)
        }),
    }
  })
)
