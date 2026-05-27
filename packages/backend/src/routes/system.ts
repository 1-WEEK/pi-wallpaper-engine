import { Elysia } from "elysia"
import { Effect } from "effect"
import { statfs } from "node:fs/promises"
import { Config } from "../services/Config.js"
import { Display } from "../services/Display.js"
import { DownloadTasks } from "../services/DownloadTasks.js"
import { Library } from "../services/Library.js"
import { Mpv } from "../services/Mpv.js"
import { Storage } from "../services/Storage.js"
import type { AppRuntime } from "../runtime.js"

const maskSecret = (value: string): string =>
  value.length <= 4 ? "••••" : `•••• ${value.slice(-4)}`

const storageSummary = (path: string) =>
  Effect.tryPromise({
    try: () => statfs(path),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(
    Effect.map((fs) => {
      const total = fs.blocks * fs.bsize
      const free = fs.bavail * fs.bsize
      const used = Math.max(0, total - free)
      return {
        available: true as const,
        path,
        used_bytes: used,
        free_bytes: free,
        total_bytes: total,
        used_percent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
        error: null,
      }
    }),
    Effect.catchAll((error) =>
      Effect.succeed({
        available: false as const,
        path,
        used_bytes: null,
        free_bytes: null,
        total_bytes: null,
        used_percent: null,
        error: error.message,
      })
    )
  )

const isFinishedTask = (stage: string, finishedAt: number | null): boolean =>
  stage === "complete" || stage === "error" || finishedAt !== null

export const systemRoutes = (runtime: AppRuntime) =>
  new Elysia({ prefix: "/api/system" }).get("/summary", ({ set }) =>
    runtime
      .runPromise(
        Effect.gen(function* () {
          const config = yield* Config
          const display = yield* Display
          const tasks = yield* DownloadTasks
          const library = yield* Library
          const mpv = yield* Mpv
          const storageService = yield* Storage

          const [player, libraryRows, taskRows, displayStatus, storageStatus] = yield* Effect.all([
            mpv.status(),
            library.list(),
            tasks.list(),
            display.status().pipe(
              Effect.map((status) => ({
                configured: config.display !== undefined,
                state: status.state,
                source: status.source,
                error_kind: null,
              })),
              Effect.catchTag("DisplayError", (error) =>
                Effect.succeed({
                  configured: config.display !== undefined,
                  state: "unknown" as const,
                  source: "default" as const,
                  error_kind: error.kind,
                })
              )
            ),
            storageService.status(),
          ] as const)

          const storage = yield* storageSummary(storageStatus.data_root).pipe(
            Effect.map((usage) => ({
              ...usage,
              available: storageStatus.available && usage.available,
              used_bytes: storageStatus.available ? usage.used_bytes : null,
              free_bytes: storageStatus.available ? usage.free_bytes : null,
              total_bytes: storageStatus.available ? usage.total_bytes : null,
              used_percent: storageStatus.available ? usage.used_percent : null,
              error: storageStatus.available ? usage.error : (storageStatus.last_error ?? usage.error),
              data_root: storageStatus.data_root,
              default_root: storageStatus.default_root,
              using_default: storageStatus.using_default,
              last_error: storageStatus.last_error,
            }))
          )

          const currentItem = player.current_workshop_id
            ? yield* library
                .get(player.current_workshop_id)
                .pipe(Effect.catchTag("LibraryNotFoundError", () => Effect.succeed(null)))
            : null

          const activeDownloads = taskRows.filter(
            (task) => !isFinishedTask(task.stage, task.finished_at)
          ).length

          return {
            config: {
              steam: {
                username: config.steam.username,
                web_api_key_masked: maskSecret(config.steam.web_api_key),
                steamcmd_path: config.steam.steamcmd_path,
              },
              paths: config.paths,
              screen: config.screen,
              mpv: config.mpv,
              server: config.server,
            },
            status: {
              player: {
                ...player,
                current_title: currentItem?.title ?? null,
                current_preview_url: currentItem?.preview_url || null,
                current_resolution:
                  currentItem?.transcoded_resolution ?? currentItem?.source_resolution ?? null,
                current_codec: currentItem?.transcoded_codec ?? currentItem?.source_codec ?? null,
              },
              display: displayStatus,
              storage,
              library: {
                total: libraryRows.length,
              },
              downloads: {
                active: activeDownloads,
                finished: taskRows.length - activeDownloads,
              },
            },
          }
        })
      )
      .catch((error) => {
        set.status = 500
        return { error: error instanceof Error ? error.message : String(error) }
      })
  )
