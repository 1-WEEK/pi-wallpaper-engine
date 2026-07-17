import { Context, Effect, Layer } from "effect"
import { Db } from "./Db.js"
import { Logger } from "./Logger.js"
import { isTerminalTaskStage, type TaskStage, type ActivityTask } from "@pwe/shared"

export interface PaginatedTasks {
  readonly items: ReadonlyArray<ActivityTask>
  readonly total: number
}

export interface TasksImpl {
  readonly list: (opts?: {
    offset?: number
    limit?: number
    active?: boolean
    type?: ActivityTask["task_type"]
  }) => Effect.Effect<PaginatedTasks>
  readonly getActiveByWorkshopId: (workshopId: string) => Effect.Effect<ActivityTask | null>
  readonly get: (taskId: string) => Effect.Effect<ActivityTask | null>
  readonly upsert: (
    taskId: string,
    patch: Partial<Omit<ActivityTask, "task_id">>
  ) => Effect.Effect<void>
  readonly dismiss: (taskId: string) => Effect.Effect<void>
  readonly dismissAll: (stage: Extract<TaskStage, "complete" | "error">) => Effect.Effect<void>
}

export class Tasks extends Context.Tag("Tasks")<
  Tasks,
  TasksImpl
>() {}

const COLUMNS = [
  "task_id",
  "task_type",
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

const isTerminalStage = (stage: TaskStage): boolean => isTerminalTaskStage(stage)

export const isFinishedTask = (stage: TaskStage | string, finishedAt: number | null): boolean =>
  isTerminalTaskStage(stage) || finishedAt !== null

export const mergeTaskRow = (
  row: ActivityTask,
  patch: Partial<Omit<ActivityTask, "task_id">>
): ActivityTask => {
  const restarting = patch.finished_at === null
  const nextStage = patch.stage ?? row.stage

  if (row.finished_at !== null && !restarting && !isTerminalStage(nextStage) && patch.finished_at === undefined) {
    return row
  }

  return { ...row, ...patch }
}

export const TasksLive = Layer.effect(
  Tasks,
  Effect.gen(function* () {
    const db = yield* Db
    const logger = yield* Logger

    return {
      list: (opts) =>
        Effect.gen(function* () {
          const limit = opts?.limit ?? 50
          const offset = opts?.offset ?? 0
          const conditions: string[] = []
          const filterParams: unknown[] = []
          if (opts?.active) conditions.push(`finished_at IS NULL`)
          if (opts?.type) {
            conditions.push(`task_type = ?`)
            filterParams.push(opts.type)
          }
          const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ``

          const totalRow = yield* db.queryOne<{ count: number }>(
            `SELECT count(*) as count FROM tasks ${where}`,
            filterParams
          )
          const items = yield* db.query<ActivityTask>(
            `SELECT * FROM tasks ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
            [...filterParams, limit, offset]
          )

          return { items, total: totalRow?.count ?? 0 }
        }).pipe(
          Effect.catchAll((e) =>
            Effect.gen(function* () {
              yield* logger.error(`Failed to list tasks: ${e.message}`)
              return { items: [], total: 0 }
            })
          )
        ),

      get: (taskId) =>
        db
          .queryOne<ActivityTask>(`SELECT * FROM tasks WHERE task_id = ?`, [
            taskId,
          ])
          .pipe(
            Effect.catchAll((e) =>
              Effect.gen(function* () {
                yield* logger.error(`Failed to get task ${taskId}: ${e.message}`)
                return null
              })
            )
          ),

      getActiveByWorkshopId: (workshopId) =>
        db
          .queryOne<ActivityTask>(`SELECT * FROM tasks WHERE workshop_id = ? AND finished_at IS NULL ORDER BY started_at DESC LIMIT 1`, [
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
          let row = yield* db.queryOne<ActivityTask>(
            `SELECT * FROM tasks WHERE task_id = ?`,
            [taskId]
          )

          if (!row) {
            // An insert needs a workshop id — minting a row keyed on the task
            // UUID alone would be unfindable by workshop id.
            if (!patch.workshop_id) {
              yield* logger.error(`Refusing to insert task ${taskId} without workshop_id`)
              return
            }
            row = {
              task_id: taskId,
              task_type: patch.task_type ?? "download",
              workshop_id: patch.workshop_id,
              title: patch.title ?? patch.workshop_id,
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

          // undefined means "leave alone" — callers pass it for fields they
          // have no fresh value for, and spreading it would blank the column.
          const cleanPatch = Object.fromEntries(
            Object.entries(patch).filter(([, value]) => value !== undefined)
          ) as Partial<Omit<ActivityTask, "task_id">>
          const merged = mergeTaskRow(row, cleanPatch)

          const placeholders = COLUMNS.map(() => "?").join(",")
          const values = COLUMNS.map((c) => (merged as unknown as Record<string, unknown>)[c] ?? null)
          
          yield* db.exec(
            `INSERT OR REPLACE INTO tasks (${COLUMNS.join(",")}) VALUES (${placeholders})`,
            values
          )
        }).pipe(
          Effect.catchAll((e) =>
            logger.error(`Failed to upsert task ${taskId}: ${e.message}`)
          )
        ),

      dismiss: (taskId) =>
        db.exec(`DELETE FROM tasks WHERE task_id = ?`, [taskId]).pipe(
          Effect.catchAll((e) =>
            logger.error(`Failed to dismiss task ${taskId}: ${e.message}`)
          )
        ),

      dismissAll: (stage) =>
        Effect.gen(function* () {
          // "Clear Failed" sweeps download errors and transcode failures
          // alike; "complete" already covers both task types.
          const stages: readonly TaskStage[] = stage === "error" ? ["error", "failed"] : [stage]
          const placeholders = stages.map(() => "?").join(",")
          yield* db.exec(`DELETE FROM tasks WHERE stage IN (${placeholders})`, [...stages])
        }).pipe(
          Effect.catchAll((e) =>
            logger.error(`Failed to dismiss all ${stage} tasks: ${e.message}`)
          )
        ),
    }
  })
)
