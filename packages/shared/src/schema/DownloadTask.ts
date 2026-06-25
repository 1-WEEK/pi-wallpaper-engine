import { Schema } from "effect"

// Download lifecycle stage, mirrored from downstream SteamCMD stdout.
export const DownloadStage = Schema.Literal(
  "starting",
  "downloading",
  "finalizing",
  "done",
  "complete",
  "error",
)
export type DownloadStage = typeof DownloadStage.Type

// A download task tracked in-memory by the backend's DownloadTasks service,
// surfaced via REST and consumed by the frontend's download / browse UIs.
export const DownloadTask = Schema.Struct({
  workshop_id: Schema.String,
  title: Schema.String,
  preview_url: Schema.String,
  content_rating: Schema.NullOr(Schema.String),
  rating_sex: Schema.NullOr(Schema.String),
  adult_hint: Schema.Number,
  stage: DownloadStage,
  message: Schema.String,
  started_at: Schema.Number,
  finished_at: Schema.NullOr(Schema.Number),
  percent: Schema.NullOr(Schema.Number),
  bytes_done: Schema.NullOr(Schema.Number),
  bytes_total: Schema.NullOr(Schema.Number),
})
export type DownloadTask = typeof DownloadTask.Type

// SteamCMD download progress events, emitted via Stream and consumed
// by the DownloadTasks service for stage transitions.
export interface DownloadProgress {
  readonly workshopId: string
  readonly stage: "starting" | "downloading" | "finalizing" | "done"
  readonly message: string
  readonly percent?: number
  readonly bytes_done?: number
  readonly bytes_total?: number
}
