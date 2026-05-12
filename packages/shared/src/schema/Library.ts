import { Schema } from "effect"
import { DisplayMode } from "./Config.js"

export const TranscodeStatus = Schema.Literal(
  "skipped",
  "pending",
  "claimed",
  "running",
  "completed",
  "failed"
)
export type TranscodeStatus = typeof TranscodeStatus.Type

export const LibraryItem = Schema.Struct({
  workshop_id: Schema.String,
  title: Schema.String,
  author: Schema.String,
  preview_url: Schema.String,
  source_path: Schema.String,
  source_resolution: Schema.String,
  source_codec: Schema.String,
  source_size: Schema.Number,
  downloaded_at: Schema.Number,

  transcode_status: TranscodeStatus,
  transcode_progress: Schema.Number,
  transcode_error: Schema.NullOr(Schema.String),
  transcoded_path: Schema.NullOr(Schema.String),
  transcoded_resolution: Schema.NullOr(Schema.String),
  transcoded_codec: Schema.NullOr(Schema.String),
  transcoded_size: Schema.NullOr(Schema.Number),

  display_mode: DisplayMode,
  last_played_at: Schema.NullOr(Schema.Number),
})
export type LibraryItem = typeof LibraryItem.Type

export const VideoProbe = Schema.Struct({
  width: Schema.Number,
  height: Schema.Number,
  codec: Schema.String,
  duration_seconds: Schema.Number,
  size_bytes: Schema.Number,
})
export type VideoProbe = typeof VideoProbe.Type
