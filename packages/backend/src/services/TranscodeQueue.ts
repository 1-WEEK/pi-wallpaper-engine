import { Context, Effect, Layer } from "effect"
import { ulid } from "ulid"
import type { TranscodeJob } from "@pwe/shared"
import { DbError } from "@pwe/shared"
import type { ScreenSpec, TranscodeDecision } from "../transcode/decide.js"
import { Config } from "./Config.js"
import { Db } from "./Db.js"
import { Library } from "./Library.js"
import { Logger } from "./Logger.js"

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
}

export class TranscodeQueue extends Context.Tag("TranscodeQueue")<
  TranscodeQueue,
  TranscodeQueueImpl
>() {}

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
    }
  })
)

/**
 * Phase 2 layer. Writes a transcode_jobs row, lets the Worker pull it.
 * Defined now so the contract is complete and stable; not wired in Phase 1.
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
    }
  })
)
