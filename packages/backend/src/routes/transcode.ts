import { Elysia, t } from "elysia"
import { Effect, Schema } from "effect"
import { createWriteStream } from "node:fs"
import { mkdir, rename, stat, unlink } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { ClaimRequest, FailReport, ProgressReport, StorageError } from "@pwe/shared"
import { Config } from "../services/Config.js"
import { Db } from "../services/Db.js"
import { Library } from "../services/Library.js"
import { Migrate } from "../services/Migrate.js"
import { Storage, isPathInsideRoot } from "../services/Storage.js"
import { TranscodeQueue } from "../services/TranscodeQueue.js"
import { workerGuard } from "../middleware/workerGuard.js"
import type { AppRuntime } from "../runtime.js"

// Body shape for /fail / /progress / /claim. Elysia's `t.*`
// gives us runtime body validation; we re-validate via Effect Schema where
// it matters since the shared package is the source of truth.
const ClaimBody = t.Object({ worker: t.String({ minLength: 1 }) })
const ProgressBody = t.Object({ progress: t.Number({ minimum: 0, maximum: 100 }) })
const FailBody = t.Object({ error: t.String({ minLength: 1, maxLength: 4000 }) })

const decodeProgress = Schema.decodeUnknown(ProgressReport)
const decodeFail = Schema.decodeUnknown(FailReport)
const decodeClaim = Schema.decodeUnknown(ClaimRequest)

class WorkerFileError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "WorkerFileError"
    this.status = status
  }
}

const failFile = (status: number, message: string) => Effect.fail(new WorkerFileError(status, message))

const mapRouteError = (set: { status?: number | string }, e: unknown) => {
  if (e instanceof WorkerFileError) {
    set.status = e.status
    return { ok: false, error: e.message }
  }
  if (e instanceof StorageError) {
    set.status = e.kind === "Disconnected" ? 503 : 400
    return { ok: false, error: e.message }
  }
  set.status = 500
  return { ok: false, error: e instanceof Error ? e.message : String(e) }
}

const parseDurationHeader = (request: Request): number => {
  const raw = request.headers.get("x-transcode-duration-ms")
  if (!raw) return 0
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0
}

const jobRow = (jobId: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const row = yield* db.queryOne<{ workshop_id: string }>(
      `SELECT workshop_id
       FROM transcode_jobs
       WHERE id = ? AND status IN ('claimed','running','uploading')`,
      [jobId]
    )
    if (!row) {
      return yield* failFile(404, "Job not found or no longer owned by worker.")
    }
    return row
  })

const sourceFile = (jobId: string) =>
  Effect.gen(function* () {
    const row = yield* jobRow(jobId)
    const library = yield* Library
    const storage = yield* Storage
    const dataRoot = yield* storage.mediaRoot()
    const lib = yield* library
      .get(row.workshop_id)
      .pipe(Effect.catchAll(() => failFile(404, "Library item not found for job.")))
    const sourceAbs = resolve(dataRoot, lib.source_path)
    if (!isPathInsideRoot(sourceAbs, dataRoot)) {
      return yield* failFile(400, "Source path escapes the current media root.")
    }
    const size = yield* Effect.tryPromise({
      try: () => stat(sourceAbs),
      catch: (cause) =>
        new WorkerFileError(
          404,
          `Source file is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`
        ),
    })
    if (!size.isFile()) {
      return yield* failFile(404, "Source path is not a file.")
    }
    return { path: sourceAbs, size: size.size }
  })

const artifactTarget = (jobId: string) =>
  Effect.gen(function* () {
    const row = yield* jobRow(jobId)
    const queue = yield* TranscodeQueue
    const marked = yield* queue.uploading(jobId)
    if (!marked) {
      return yield* failFile(404, "Job not found or no longer owned by worker.")
    }

    const config = yield* Config
    const storage = yield* Storage
    const dataRoot = yield* storage.mediaRoot()
    const outputRelativePath = `${config.paths.optimized_dir}/${row.workshop_id}.mp4`
    const finalAbs = resolve(dataRoot, outputRelativePath)
    if (!isPathInsideRoot(finalAbs, dataRoot)) {
      return yield* failFile(400, "Artifact path escapes the current media root.")
    }

    return {
      finalAbs,
      partialAbs: `${finalAbs}.partial.${jobId}`,
      outputRelativePath,
      targetResolution: `${config.screen.width}x${config.screen.height}`,
      targetCodec: config.transcode.target_codec,
    }
  })

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
              const migrate = yield* Migrate
              if (yield* migrate.isRunning()) {
                set.status = 204
                return null
              }
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

    .get("/:jobId/source", ({ params, set }) =>
      runtime
        .runPromise(sourceFile(params.jobId))
        .then((file) => {
          set.headers["content-type"] = "application/octet-stream"
          set.headers["content-length"] = String(file.size)
          return Bun.file(file.path)
        })
        .catch((e) => mapRouteError(set, e))
    )

    .put("/:jobId/artifact", ({ params, request, set }) => {
      const body = request.body
      if (!body) {
        set.status = 400
        return { ok: false, error: "Artifact body is required." }
      }
      const durationMs = parseDurationHeader(request)
      return runtime
        .runPromise(
          Effect.gen(function* () {
            const target = yield* artifactTarget(params.jobId)
            const outputSize = yield* Effect.tryPromise({
              try: async () => {
                await mkdir(dirname(target.finalAbs), { recursive: true })
                await unlink(target.partialAbs).catch(() => {})
                try {
                  await pipeline(
                    Readable.fromWeb(body as unknown as Parameters<typeof Readable.fromWeb>[0]),
                    createWriteStream(target.partialAbs)
                  )
                  const st = await stat(target.partialAbs)
                  if (st.size <= 0) {
                    throw new Error("Uploaded artifact is empty.")
                  }
                  await rename(target.partialAbs, target.finalAbs)
                  return st.size
                } catch (cause) {
                  await unlink(target.partialAbs).catch(() => {})
                  throw cause
                }
              },
              catch: (cause) =>
                new WorkerFileError(
                  500,
                  `Failed to store artifact: ${cause instanceof Error ? cause.message : String(cause)}`
                ),
            })

            const queue = yield* TranscodeQueue
            yield* queue.complete(
              params.jobId,
              {
                output_relative_path: target.outputRelativePath,
                output_size: outputSize,
                duration_ms: durationMs,
              },
              target.targetResolution,
              target.targetCodec
            )
            return { ok: true, output_size: outputSize }
          })
        )
        .catch((e) => mapRouteError(set, e))
    })

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
