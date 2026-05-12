import { Schema } from "effect"
import { TargetCodec } from "./Config.js"

// Phase 2 — Worker pull protocol. Schemas are defined now so backend can be wired
// to the contract; routes that consume them stay unmounted until Phase 2.

export const TranscodeJobStatus = Schema.Literal(
  "pending",
  "claimed",
  "running",
  "completed",
  "failed"
)
export type TranscodeJobStatus = typeof TranscodeJobStatus.Type

export const TranscodeJob = Schema.Struct({
  id: Schema.String,
  workshop_id: Schema.String,
  // Relative paths under data_root. Worker prefixes /data, Pi prefixes data_root.
  source_relative_path: Schema.String,
  output_relative_path: Schema.String,
  target_width: Schema.Number,
  target_height: Schema.Number,
  target_codec: TargetCodec,
  target_quality: Schema.Number,
})
export type TranscodeJob = typeof TranscodeJob.Type

export const ClaimRequest = Schema.Struct({
  worker: Schema.String.pipe(Schema.minLength(1)),
})

export const HeartbeatResponse = Schema.Union(
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({ ok: Schema.Literal(false), reason: Schema.String })
)

export const ProgressReport = Schema.Struct({
  progress: Schema.Number.pipe(Schema.between(0, 100)),
})

export const CompleteReport = Schema.Struct({
  // Worker writes <output>.partial then renames on success. Reports the final
  // relative path (under data_root). Always equals job.output_relative_path
  // but reported back for verification.
  output_relative_path: Schema.String,
  output_size: Schema.Number,
  duration_ms: Schema.Number,
})

export const FailReport = Schema.Struct({
  error: Schema.String,
})
