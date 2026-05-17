import { Context, Effect, Layer, PubSub, Stream } from "effect"
import { resolve } from "node:path"
import { existsSync } from "node:fs"
import { SteamCmdError } from "@pwe/shared"
import { Config } from "./Config.js"
import { Logger } from "./Logger.js"

const WE_APPID = "431960"
const STALE_OUTPUT_TIMEOUT_MS = 60_000

export interface DownloadProgress {
  readonly workshopId: string
  readonly stage: "starting" | "downloading" | "finalizing" | "done"
  readonly message: string
  // Optional — only present when SteamCMD emits a parseable progress line.
  // Auth, validation, and metadata phases don't produce these.
  readonly percent?: number
  readonly bytes_done?: number
  readonly bytes_total?: number
}

// SteamCMD download progress line, e.g.
//   Update state (0x61) downloading, progress: 12.34 (1234567 / 10000000)
const PROGRESS_RE = /progress:\s*([\d.]+)\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\)/i

const parseProgress = (
  line: string
): { percent: number; bytes_done: number; bytes_total: number } | null => {
  const m = line.match(PROGRESS_RE)
  if (!m) return null
  const percent = parseFloat(m[1] ?? "0")
  const bytes_done = parseInt(m[2] ?? "0", 10)
  const bytes_total = parseInt(m[3] ?? "0", 10)
  if (Number.isNaN(percent) || bytes_total <= 0) return null
  return { percent, bytes_done, bytes_total }
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export interface DownloadResult {
  readonly workshopId: string
  readonly localPath: string
  readonly sizeBytes: number
}

export interface SteamCmdImpl {
  readonly download: (
    workshopId: string,
    onProgress?: (p: DownloadProgress) => void
  ) => Effect.Effect<DownloadResult, SteamCmdError>
  readonly progressStream: (workshopId: string) => Stream.Stream<DownloadProgress>
}

export class SteamCmd extends Context.Tag("SteamCmd")<SteamCmd, SteamCmdImpl>() {}

const classifyError = (output: string, exitCode: number | null): SteamCmdError => {
  if (/ERROR! Failed to install app '431960'/.test(output)) {
    return new SteamCmdError({
      kind: "AuthRequired",
      message: "Steam authentication required. Run `steamcmd +login <username>` in a terminal.",
      exitCode: exitCode ?? undefined,
    })
  }
  if (/Two-factor code/i.test(output) || /Steam Guard/i.test(output)) {
    return new SteamCmdError({
      kind: "AuthRequired",
      message: "Steam Guard 2FA needed. Run `steamcmd +login <username>` interactively.",
      exitCode: exitCode ?? undefined,
    })
  }
  if (/Error! Download item .* failed \(Failure\)/.test(output) || /Failure \(\s*16\s*\)/.test(output)) {
    return new SteamCmdError({
      kind: "NotSubscribed",
      message:
        "Item not accessible. Subscribe to it on Steam Workshop first, then retry the download.",
      exitCode: exitCode ?? undefined,
    })
  }
  if (/Login Failure/i.test(output)) {
    return new SteamCmdError({
      kind: "AuthRequired",
      message: "Steam login failed. Sentry file may be invalid — re-run `steamcmd +login <username>`.",
      exitCode: exitCode ?? undefined,
    })
  }
  return new SteamCmdError({
    kind: "UnknownFailure",
    message: `SteamCMD exited with code ${exitCode}. Last 500 chars of output: ${output.slice(-500)}`,
    exitCode: exitCode ?? undefined,
  })
}

export const SteamCmdLive = Layer.effect(
  SteamCmd,
  Effect.gen(function* () {
    const config = yield* Config
    const logger = yield* Logger
    const pubsub = yield* PubSub.unbounded<DownloadProgress>()

    if (!existsSync(config.steam.steamcmd_path)) {
      yield* logger.warn(`SteamCMD binary not found at ${config.steam.steamcmd_path}`)
    }

    return {
      progressStream: (workshopId) =>
        Stream.fromPubSub(pubsub).pipe(Stream.filter((p) => p.workshopId === workshopId)),

      download: (workshopId, onProgress) =>
        Effect.acquireUseRelease(
          // acquire — spawn process
          Effect.try({
            try: () => {
              const child = Bun.spawn(
                [
                  config.steam.steamcmd_path,
                  "+force_install_dir",
                  resolve(config.paths.data_root, config.paths.source_dir, workshopId),
                  "+login",
                  config.steam.username,
                  "+workshop_download_item",
                  WE_APPID,
                  workshopId,
                  "+quit",
                ],
                {
                  stdout: "pipe",
                  stderr: "pipe",
                  stdin: "ignore",
                }
              )
              return child
            },
            catch: (cause) =>
              new SteamCmdError({
                kind: "BinaryNotFound",
                message: `Failed to spawn SteamCMD: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          }),

          // use — read output, parse progress, await exit
          (child) =>
            Effect.gen(function* () {
              let collected = ""
              let lastOutputAt = Date.now()
              let downloadedPath = ""
              let downloadedSize = 0

              const emit = (p: DownloadProgress) => {
                onProgress?.(p)
                Effect.runFork(pubsub.publish(p))
              }

              emit({
                workshopId,
                stage: "starting",
                message: "Launching SteamCMD",
              })

              const readStream = async (stream: ReadableStream<Uint8Array> | undefined) => {
                if (!stream) return
                const reader = stream.getReader()
                const decoder = new TextDecoder()
                while (true) {
                  const { done, value } = await reader.read()
                  if (done) break
                  const chunk = decoder.decode(value)
                  collected += chunk
                  lastOutputAt = Date.now()

                  for (const line of chunk.split("\n")) {
                    const trimmed = line.trim()
                    if (!trimmed) continue
                    if (/Downloading item/i.test(trimmed) || /Update state/i.test(trimmed)) {
                      const prog = parseProgress(trimmed)
                      if (prog) {
                        emit({
                          workshopId,
                          stage: "downloading",
                          message: `${formatBytes(prog.bytes_done)} / ${formatBytes(prog.bytes_total)}`,
                          percent: prog.percent,
                          bytes_done: prog.bytes_done,
                          bytes_total: prog.bytes_total,
                        })
                      } else {
                        emit({ workshopId, stage: "downloading", message: "Connecting…" })
                      }
                    } else if (/Success\. Downloaded item/i.test(trimmed)) {
                      const m = trimmed.match(/to "([^"]+)"\s*\((\d+) bytes\)/)
                      if (m) {
                        downloadedPath = m[1] ?? ""
                        downloadedSize = parseInt(m[2] ?? "0", 10)
                      }
                      emit({ workshopId, stage: "finalizing", message: "Validating files…" })
                    }
                  }
                }
              }

              // Stall watcher — fail if no output for STALE_OUTPUT_TIMEOUT_MS
              const stallWatcher = Effect.gen(function* () {
                while (true) {
                  yield* Effect.sleep("5 seconds")
                  if (Date.now() - lastOutputAt > STALE_OUTPUT_TIMEOUT_MS) {
                    // Box86 on Pi often stalls after download but before final move.
                    // If we have files in either downloads/ or content/, assume
                    // SteamCMD finished but hung on exit.
                    const contentDir = resolve(
                      config.paths.data_root,
                      config.paths.source_dir,
                      workshopId,
                      "steamapps",
                      "workshop",
                      "content",
                      WE_APPID,
                      workshopId
                    )
                    const downloadsDir = resolve(
                      config.paths.data_root,
                      config.paths.source_dir,
                      workshopId,
                      "steamapps",
                      "workshop",
                      "downloads",
                      WE_APPID,
                      workshopId
                    )

                    if (existsSync(contentDir) || existsSync(downloadsDir)) {
                      yield* logger.warn(
                        `SteamCMD stalled for ${workshopId}, but files found. Proceeding.`
                      )
                      return 0 // Success exit code fake
                    }

                    return yield* Effect.fail(
                      new SteamCmdError({
                        kind: "Timeout",
                        message: `SteamCMD produced no output for ${STALE_OUTPUT_TIMEOUT_MS / 1000}s — likely stuck on Steam Guard prompt.`,
                      })
                    )
                  }
                }
              })

              const runIO = Effect.tryPromise({
                try: async () => {
                  await Promise.all([readStream(child.stdout), readStream(child.stderr)])
                  const code = await child.exited
                  return code
                },
                catch: (cause) =>
                  new SteamCmdError({
                    kind: "UnknownFailure",
                    message: `IO error: ${cause instanceof Error ? cause.message : String(cause)}`,
                  }),
              })

              const exitCode = yield* Effect.race(runIO, stallWatcher)

              if (exitCode !== 0) {
                return yield* Effect.fail(classifyError(collected, exitCode))
              }

              if (!downloadedPath) {
                const contentPath = resolve(
                  config.paths.data_root,
                  config.paths.source_dir,
                  workshopId,
                  "steamapps",
                  "workshop",
                  "content",
                  WE_APPID,
                  workshopId
                )
                const downloadsPath = resolve(
                  config.paths.data_root,
                  config.paths.source_dir,
                  workshopId,
                  "steamapps",
                  "workshop",
                  "downloads",
                  WE_APPID,
                  workshopId
                )

                // Fallback: prefer content/, then downloads/
                if (existsSync(contentPath)) {
                  downloadedPath = contentPath
                } else if (existsSync(downloadsPath)) {
                  downloadedPath = downloadsPath
                } else {
                  downloadedPath = contentPath // Last resort fallback
                }
              }

              const result: DownloadResult = {
                workshopId,
                localPath: downloadedPath,
                sizeBytes: downloadedSize,
              }

              emit({ workshopId, stage: "done", message: `Downloaded ${workshopId}` })
              return result
            }),

          // release — kill if still running
          (child) =>
            Effect.sync(() => {
              try {
                child.kill()
              } catch {
                // ignore
              }
            })
        ),
    }
  })
)
