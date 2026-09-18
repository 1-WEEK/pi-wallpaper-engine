import { Schema } from "effect"
import { TargetCodec } from "./Config.js"

// Phase 2 — Worker pull protocol. Schemas are defined now so backend can be wired
// to the contract; routes that consume them stay unmounted until Phase 2.

export const TranscodeJobStatus = Schema.Literals([
  "pending",
  "claimed",
  "running",
  "uploading",
  "completed",
  "failed"
])
export type TranscodeJobStatus = typeof TranscodeJobStatus.Type

export const TranscodeJob = Schema.Struct({
  id: Schema.String,
  workshop_id: Schema.String,
  // Worker is a compute node only. It pulls source bytes from the Pi and
  // uploads the artifact back; the Pi owns final storage placement.
  source_url: Schema.String,
  artifact_url: Schema.String,
  target_width: Schema.Number,
  target_height: Schema.Number,
  target_codec: TargetCodec,
  target_quality: Schema.Number,
})
export type TranscodeJob = typeof TranscodeJob.Type

export const ClaimRequest = Schema.Struct({
  worker: Schema.String.check(Schema.isMinLength(1)),
})

export const HeartbeatResponse = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({ ok: Schema.Literal(false), reason: Schema.String })
])

export const ProgressReport = Schema.Struct({
  progress: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
})

export const FailReport = Schema.Struct({
  error: Schema.String,
})

export const TranscodeProgressEvent = Schema.Struct({
  jobId: Schema.String,
  workshopId: Schema.String,
  status: TranscodeJobStatus,
  progress: Schema.optionalKey(Schema.Number),
  error: Schema.optionalKey(Schema.String)
})
export type TranscodeProgressEvent = typeof TranscodeProgressEvent.Type
