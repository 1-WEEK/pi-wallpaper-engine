import { Elysia, t } from "elysia"
import { Effect, Schema } from "effect"
import {
  ClaimRequest,
  CompleteReport as CompleteReportSchema,
  FailReport,
  ProgressReport,
} from "@pwe/shared"
import { Config } from "../services/Config.js"
import { TranscodeQueue } from "../services/TranscodeQueue.js"
import { workerGuard } from "../middleware/workerGuard.js"
import type { AppRuntime } from "../runtime.js"

// Body shape for /complete and /fail / /progress / /claim. Elysia's `t.*`
// gives us runtime body validation; we re-validate via Effect Schema where
// it matters (CompleteReport, ProgressReport) since the shared package is
// the source of truth.
const ClaimBody = t.Object({ worker: t.String({ minLength: 1 }) })
const ProgressBody = t.Object({ progress: t.Number({ minimum: 0, maximum: 100 }) })
const CompleteBody = t.Object({
  output_relative_path: t.String({ minLength: 1 }),
  output_size: t.Number({ minimum: 0 }),
  duration_ms: t.Number({ minimum: 0 }),
})
const FailBody = t.Object({ error: t.String({ minLength: 1, maxLength: 4000 }) })

const decodeProgress = Schema.decodeUnknown(ProgressReport)
const decodeComplete = Schema.decodeUnknown(CompleteReportSchema)
const decodeFail = Schema.decodeUnknown(FailReport)
const decodeClaim = Schema.decodeUnknown(ClaimRequest)

export const transcodeRoutes = (runtime: AppRuntime) =>
  new Elysia({ prefix: "/api/transcode" })
    .use(workerGuard())

    .post(
      "/claim",
      ({ body, set }) =>
        runtime
          .runPromise(
            Effect.gen(function* () {
              const req = yield* decodeClaim(body).pipe(
                Effect.mapError((e) => new Error(`Invalid claim body: ${String(e)}`))
              )
              const queue = yield* TranscodeQueue
              const job = yield* queue.claim(req.worker)
              if (!job) {
                set.status = 204
                return null
              }
              return job
            })
          )
          .catch((e) => {
            set.status = 500
            return { ok: false, error: e instanceof Error ? e.message : String(e) }
          }),
      { body: ClaimBody }
    )

    .post(
      "/:jobId/heartbeat",
      ({ params, set }) =>
        runtime
          .runPromise(
            Effect.gen(function* () {
              const queue = yield* TranscodeQueue
              const ok = yield* queue.heartbeat(params.jobId)
              if (!ok) {
                set.status = 404
                return { ok: false, error: "Job not found or no longer owned by worker." }
              }
              return { ok: true }
            })
          )
          .catch((e) => {
            set.status = 500
            return { ok: false, error: e instanceof Error ? e.message : String(e) }
          })
    )

    .post(
      "/:jobId/progress",
      ({ params, body, set }) =>
        runtime
          .runPromise(
            Effect.gen(function* () {
              const req = yield* decodeProgress(body).pipe(
                Effect.mapError((e) => new Error(`Invalid progress body: ${String(e)}`))
              )
              const queue = yield* TranscodeQueue
              yield* queue.progress(params.jobId, req.progress)
              return { ok: true }
            })
          )
          .catch((e) => {
            set.status = 500
            return { ok: false, error: e instanceof Error ? e.message : String(e) }
          }),
      { body: ProgressBody }
    )

    .post(
      "/:jobId/complete",
      ({ params, body, set }) =>
        runtime
          .runPromise(
            Effect.gen(function* () {
              const req = yield* decodeComplete(body).pipe(
                Effect.mapError((e) => new Error(`Invalid complete body: ${String(e)}`))
              )
              const config = yield* Config
              const queue = yield* TranscodeQueue
              // Workshop-side decisions used the Pi's screen at enqueue time;
              // record the same dimensions as the canonical target_resolution.
              const targetResolution = `${config.screen.width}x${config.screen.height}`
              yield* queue.complete(
                params.jobId,
                {
                  output_relative_path: req.output_relative_path,
                  output_size: req.output_size,
                  duration_ms: req.duration_ms,
                },
                targetResolution,
                config.transcode.target_codec
              )
              return { ok: true }
            })
          )
          .catch((e) => {
            set.status = 500
            return { ok: false, error: e instanceof Error ? e.message : String(e) }
          }),
      { body: CompleteBody }
    )

    .post(
      "/:jobId/fail",
      ({ params, body, set }) =>
        runtime
          .runPromise(
            Effect.gen(function* () {
              const req = yield* decodeFail(body).pipe(
                Effect.mapError((e) => new Error(`Invalid fail body: ${String(e)}`))
              )
              const queue = yield* TranscodeQueue
              yield* queue.fail(params.jobId, req.error)
              return { ok: true }
            })
          )
          .catch((e) => {
            set.status = 500
            return { ok: false, error: e instanceof Error ? e.message : String(e) }
          }),
      { body: FailBody }
    )
