import { Cause, Context, Effect, Exit, Fiber, Layer, Option, PubSub, Stream } from "effect"
import { rm } from "node:fs/promises"
import { resolve } from "node:path"
import { randomUUID } from "node:crypto"
import {
  FfprobeError,
  hasAdultTitleHint,
  type TaskStage,
  type VideoProbe,
} from "@pwe/shared"
import { decideTranscode } from "../transcode/decide.js"
import { ffprobe } from "../transcode/ffprobe.js"
import { Config } from "./Config.js"
import { Db } from "./Db.js"
import { DownloadProcessRegistry } from "./DownloadProcessRegistry.js"
import { Tasks } from "./Tasks.js"
import { Library } from "./Library.js"
import { Logger } from "./Logger.js"
import { Migrate } from "./Migrate.js"
import { Storage } from "./Storage.js"
import { SteamCmd, type DownloadProgress } from "./SteamCmd.js"
import { SteamWorkshop } from "./SteamWorkshop.js"
import { TranscodeQueue } from "./TranscodeQueue.js"
import { resolveWallpaperFiles, toRelative } from "./WallpaperFile.js"

export type DownloadProgressEvent =
  | DownloadProgress
  | { readonly workshopId: string; readonly stage: "error"; readonly message: string }
  | { readonly workshopId: string; readonly stage: "complete"; readonly message: string }

export type DownloadStartResult =
  | { readonly _tag: "Started"; readonly workshopId: string }
  | { readonly _tag: "AlreadyRunning"; readonly workshopId: string; readonly stage: TaskStage }
  | { readonly _tag: "StorageUnavailable"; readonly workshopId: string; readonly message: string }
  | { readonly _tag: "MigrationRunning"; readonly workshopId: string; readonly message: string }

export type DownloadCancelResult =
  | { readonly _tag: "Cancelling"; readonly workshopId: string }
  | { readonly _tag: "CancelledZombie"; readonly workshopId: string }
  | { readonly _tag: "NotFound"; readonly workshopId: string; readonly message: string }

export interface DownloadIntakeImpl {
  readonly start: (workshopId: string) => Effect.Effect<DownloadStartResult>
  readonly cancel: (workshopId: string) => Effect.Effect<DownloadCancelResult>
  readonly progressStream: (workshopId: string) => Stream.Stream<DownloadProgressEvent>
}

export class DownloadIntake extends Context.Tag("DownloadIntake")<
  DownloadIntake,
  DownloadIntakeImpl
>() {}

export interface DownloadIntakeDeps {
  readonly probeVideo?: (filePath: string) => Effect.Effect<VideoProbe, FfprobeError>
}

interface CancelledDownload {
  readonly _tag: "Cancelled"
}

// The workshop id and its task row id travel together through the whole
// download workflow (spec 05's data clump).
interface DownloadJob {
  readonly workshopId: string
  readonly taskId: string
}

export const downloadFailureMessage = (err: unknown): string => {
  const tag = (err as { _tag?: string })._tag

  if (tag === "NotVideoWallpaper" || tag === "NotVideoWallpaperError") {
    const actualType = (err as { actualType?: string }).actualType ?? "unknown"
    return `Cannot use this wallpaper — type "${actualType}". Only Video wallpapers play on the Pi. Try a different item.`
  }

  if (tag === "FfprobeError") {
    const path = (err as { path?: string }).path ?? "downloaded file"
    return `Downloaded files are incomplete or unreadable: ${path}. SteamCMD likely stalled before finalizing the wallpaper. Retry the item.`
  }

  if (tag === "Cancelled") return "Cancelled"

  return err instanceof Error ? err.message : String(err)
}

export const makeDownloadIntakeLive = (deps: DownloadIntakeDeps = {}) =>
  Layer.effect(
    DownloadIntake,
    Effect.gen(function* () {
      const config = yield* Config
      const db = yield* Db
      const ws = yield* SteamWorkshop
      const steam = yield* SteamCmd
      const lib = yield* Library
      const queue = yield* TranscodeQueue
      const logger = yield* Logger
      const tasks = yield* Tasks
      const storage = yield* Storage
      const migrate = yield* Migrate
      const processRegistry = yield* DownloadProcessRegistry
      const pubsub = yield* PubSub.unbounded<DownloadProgressEvent>()
      const inflight = new Map<string, Fiber.RuntimeFiber<unknown, unknown>>()
      const probeVideo = deps.probeVideo ?? ffprobe

      const publish = (event: DownloadProgressEvent) => pubsub.publish(event)

      const mirrorProgress = (taskId: string) => (p: DownloadProgress) => {
        Effect.runFork(publish(p))
        Effect.runFork(
          tasks.upsert(taskId, {
            stage: p.stage,
            message: p.message ?? "",
            percent: p.percent ?? null,
            bytes_done: p.bytes_done ?? null,
            bytes_total: p.bytes_total ?? null,
          }).pipe(Effect.ignore)
        )
      }

      const markError = (taskId: string, message: string) =>
        tasks.upsert(taskId, {
          stage: "error",
          message,
          finished_at: Date.now(),
        })

      const cleanupOrphan = (workshopId: string) =>
        Effect.gen(function* () {
          const existing = yield* lib
            .get(workshopId)
            .pipe(
              Effect.as(true),
              Effect.catchTag("LibraryNotFoundError", () => Effect.succeed(false)),
              Effect.catchAll((e) =>
                logger.warn(`Skipping orphan cleanup for ${workshopId}: ${e.message}`).pipe(
                  Effect.as(true)
                )
              )
            )
          if (existing) return

          const dataRoot = yield* storage.mediaRootOrNull()
          if (!dataRoot) return

          const sourceDir = resolve(dataRoot, config.paths.source_dir, workshopId)
          yield* Effect.tryPromise({
            try: () => rm(sourceDir, { recursive: true, force: true }),
            catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
          }).pipe(
            Effect.tap(() => logger.info(`Cleaned orphan source dir: ${sourceDir}`)),
            Effect.catchAll((e) => logger.warn(`Cleanup failed for ${sourceDir}: ${e.message}`))
          )
        })

      const handleFailure = (job: DownloadJob, err: unknown) =>
        Effect.gen(function* () {
          const { workshopId, taskId } = job
          const tag = (err as { _tag?: string })._tag
          const message = downloadFailureMessage(err)
          yield* logger.error(`Download ${workshopId} failed (${tag ?? "unknown"}): ${message}`)
          // Cleanup must finish before the task turns terminal: once finished_at
          // is set a retry can start, and its fresh download must never race the rm.
          yield* cleanupOrphan(workshopId)
          yield* publish({ workshopId, stage: "error", message })
          yield* markError(taskId, message)
        }).pipe(
          Effect.catchAll((e) =>
            logger.error(`Download failure handling failed for ${job.workshopId}: ${String(e)}`)
          )
        )

      const runWorkflow = (job: DownloadJob) =>
        Effect.gen(function* () {
          const { workshopId, taskId } = job
          const dataRoot = yield* storage.mediaRoot()

          yield* logger.info(`Download requested: ${workshopId} (task: ${taskId})`)
          yield* tasks.upsert(taskId, {
            workshop_id: workshopId,
            stage: "starting",
            message: "Queued",
            started_at: Date.now(),
            finished_at: null,
            percent: null,
            bytes_done: null,
            bytes_total: null,
          })

          yield* logger.info(`[trace] fetching workshop metadata...`)
          const item = yield* ws.getItem(workshopId).pipe(
            Effect.catchTag("WorkshopApiError", (e) =>
              Effect.gen(function* () {
                yield* logger.warn(`Workshop metadata fetch failed: ${e.message}`)
                return {
                  publishedfileid: workshopId,
                  title: workshopId,
                  preview_url: "",
                  creator: "",
                }
              })
            )
          )
          yield* logger.info(`[trace] metadata fetched: title="${item.title}"`)

          const title = item.title ?? workshopId
          yield* tasks.upsert(taskId, {
            title,
            preview_url: item.preview_url ?? "",
            adult_hint: hasAdultTitleHint(title) ? 1 : 0,
          })

          yield* logger.info(`[trace] spawning SteamCMD...`)
          const download = yield* steam.download(workshopId, mirrorProgress(taskId)).pipe(
            Effect.retry({
              times: 2,
              while: (e) => e._tag === "SteamCmdError" && (e.kind === "Timeout" || e.message.includes("failed (Failure)"))
            })
          )
          yield* logger.info(`[trace] SteamCMD finished: ${download.localPath}`)

          yield* tasks.upsert(taskId, {
            stage: "finalizing",
            message: "Validating files…",
          })
          yield* publish({ workshopId, stage: "finalizing", message: "Validating files…" })

          const files = yield* resolveWallpaperFiles(download.localPath, workshopId)
          yield* tasks.upsert(taskId, {
            content_rating: files.contentRating,
            rating_sex: files.ratingSex,
          })

          const probe = yield* probeVideo(files.videoAbs).pipe(
            Effect.tapError((e) => logger.warn(`ffprobe failed: ${e.reason}`))
          )

          const sourceRel = toRelative(dataRoot, files.videoAbs)
          const decision = decideTranscode(probe, config.screen, config.transcode.target_codec)

          yield* db.transaction(() =>
            Effect.gen(function* () {
              yield* lib.insert({
                workshop_id: workshopId,
                title: item.title ?? workshopId,
                author: item.creator ?? "",
                preview_url: item.preview_url ?? "",
                content_rating: files.contentRating,
                rating_sex: files.ratingSex,
                source_path: sourceRel,
                source_resolution: `${probe.width}x${probe.height}`,
                source_codec: probe.codec,
                source_size: probe.size_bytes || download.sizeBytes,
                downloaded_at: Date.now(),
                transcode_status: "skipped",
                transcode_progress: 0,
                transcode_error: null,
                transcoded_path: null,
                transcoded_resolution: null,
                transcoded_codec: null,
                transcoded_size: null,
                display_mode: config.screen.default_display_mode,
                last_played_at: null,
              })

              yield* queue.enqueue(workshopId, decision, sourceRel)

              yield* tasks.upsert(taskId, {
                stage: "complete",
                message: "Library updated",
                finished_at: Date.now(),
              })
            })
          )

          yield* publish({ workshopId, stage: "complete", message: "Library updated" })
        })

      const start = (workshopId: string): Effect.Effect<DownloadStartResult> =>
        Effect.gen(function* () {
          const storageReady = yield* storage.mediaRoot().pipe(
            Effect.map(() => null),
            Effect.catchTag("StorageError", (error) =>
              Effect.succeed({
                _tag: "StorageUnavailable" as const,
                workshopId,
                message: error.message,
              })
            )
          )
          if (storageReady) return storageReady

          const migrating = yield* migrate.isRunning()
          if (migrating) {
            return {
              _tag: "MigrationRunning",
              workshopId,
              message: "Storage migration in progress. Please wait.",
            }
          }

          if (inflight.has(workshopId)) {
            const task = yield* tasks.getActiveByWorkshopId(workshopId)
            return {
              _tag: "AlreadyRunning",
              workshopId,
              stage: task?.stage ?? "starting",
            }
          }

          const existing = yield* tasks.getActiveByWorkshopId(workshopId)
          if (existing) {
            return {
              _tag: "AlreadyRunning",
              workshopId,
              stage: existing.stage,
            }
          }

          const taskId = randomUUID()
          const workflow = runWorkflow({ workshopId, taskId }).pipe(
            Effect.onExit((exit) => {
              if (Exit.isSuccess(exit)) return Effect.void
              if (Cause.isInterruptedOnly(exit.cause)) {
                return handleFailure({ workshopId, taskId }, { _tag: "Cancelled" } satisfies CancelledDownload)
              }

              const failure = Cause.failureOption(exit.cause)
              const err = Option.getOrElse(failure, () => new Error(Cause.pretty(exit.cause)))
              return handleFailure({ workshopId, taskId }, err)
            })
          )

          const fiber = yield* Effect.forkDaemon(workflow)
          yield* Effect.sync(() => {
            inflight.set(workshopId, fiber)
            fiber.addObserver(() => {
              inflight.delete(workshopId)
            })
          })

          return { _tag: "Started", workshopId }
        })

      const cancel = (workshopId: string): Effect.Effect<DownloadCancelResult> =>
        Effect.gen(function* () {
          const fiber = inflight.get(workshopId)
          if (fiber) {
            yield* processRegistry.stop(workshopId)
            yield* Fiber.interrupt(fiber).pipe(Effect.forkDaemon)
            return { _tag: "Cancelling", workshopId }
          }

          const task = yield* tasks.getActiveByWorkshopId(workshopId)
          if (task) {
            const message = "Cancelled (zombie cleanup)"
            yield* processRegistry.stop(workshopId)
            yield* cleanupOrphan(workshopId)
            yield* publish({ workshopId, stage: "error", message })
            yield* markError(task.task_id, message)
            return { _tag: "CancelledZombie", workshopId }
          }

          return {
            _tag: "NotFound",
            workshopId,
            message: "No active download for this workshop id",
          }
        })

      return {
        start,
        cancel,
        progressStream: (workshopId) =>
          Stream.fromPubSub(pubsub).pipe(Stream.filter((event) => event.workshopId === workshopId)),
      }
    })
  )

export const DownloadIntakeLive = makeDownloadIntakeLive()
