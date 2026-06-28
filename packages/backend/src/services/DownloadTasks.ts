import { Context, Effect, Layer } from "effect"
import { Db } from "./Db.js"
import { Logger } from "./Logger.js"
import type { DownloadStage, DownloadTask } from "@pwe/shared"

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
  "content_rating",
  "rating_sex",
  "adult_hint",
  "stage",
  "message",
  "started_at",
  "finished_at",
  "percent",
  "bytes_done",
  "bytes_total",
] as const

const isTerminalStage = (stage: DownloadStage): boolean => stage === "complete" || stage === "error"

export const mergeDownloadTaskRow = (
  row: DownloadTask,
  patch: Partial<Omit<DownloadTask, "workshop_id">>
): DownloadTask => {
  const restarting = patch.finished_at === null
  const nextStage = patch.stage ?? row.stage

  if (row.finished_at !== null && !restarting && !isTerminalStage(nextStage) && patch.finished_at === undefined) {
    return row
  }

  return { ...row, ...patch }
}

export const DownloadTasksLive = Layer.effect(
  DownloadTasks,
  Effect.gen(function* () {
    const db = yield* Db
    const logger = yield* Logger

    const sweep = () =>
      db.exec(`DELETE FROM download_tasks WHERE finished_at IS NOT NULL AND finished_at < ?`, [
        Date.now() - FINISHED_TTL_MS,
      ])

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
              content_rating: null,
              rating_sex: null,
              adult_hint: 0,
              stage: "starting",
              message: "",
              started_at: Date.now(),
              finished_at: null,
              percent: null,
              bytes_done: null,
              bytes_total: null,
            }
          }

          const merged = mergeDownloadTaskRow(row, patch)

          const placeholders = COLUMNS.map(() => "?").join(",")
          const values = COLUMNS.map((c) => (merged as unknown as Record<string, unknown>)[c] ?? null)
          
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
