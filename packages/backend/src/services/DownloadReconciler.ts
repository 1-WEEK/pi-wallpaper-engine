import { Context, Effect, Layer } from "effect"
import { rm } from "node:fs/promises"
import { resolve } from "node:path"
import type { DownloadTask } from "@pwe/shared"
import { Config } from "./Config.js"
import { Db } from "./Db.js"
import { DownloadProcessRegistry } from "./DownloadProcessRegistry.js"
import { Library } from "./Library.js"
import { Logger } from "./Logger.js"
import { Storage } from "./Storage.js"

export interface DownloadReconcilerImpl {
  readonly startup: () => Effect.Effect<void>
  readonly reconcileStale: () => Effect.Effect<void>
}

export class DownloadReconciler extends Context.Tag("DownloadReconciler")<
  DownloadReconciler,
  DownloadReconcilerImpl
>() {}

export interface DownloadReconcilerOptions {
  readonly staleGraceMs?: number
  readonly sweepIntervalMs?: number
  readonly startSweeper?: boolean
  readonly now?: () => number
}

export const DOWNLOAD_STALE_GRACE_MS = 10 * 60 * 1000
export const DOWNLOAD_STALE_SWEEP_INTERVAL_MS = 5 * 60 * 1000

export const reconcileFinishedTaskState = (
  hasLibraryRow: boolean
): Pick<DownloadTask, "stage" | "message"> =>
  hasLibraryRow
    ? { stage: "complete", message: "Library updated" }
    : { stage: "error", message: "Download did not finalize" }

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const promiseError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause))

export const makeDownloadReconcilerLive = (opts: DownloadReconcilerOptions = {}) =>
  Layer.effect(
    DownloadReconciler,
    Effect.gen(function* () {
      const db = yield* Db
      const logger = yield* Logger
      const library = yield* Library
      const config = yield* Config
      const storage = yield* Storage
      const processRegistry = yield* DownloadProcessRegistry

      const staleGraceMs = opts.staleGraceMs ?? DOWNLOAD_STALE_GRACE_MS
      const sweepIntervalMs = opts.sweepIntervalMs ?? DOWNLOAD_STALE_SWEEP_INTERVAL_MS
      const startSweeper = opts.startSweeper ?? true
      const now = opts.now ?? (() => Date.now())

      const stopProcesses = (rows: ReadonlyArray<{ workshop_id: string }>) =>
        Effect.gen(function* () {
          for (const { workshop_id } of rows) {
            yield* processRegistry.stop(workshop_id).pipe(
              Effect.catchAll((e) =>
                logger.warn(`Failed to stop SteamCMD process for ${workshop_id}: ${errorMessage(e)}`)
              )
            )
          }
        })

      const libraryOwnsSource = (workshopId: string): Effect.Effect<boolean> =>
        library.get(workshopId).pipe(
          Effect.as(true),
          Effect.catchTag("LibraryNotFoundError", () => Effect.succeed(false)),
          Effect.catchAll((e) =>
            logger
              .warn(
                `Skipping source cleanup for ${workshopId}: failed to check library ownership: ${errorMessage(e)}`
              )
              .pipe(Effect.as(true))
          )
        )

      const cleanSourceLeftovers = (
        rows: ReadonlyArray<{ workshop_id: string }>,
        messages: {
          readonly unavailable: string
          readonly cleaned: (sourceDir: string) => string
          readonly failed: (sourceDir: string, error: Error) => string
        }
      ) =>
        Effect.gen(function* () {
          if (rows.length === 0) return

          const dataRoot = yield* storage.mediaRootOrNull()
          if (!dataRoot) {
            yield* logger.warn(messages.unavailable)
            return
          }

          for (const { workshop_id } of rows) {
            const owned = yield* libraryOwnsSource(workshop_id)
            if (owned) continue

            const sourceDir = resolve(dataRoot, config.paths.source_dir, workshop_id)
            yield* Effect.tryPromise({
              try: () => rm(sourceDir, { recursive: true, force: true }),
              catch: promiseError,
            }).pipe(
              Effect.tap(() => logger.info(messages.cleaned(sourceDir))),
              Effect.catchAll((e) => logger.warn(messages.failed(sourceDir, e)))
            )
          }
        })

      const reconcileInterrupted = Effect.gen(function* () {
        const interrupted = yield* db.query<{ workshop_id: string }>(
          `SELECT workshop_id FROM download_tasks WHERE finished_at IS NULL`
        )
        if (interrupted.length === 0) return

        yield* db.exec(
          `UPDATE download_tasks
           SET stage = 'error',
               message = 'Interrupted by restart',
               finished_at = ?
           WHERE finished_at IS NULL`,
          [now()]
        )
        yield* logger.info(`Reconciled ${interrupted.length} interrupted download task(s)`)

        yield* stopProcesses(interrupted)
        yield* cleanSourceLeftovers(interrupted, {
          unavailable: "Skipping orphan source cleanup because mounted storage is disconnected",
          cleaned: (sourceDir) => `Cleaned orphan source dir: ${sourceDir}`,
          failed: (sourceDir, error) => `Failed to clean orphan ${sourceDir}: ${error.message}`,
        })
      })

      const reconcileInconsistentFinished = Effect.gen(function* () {
        const inconsistent = yield* db.query<DownloadTask>(
          `SELECT * FROM download_tasks WHERE finished_at IS NOT NULL AND stage NOT IN ('complete', 'error')`
        )

        for (const row of inconsistent) {
          const hasLibraryRow = yield* library
            .get(row.workshop_id)
            .pipe(Effect.as(true), Effect.catchTag("LibraryNotFoundError", () => Effect.succeed(false)))
          const patch = reconcileFinishedTaskState(hasLibraryRow)
          yield* db.exec(
            `UPDATE download_tasks SET stage = ?, message = ? WHERE workshop_id = ?`,
            [patch.stage, patch.message, row.workshop_id]
          )
        }

        if (inconsistent.length > 0) {
          yield* logger.info(`Reconciled ${inconsistent.length} inconsistent finished download task(s)`)
        }
      })

      const startup = () =>
        Effect.gen(function* () {
          yield* reconcileInterrupted
          yield* reconcileInconsistentFinished
        }).pipe(Effect.catchAll((e) => logger.error(`Download reconcile failed: ${errorMessage(e)}`)))

      const reconcileStale = () =>
        Effect.gen(function* () {
          const cutoff = now() - staleGraceMs
          const stale = yield* db.query<{ workshop_id: string; started_at: number }>(
            `SELECT workshop_id, started_at FROM download_tasks
             WHERE finished_at IS NULL AND started_at < ?`,
            [cutoff]
          )
          if (stale.length === 0) return

          yield* db.exec(
            `UPDATE download_tasks
             SET stage = 'error',
                 message = 'Cancelled (stale task)',
                 finished_at = ?
             WHERE finished_at IS NULL AND started_at < ?`,
            [now(), cutoff]
          )
          yield* logger.info(`Cleaned ${stale.length} stale download task(s)`)

          yield* stopProcesses(stale)
          yield* cleanSourceLeftovers(stale, {
            unavailable: "Skipping stale source cleanup because mounted storage is disconnected",
            cleaned: (sourceDir) => `Cleaned stale source dir: ${sourceDir}`,
            failed: (sourceDir, error) => `Failed to clean stale ${sourceDir}: ${error.message}`,
          })
        }).pipe(Effect.catchAll((e) => logger.error(`Stale task sweep failed: ${errorMessage(e)}`)))

      const reconciler: DownloadReconcilerImpl = {
        startup,
        reconcileStale,
      }

      yield* reconciler.startup()

      if (startSweeper) {
        yield* Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(`${sweepIntervalMs} millis`)
            yield* reconciler.reconcileStale()
          }
        }).pipe(Effect.fork)
      }

      return reconciler
    })
  )

export const DownloadReconcilerLive = makeDownloadReconcilerLive()
