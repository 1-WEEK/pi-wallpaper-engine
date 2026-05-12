import { Context, Effect, Layer } from "effect"

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

export const DownloadTasksLive = Layer.effect(
  DownloadTasks,
  Effect.gen(function* () {
    const state = new Map<string, DownloadTask>()

    const sweep = () => {
      const now = Date.now()
      for (const [id, task] of state) {
        if (task.finished_at && task.finished_at + FINISHED_TTL_MS < now) {
          state.delete(id)
        }
      }
    }

    return {
      list: () =>
        Effect.sync(() => {
          sweep()
          return Array.from(state.values()).sort((a, b) => b.started_at - a.started_at)
        }),

      upsert: (workshopId, patch) =>
        Effect.sync(() => {
          const prev: DownloadTask = state.get(workshopId) ?? {
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
          state.set(workshopId, { ...prev, ...patch })
        }),

      dismiss: (workshopId) =>
        Effect.sync(() => {
          state.delete(workshopId)
        }),
    }
  })
)
