import { Context, Effect, Layer } from "effect"
import { resolve } from "node:path"
import { rm } from "node:fs/promises"
import { Config } from "./Config.js"
import { Db } from "./Db.js"
import { Library } from "./Library.js"
import { Logger } from "./Logger.js"

export type DownloadStage =
  | "starting"
  | "downloading"
  | "finalizing"
  | "done"
  | "complete"
  | "error"

export interface DownloadTask {
  readonly workshop_id: string
  readonly title: string
  readonly preview_url: string
  readonly stage: DownloadStage
  readonly message: string
  readonly started_at: number
  readonly finished_at: number | null
  // Populated only while SteamCMD is in the downloading phase and emitting
  // its `progress: X.XX (Y / Z)` lines. UI falls back to an indeterminate
  // bar when these are absent.
  readonly percent: number | null
  readonly bytes_done: number | null
  readonly bytes_total: number | null
}

export interface DownloadTasksImpl {
  readonly list: () => Effect.Effect<ReadonlyArray<DownloadTask>>
  readonly get: (workshopId: string) => Effect.Effect<DownloadTask | null>
  readonly upsert: (
    workshopId: string,
    patch: Partial<Omit<DownloadTask, "workshop_id">>
  ) => Effect.Effect<void>
  readonly dismiss: (workshopId: string) => Effect.Effect<void>
}

export class DownloadTasks extends Context.Tag("DownloadTasks")<
  DownloadTasks,
  DownloadTasksImpl
>() {}

// Finished tasks (complete/error) auto-evict after this window so the list
// doesn't grow forever during long sessions. The user can also dismiss any
// task manually via the UI.
const FINISHED_TTL_MS = 60 * 60 * 1000

const COLUMNS = [
  "workshop_id",
  "title",
  "preview_url",
  "stage",
  "message",
  "started_at",
  "finished_at",
  "percent",
  "bytes_done",
  "bytes_total",
] as const

export const DownloadTasksLive = Layer.effect(
  DownloadTasks,
  Effect.gen(function* () {
    const db = yield* Db
    const logger = yield* Logger
    const library = yield* Library
    const config = yield* Config

    const sweep = () =>
      db.exec(`DELETE FROM download_tasks WHERE finished_at IS NOT NULL AND finished_at < ?`, [
        Date.now() - FINISHED_TTL_MS,
      ])

    // Startup reconcile: any row still marked in-flight is a zombie from a
    // previous crash. Mark them errored and remove their source dir unless
    // the library already has a successful entry (in which case the files
    // are real and belong to that entry, not the failed download).
    const reconcile = Effect.gen(function* () {
      const orphans = yield* db.query<{ workshop_id: string }>(
        `SELECT workshop_id FROM download_tasks WHERE finished_at IS NULL`
      )
      if (orphans.length === 0) return

      yield* db.exec(
        `UPDATE download_tasks
         SET stage = 'error',
             message = 'Interrupted by restart',
             finished_at = ?
         WHERE finished_at IS NULL`,
        [Date.now()]
      )
      yield* logger.info(`Reconciled ${orphans.length} interrupted download task(s)`)

      for (const { workshop_id } of orphans) {
        const lib = yield* library
          .get(workshop_id)
          .pipe(Effect.catchTag("LibraryNotFoundError", () => Effect.succeed(null)))
        if (lib) continue
        const sourceDir = resolve(config.paths.data_root, config.paths.source_dir, workshop_id)
        yield* Effect.tryPromise({
          try: () => rm(sourceDir, { recursive: true, force: true }),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        }).pipe(
          Effect.tap(() => logger.info(`Cleaned orphan source dir: ${sourceDir}`)),
          Effect.catchAll((e) => logger.warn(`Failed to clean orphan ${sourceDir}: ${e.message}`))
        )
      }
    }).pipe(Effect.catchAll((e) => logger.error(`Reconcile failed: ${e.message}`)))

    yield* reconcile

    return {
      list: () =>
        Effect.gen(function* () {
          yield* sweep()
          return yield* db.query<DownloadTask>(
            `SELECT * FROM download_tasks ORDER BY started_at DESC`
          )
        }).pipe(
          Effect.catchAll((e) =>
            Effect.gen(function* () {
              yield* logger.error(`Failed to list download tasks: ${e.message}`)
              return []
            })
          )
        ),

      get: (workshopId) =>
        db
          .queryOne<DownloadTask>(`SELECT * FROM download_tasks WHERE workshop_id = ?`, [
            workshopId,
          ])
          .pipe(
            Effect.catchAll((e) =>
              Effect.gen(function* () {
                yield* logger.error(`Failed to get download task ${workshopId}: ${e.message}`)
                return null
              })
            )
          ),

      upsert: (workshopId, patch) =>
        Effect.gen(function* () {
          let row = yield* db.queryOne<DownloadTask>(
            `SELECT * FROM download_tasks WHERE workshop_id = ?`,
            [workshopId]
          )
          
          if (!row) {
            row = {
              workshop_id: workshopId,
              title: workshopId,
              preview_url: "",
              stage: "starting",
              message: "",
              started_at: Date.now(),
              finished_at: null,
              percent: null,
              bytes_done: null,
              bytes_total: null,
            }
          }

          const merged = { ...row, ...patch }

          const placeholders = COLUMNS.map(() => "?").join(",")
          const values = COLUMNS.map((c) => (merged as Record<string, unknown>)[c] ?? null)
          
          yield* db.exec(
            `INSERT OR REPLACE INTO download_tasks (${COLUMNS.join(",")}) VALUES (${placeholders})`,
            values
          )
        }).pipe(
          Effect.catchAll((e) =>
            logger.error(`Failed to upsert download task ${workshopId}: ${e.message}`)
          )
        ),

      dismiss: (workshopId) =>
        db.exec(`DELETE FROM download_tasks WHERE workshop_id = ?`, [workshopId]).pipe(
          Effect.catchAll((e) =>
            logger.error(`Failed to dismiss download task ${workshopId}: ${e.message}`)
          )
        ),
    }
  })
)
