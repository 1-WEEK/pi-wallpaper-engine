import { Elysia } from "elysia"
import { Cause, Effect, Exit, Fiber, Option, PubSub, Stream } from "effect"
import { hasAdultTitleHint, StorageError } from "@pwe/shared"
import { resolve } from "node:path"
import { rm } from "node:fs/promises"
import { Config } from "../services/Config.js"
import { Db } from "../services/Db.js"
import { DownloadTasks } from "../services/DownloadTasks.js"
import { Library } from "../services/Library.js"
import { Logger } from "../services/Logger.js"
import { Migrate } from "../services/Migrate.js"
import { Storage } from "../services/Storage.js"
import { SteamCmd, type DownloadProgress } from "../services/SteamCmd.js"
import { SteamWorkshop } from "../services/SteamWorkshop.js"
import { TranscodeQueue } from "../services/TranscodeQueue.js"
import { decideTranscode } from "../transcode/decide.js"
import { ffprobe } from "../transcode/ffprobe.js"
import { resolveWallpaperFiles, toRelative } from "../services/WallpaperFile.js"
import type { AppRuntime } from "../runtime.js"
import type { AuthService } from "../services/Auth.js"

const WE_APPID = "431960"

type ProgressEvent =
  | DownloadProgress
  | { readonly workshopId: string; readonly stage: "error"; readonly message: string }
  | { readonly workshopId: string; readonly stage: "complete"; readonly message: string }

export const downloadRoutes = (runtime: AppRuntime, auth: AuthService | null = null) => {
  const wsPubsubPromise = runtime.runPromise(PubSub.unbounded<ProgressEvent>())

  // Tracks the workflow fiber for each in-flight download so cancel can
  // interrupt it. The fiber's acquireUseRelease release block kills the
  // SteamCMD child; the workflow's failure path runs markError + cleanupOrphan
  // the same way it does for ordinary failures.
  const inflight = new Map<string, Fiber.RuntimeFiber<unknown, unknown>>()

  return new Elysia({ prefix: "/api/download" })
    .post("/:workshopId", async ({ params, set }) => {
      const pubsub = await wsPubsubPromise
      const workshopId = params.workshopId

      const storageReady = await runtime.runPromise(
        Effect.gen(function* () {
          const storage = yield* Storage
          return yield* storage.mediaRoot()
        })
      ).catch((error) => error)

      if (storageReady instanceof StorageError) {
        set.status = 503
        return { ok: false, error: storageReady.message }
      }

      // Block new downloads while a storage migration is moving media files —
      // a concurrent write into source/ would be missed by the migration.
      const migrating = await runtime.runPromise(
        Effect.gen(function* () {
          const migrate = yield* Migrate
          return yield* migrate.isRunning()
        })
      )
      if (migrating) {
        set.status = 503
        return { ok: false, error: "Storage migration in progress. Please wait." }
      }

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
        const storage = yield* Storage
        const dataRoot = yield* storage.mediaRoot()

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
        const title = item.title ?? workshopId
        yield* tasks.upsert(workshopId, {
          title,
          preview_url: item.preview_url ?? "",
          adult_hint: hasAdultTitleHint(title) ? 1 : 0,
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
        yield* tasks.upsert(workshopId, {
          content_rating: files.contentRating,
          rating_sex: files.ratingSex,
        })

        const probe = yield* ffprobe(files.videoAbs).pipe(
          Effect.tapError((e) => logger.warn(`ffprobe failed: ${e.reason}`))
        )

        const sourceRel = toRelative(dataRoot, files.videoAbs)
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
        const storage = yield* Storage
        const existing = yield* lib
          .get(workshopId)
          .pipe(Effect.catchTag("LibraryNotFoundError", () => Effect.succeed(null)))
        if (existing) return
        const dataRoot = yield* storage.mediaRootOrNull()
        if (!dataRoot) return
        const sourceDir = resolve(
          dataRoot,
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
        if (tag === "FfprobeError") {
          const path = (err as { path?: string }).path ?? "downloaded file"
          message = `Downloaded files are incomplete or unreadable: ${path}. SteamCMD likely stalled before finalizing the wallpaper. Retry the item.`
        }
        if (tag === "Cancelled") {
          message = "Cancelled"
        }
        console.error(`Download ${workshopId} failed (${tag ?? "unknown"}): ${message}`)
        runtime.runFork(pubsub.publish({ workshopId, stage: "error", message }))
        runtime.runFork(markError(message))
        runtime.runFork(cleanupOrphan)
      }

      const fiber = runtime.runFork(workflow)
      inflight.set(workshopId, fiber)
      fiber.addObserver((exit) => {
        inflight.delete(workshopId)
        if (Exit.isSuccess(exit)) return
        // Interrupt-only exit means the fiber was cancelled — route through
        // handleFailure so markError + cleanupOrphan still run, then surface
        // a "Cancelled" message instead of the generic SteamCmd error.
        if (Cause.isInterruptedOnly(exit.cause)) {
          handleFailure({ _tag: "Cancelled" })
          return
        }
        const failure = Cause.failureOption(exit.cause)
        const err = Option.getOrElse(failure, () => new Error(Cause.pretty(exit.cause)))
        handleFailure(err)
      })

      set.status = 202
      return { ok: true, workshopId, status: "started" }
    })

    .post("/:workshopId/cancel", async ({ params, set }) => {
      const fiber = inflight.get(params.workshopId)
      if (fiber) {
        runtime.runFork(Fiber.interrupt(fiber))
        set.status = 202
        return { ok: true, workshopId: params.workshopId, status: "cancelling" }
      }

      // No in-flight fiber — the workflow may have crashed or the backend
      // restarted, leaving a zombie row. Check the DB and mark it cancelled
      // if it is still in a non-terminal state.
      const task = await runtime.runPromise(
        Effect.gen(function* () {
          const tasks = yield* DownloadTasks
          return yield* tasks.get(params.workshopId)
        })
      )
      if (task && task.finished_at === null) {
        await runtime.runPromise(
          Effect.gen(function* () {
            const tasks = yield* DownloadTasks
            yield* tasks.upsert(params.workshopId, {
              stage: "error",
              message: "Cancelled (zombie cleanup)",
              finished_at: Date.now(),
            })
          })
        )
        set.status = 202
        return { ok: true, workshopId: params.workshopId, status: "cancelled" }
      }

      set.status = 404
      return { ok: false, error: "No active download for this workshop id" }
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
        if (auth) {
          const headers = new Headers()
          const cookieHeader = (ws.data as { headers?: Record<string, string | undefined> }).headers
            ?.cookie
          if (cookieHeader) headers.set("cookie", cookieHeader)
          const session = await auth.instance.api
            .getSession({ headers })
            .catch(() => null)
          if (!session) {
            try {
              ws.send(JSON.stringify({ stage: "error", message: "Authentication required" }))
            } catch {
              // ignore
            }
            ws.close()
            return
          }
        }
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
