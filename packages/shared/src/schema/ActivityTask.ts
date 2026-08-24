import { Schema } from "effect"

export const TaskStage = Schema.Literal(
  "starting",
  "downloading",
  "finalizing",
  "done",
  "complete",
  "error",
  // transcode stages
  "pending",
  "claimed",
  "running",
  "uploading",
  "failed"
)
export type TaskStage = typeof TaskStage.Type

export const ActivityTask = Schema.Struct({
  task_id: Schema.String,
  task_type: Schema.Literal("download", "transcode"),
  workshop_id: Schema.String,
  title: Schema.String,
  preview_url: Schema.String,
  content_rating: Schema.NullOr(Schema.String),
  rating_sex: Schema.NullOr(Schema.String),
  adult_hint: Schema.Number,
  stage: TaskStage,
  message: Schema.String,
  started_at: Schema.Number,
  finished_at: Schema.NullOr(Schema.Number),
  percent: Schema.NullOr(Schema.Number),
  bytes_done: Schema.NullOr(Schema.Number),
  bytes_total: Schema.NullOr(Schema.Number),
})
export type ActivityTask = typeof ActivityTask.Type

// Terminal stages shared by both task types; history and bulk-clear rely on it.
export const isTerminalTaskStage = (stage: TaskStage | string): boolean =>
  stage === "complete" || stage === "error" || stage === "failed"

// SteamCMD download progress events, emitted via Stream and consumed
// by the Tasks service for stage transitions.
export interface DownloadProgress {
  readonly workshopId: string
  readonly stage: "starting" | "downloading" | "finalizing" | "done"
  readonly message: string
  readonly percent?: number
  readonly bytes_done?: number
  readonly bytes_total?: number
}
