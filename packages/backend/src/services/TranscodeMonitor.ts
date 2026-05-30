import { Context, Effect, Layer, Schedule } from "effect"
import { Config } from "./Config.js"
import { Db } from "./Db.js"
import { Library } from "./Library.js"
import { Logger } from "./Logger.js"

export interface TranscodeMonitorImpl {
  /**
   * One reaper pass. Exposed for tests and for forcing a sweep at runtime.
   * Returns the number of stale jobs that were reset.
   */
  readonly sweep: () => Effect.Effect<number>
}

export class TranscodeMonitor extends Context.Tag("TranscodeMonitor")<
  TranscodeMonitor,
  TranscodeMonitorImpl
>() {}

interface StaleRow {
  readonly id: string
  readonly workshop_id: string
  readonly worker: string | null
  readonly last_heartbeat: number | null
}

const buildSweep = (
  db: Context.Tag.Service<Db>,
  library: Context.Tag.Service<Library>,
  logger: Context.Tag.Service<Logger>,
  heartbeatTimeoutMs: number
) =>
  Effect.gen(function* () {
    const cutoff = Date.now() - heartbeatTimeoutMs

    const stale = yield* db
      .query<StaleRow>(
        `SELECT id, workshop_id, worker, last_heartbeat
         FROM transcode_jobs
         WHERE status IN ('claimed','running')
           AND (last_heartbeat IS NULL OR last_heartbeat < ?)`,
        [cutoff]
      )
      .pipe(
        Effect.catchAll((e) =>
          logger.error(`TranscodeMonitor.sweep query failed: ${e.operation}`).pipe(
            Effect.as<StaleRow[]>([])
          )
        )
      )

    let recovered = 0
    for (const row of stale) {
      const reset = yield* db
        .exec(
          `UPDATE transcode_jobs
           SET status = 'pending', worker = NULL, claimed_at = NULL, last_heartbeat = NULL
           WHERE id = ? AND status IN ('claimed','running')`,
          [row.id]
        )
        .pipe(
          Effect.as(true),
          Effect.catchAll((e) =>
            logger
              .warn(`TranscodeMonitor.sweep reset failed for ${row.id}: ${e.operation}`)
              .pipe(Effect.as(false))
          )
        )
      if (!reset) continue

      yield* library
        .update(row.workshop_id, {
          transcode_status: "pending",
          transcode_progress: 0,
          transcode_error: null,
        })
        .pipe(
          Effect.catchAll((e) =>
            logger.warn(
              `TranscodeMonitor.sweep library.update(${row.workshop_id}) failed: ${e.operation}`
            )
          )
        )

      yield* logger.warn(
        `TranscodeMonitor recovered stale job ${row.id} (${row.workshop_id}) — worker=${row.worker ?? "?"} last_heartbeat=${row.last_heartbeat ?? "null"}`
      )
      recovered += 1
    }
    return recovered
  })

/**
 * Constructs the service without spawning the background loop. Used in tests
 * (no fork) and as the base for `TranscodeMonitorLive` (which adds the fork).
 */
export const TranscodeMonitorBareLayer = Layer.effect(
  TranscodeMonitor,
  Effect.gen(function* () {
    const config = yield* Config
    const db = yield* Db
    const library = yield* Library
    const logger = yield* Logger

    return {
      sweep: () => buildSweep(db, library, logger, config.transcode.heartbeat_timeout_ms),
    }
  })
)

export const TranscodeMonitorLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const config = yield* Config
    const db = yield* Db
    const library = yield* Library
    const logger = yield* Logger
    const heartbeatTimeoutMs = config.transcode.heartbeat_timeout_ms

    const sweep = () => buildSweep(db, library, logger, heartbeatTimeoutMs)

    // 30s tick: long enough to avoid hot-looping, short enough to recover
    // within heartbeat_timeout_ms + tick on average. First sweep is delayed
    // by one tick so a freshly-booted backend doesn't immediately reap jobs
    // a Worker is still in the process of claiming.
    const tickSchedule = Schedule.spaced("30 seconds")

    const loop = Effect.gen(function* () {
      yield* logger.info(
        `TranscodeMonitor started (heartbeat_timeout=${heartbeatTimeoutMs}ms, tick=30s)`
      )
      yield* sweep().pipe(
        Effect.delay("30 seconds"),
        Effect.repeat(tickSchedule),
        Effect.catchAllCause((cause) =>
          logger.error(`TranscodeMonitor loop crashed: ${String(cause)}`)
        )
      )
    }).pipe(Effect.ensuring(logger.info("TranscodeMonitor stopped")))

    yield* Effect.forkScoped(loop)
  })
).pipe(Layer.provideMerge(TranscodeMonitorBareLayer))
