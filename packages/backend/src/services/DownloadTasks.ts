import { Context, Effect, Layer } from "effect"
import { Db } from "./Db.js"
import { Logger } from "./Logger.js"
import type { DownloadStage, DownloadTask } from "@pwe/shared"

export interface PaginatedTasks {
  readonly items: ReadonlyArray<DownloadTask>
  readonly total: number
}

export interface DownloadTasksImpl {
  readonly list: (opts?: { offset?: number; limit?: number }) => Effect.Effect<PaginatedTasks>
  readonly getActiveByWorkshopId: (workshopId: string) => Effect.Effect<DownloadTask | null>
  readonly get: (taskId: string) => Effect.Effect<DownloadTask | null>
  readonly upsert: (
    taskId: string,
    patch: Partial<Omit<DownloadTask, "task_id">>
  ) => Effect.Effect<void>
  readonly dismiss: (taskId: string) => Effect.Effect<void>
  readonly dismissAll: (stage: DownloadStage) => Effect.Effect<void>
}

export class DownloadTasks extends Context.Tag("DownloadTasks")<
  DownloadTasks,
  DownloadTasksImpl
>() {}



const COLUMNS = [
  "task_id",
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

export const isFinishedTask = (stage: DownloadStage | string, finishedAt: number | null): boolean =>
  stage === "complete" || stage === "error" || finishedAt !== null

export const mergeDownloadTaskRow = (
  row: DownloadTask,
  patch: Partial<Omit<DownloadTask, "task_id">>
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

    return {
      list: (opts) =>
        Effect.gen(function* () {
          const limit = opts?.limit ?? 50
          const offset = opts?.offset ?? 0
          
          const totalRow = yield* db.queryOne<{ count: number }>(`SELECT count(*) as count FROM download_tasks`)
          const items = yield* db.query<DownloadTask>(
            `SELECT * FROM download_tasks ORDER BY started_at DESC LIMIT ? OFFSET ?`,
            [limit, offset]
          )
          
          return { items, total: totalRow?.count ?? 0 }
        }).pipe(
          Effect.catchAll((e) =>
            Effect.gen(function* () {
              yield* logger.error(`Failed to list download tasks: ${e.message}`)
              return { items: [], total: 0 }
            })
          )
        ),

      get: (taskId) =>
        db
          .queryOne<DownloadTask>(`SELECT * FROM download_tasks WHERE task_id = ?`, [
            taskId,
          ])
          .pipe(
            Effect.catchAll((e) =>
              Effect.gen(function* () {
                yield* logger.error(`Failed to get download task ${taskId}: ${e.message}`)
                return null
              })
            )
          ),

      getActiveByWorkshopId: (workshopId) =>
        db
          .queryOne<DownloadTask>(`SELECT * FROM download_tasks WHERE workshop_id = ? AND finished_at IS NULL ORDER BY started_at DESC LIMIT 1`, [
            workshopId,
          ])
          .pipe(
            Effect.catchAll((e) =>
              Effect.gen(function* () {
                yield* logger.error(`Failed to get active task for ${workshopId}: ${e.message}`)
                return null
              })
            )
          ),

      upsert: (taskId, patch) =>
        Effect.gen(function* () {
          let row = yield* db.queryOne<DownloadTask>(
            `SELECT * FROM download_tasks WHERE task_id = ?`,
            [taskId]
          )
          
          if (!row) {
            row = {
              task_id: taskId,
              workshop_id: patch.workshop_id ?? taskId,
              title: patch.title ?? patch.workshop_id ?? taskId,
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
            logger.error(`Failed to upsert download task ${taskId}: ${e.message}`)
          )
        ),

      dismiss: (taskId) =>
        db.exec(`DELETE FROM download_tasks WHERE task_id = ?`, [taskId]).pipe(
          Effect.catchAll((e) =>
            logger.error(`Failed to dismiss download task ${taskId}: ${e.message}`)
          )
        ),

      dismissAll: (stage) =>
        db.exec(`DELETE FROM download_tasks WHERE stage = ?`, [stage]).pipe(
          Effect.catchAll((e) =>
            logger.error(`Failed to dismiss all ${stage} tasks: ${e.message}`)
          )
        ),
    }
  })
)
