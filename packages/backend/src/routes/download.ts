import { Elysia } from "elysia"
import { Effect, PubSub, Stream } from "effect"
import { resolve } from "node:path"
import { statSync } from "node:fs"
import { rm } from "node:fs/promises"
import { Config } from "../services/Config.js"
import { Db } from "../services/Db.js"
import { DownloadTasks } from "../services/DownloadTasks.js"
import { Library } from "../services/Library.js"
import { Logger } from "../services/Logger.js"
import { SteamCmd, type DownloadProgress } from "../services/SteamCmd.js"
import { SteamWorkshop } from "../services/SteamWorkshop.js"
import { TranscodeQueue } from "../services/TranscodeQueue.js"
import { decideTranscode } from "../transcode/decide.js"
import { ffprobe } from "../transcode/ffprobe.js"
import { resolveWallpaperFiles, toRelative } from "../services/WallpaperFile.js"
import type { AppRuntime } from "../runtime.js"

const WE_APPID = "431960"

type ProgressEvent =
  | DownloadProgress
  | { readonly workshopId: string; readonly stage: "error"; readonly message: string }
  | { readonly workshopId: string; readonly stage: "complete"; readonly message: string }

export const downloadRoutes = (runtime: AppRuntime) => {
  const wsPubsubPromise = runtime.runPromise(PubSub.unbounded<ProgressEvent>())

  return new Elysia({ prefix: "/api/download" })
    .post("/:workshopId", async ({ params, set }) => {
      const pubsub = await wsPubsubPromise
      const workshopId = params.workshopId

      // Idempotency: reject if a task for this workshopId is already in flight.
      // Without this guard, a double-click or retry spawns a second SteamCMD
      // racing the first against the same source dir.
      const existing = await runtime.runPromise(
        Effect.gen(function* () {
          const tasks = yield* DownloadTasks
          return yield* tasks.get(workshopId)
        })
      )
      if (existing && existing.finished_at === null) {
        set.status = 409
        return {
          ok: false,
          error: "Download already in progress",
          workshopId,
          stage: existing.stage,
        }
      }

      const workflow = Effect.gen(function* () {
        const config = yield* Config
        const db = yield* Db
        const ws = yield* SteamWorkshop
        const steam = yield* SteamCmd
        const lib = yield* Library
        const queue = yield* TranscodeQueue
        const logger = yield* Logger
        const tasks = yield* DownloadTasks

        yield* logger.info(`Download requested: ${workshopId}`)
        yield* tasks.upsert(workshopId, {
          stage: "starting",
          message: "Queued",
          started_at: Date.now(),
          finished_at: null,
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
        yield* tasks.upsert(workshopId, {
          title: item.title ?? workshopId,
          preview_url: item.preview_url ?? "",
        })

        yield* logger.info(`[trace] spawning SteamCMD...`)
        const download = yield* steam.download(workshopId, (p) => {
          Effect.runFork(pubsub.publish(p))
          // Mirror SteamCMD progress into the task store so the Downloads page
          // can observe it without subscribing to per-item WS streams.
          Effect.runSync(
            tasks.upsert(workshopId, {
              stage: p.stage,
              message: p.message ?? "",
              percent: p.percent ?? null,
              bytes_done: p.bytes_done ?? null,
              bytes_total: p.bytes_total ?? null,
            })
          )
        })
        yield* logger.info(`[trace] SteamCMD finished: ${download.localPath}`)

        const itemDir = download.localPath
        const files = yield* resolveWallpaperFiles(itemDir, workshopId)

        const probe = yield* ffprobe(files.videoAbs).pipe(
          Effect.catchTag("FfprobeError", (e) =>
            Effect.gen(function* () {
              yield* logger.warn(`ffprobe failed: ${e.reason}`)
              const size = (() => {
                try {
                  return statSync(files.videoAbs).size
                } catch {
                  return 0
                }
              })()
              return {
                width: 0,
                height: 0,
                codec: "unknown",
                duration_seconds: 0,
                size_bytes: size,
              }
            })
          )
        )

        const sourceRel = toRelative(config.paths.data_root, files.videoAbs)
        const decision = decideTranscode(probe, config.screen, config.transcode.target_codec)

        // Finalize: library row + transcode enqueue + task completion all
        // commit together. If the process dies inside this block, ROLLBACK
        // keeps the library free of half-written rows and the task row stays
        // in-flight — startup reconcile will catch it on next boot.
        yield* db.transaction(() =>
          Effect.gen(function* () {
            yield* lib.insert({
              workshop_id: workshopId,
              title: item.title ?? workshopId,
              author: item.creator ?? "",
              preview_url: item.preview_url ?? "",
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

            yield* tasks.upsert(workshopId, {
              stage: "complete",
              message: "Library updated",
              finished_at: Date.now(),
            })
          })
        )
        yield* pubsub.publish({ workshopId, stage: "complete", message: "Library updated" })
        return { ok: true, workshopId }
      })

      // Long-running download — run as a forked fiber. Respond 202 immediately
      // so the client doesn't time out. Final success/failure is broadcast via
      // the WS /api/download/progress/:workshopId endpoint.

      const markError = (message: string) =>
        Effect.gen(function* () {
          const tasks = yield* DownloadTasks
          yield* tasks.upsert(workshopId, {
            stage: "error",
            message,
            finished_at: Date.now(),
          })
        })

      // Wipe source/<id>/ whenever the workflow errored before the DB row was
      // committed. Guards against half-downloads, non-video fail-fast, SteamCMD
      // auth/timeout failures, ffprobe crashes, etc. Skips deletion if a prior
      // successful download is already in the library for this id.
      const cleanupOrphan = Effect.gen(function* () {
        const config = yield* Config
        const lib = yield* Library
        const logger = yield* Logger
        const existing = yield* lib
          .get(workshopId)
          .pipe(Effect.catchTag("LibraryNotFoundError", () => Effect.succeed(null)))
        if (existing) return
        const sourceDir = resolve(
          config.paths.data_root,
          config.paths.source_dir,
          workshopId
        )
        yield* Effect.tryPromise({
          try: () => rm(sourceDir, { recursive: true, force: true }),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        }).pipe(
          Effect.tap(() => logger.info(`Cleaned orphan source dir: ${sourceDir}`)),
          Effect.catchAll((e) => logger.warn(`Cleanup failed for ${sourceDir}: ${e.message}`))
        )
      })

      const handleFailure = async (err: unknown) => {
        const tag = (err as { _tag?: string })._tag
        let message = err instanceof Error ? err.message : String(err)

        if (tag === "NotVideoWallpaper" || tag === "NotVideoWallpaperError") {
          const actualType = (err as { actualType?: string }).actualType ?? "unknown"
          message = `Cannot use this wallpaper — type "${actualType}". Only Video wallpapers play on the Pi. Try a different item.`
        }
        console.error(`Download ${workshopId} failed (${tag ?? "unknown"}): ${message}`)
        runtime.runFork(pubsub.publish({ workshopId, stage: "error", message }))
        runtime.runFork(markError(message))
        runtime.runFork(cleanupOrphan)
      }

      runtime
        .runPromise(workflow)
        .then(() => {
          // success path already publishes "complete" inside the workflow
        })
        .catch(handleFailure)

      set.status = 202
      return { ok: true, workshopId, status: "started" }
    })

    .get("/tasks", () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const tasks = yield* DownloadTasks
          return yield* tasks.list()
        })
      )
    )

    .delete("/tasks/:workshopId", ({ params }) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const tasks = yield* DownloadTasks
          yield* tasks.dismiss(params.workshopId)
          return { ok: true }
        })
      )
    )

    .ws("/progress/:workshopId", {
      open: async (ws) => {
        const pubsub = await wsPubsubPromise
        const workshopId = (ws.data.params as { workshopId: string }).workshopId
        const stream = Stream.fromPubSub(pubsub).pipe(
          Stream.filter((e) => e.workshopId === workshopId)
        )
        const fiber = runtime.runFork(
          stream.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                try {
                  ws.send(JSON.stringify(event))
                } catch {
                  // ignore send-after-close
                }
              })
            )
          )
        )
        ;(ws.data as Record<string, unknown>)["fiber"] = fiber
      },
      close: (ws) => {
        const fiber = (ws.data as Record<string, unknown>)["fiber"] as
          | ReturnType<AppRuntime["runFork"]>
          | undefined
        if (fiber) {
          runtime.runFork(fiber.interruptAsFork(fiber.id()))
        }
      },
    })
}
