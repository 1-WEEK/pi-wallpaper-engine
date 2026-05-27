import { Context, Effect, Fiber, Layer, Ref } from "effect"
import { resolve } from "node:path"
import { MigrateError, StorageError } from "@pwe/shared"
import { copyTree, estimateSize, removeTree, verifyTree } from "@pwe/migrate"
import { Config } from "./Config.js"
import { Logger } from "./Logger.js"
import { Mpv } from "./Mpv.js"
import { Storage, friendlyStorageError, isPathInsideRoot } from "./Storage.js"

export interface MigrationProgress {
  readonly state: "running" | "done" | "failed"
  readonly moved_bytes: number
  readonly total_bytes: number
  readonly error: string | null
}

export interface MigrateImpl {
  /** Begin migrating media to `targetRoot`. Returns once the background job is forked. */
  readonly start: (targetRoot: string) => Effect.Effect<MigrationProgress, MigrateError | StorageError>
  readonly status: () => Effect.Effect<MigrationProgress | null>
  readonly cancel: () => Effect.Effect<MigrationProgress | null>
  readonly isRunning: () => Effect.Effect<boolean>
}

export class Migrate extends Context.Tag("Migrate")<Migrate, MigrateImpl>() {}

const formatGb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`

const toMigrateError = (cause: unknown): MigrateError => {
  if (cause instanceof MigrateError) return cause
  const code = (cause as { code?: string }).code
  const message = cause instanceof Error ? cause.message : String(cause)
  if (code === "Copy" || code === "Verify" || code === "Cancelled") {
    return new MigrateError({ kind: code, message, cause })
  }
  return new MigrateError({ kind: "Copy", message, cause })
}

export const friendlyMigrateError = (error: MigrateError): string => {
  switch (error.kind) {
    case "Busy":
    case "Space":
      return error.message
    case "Copy":
      return "Migration failed. Please retry."
    case "Verify":
      return "Migration verification failed. Files may not have been fully copied. Please retry."
    case "Cancelled":
      return "Migration cancelled."
  }
}

export const MigrateLive = Layer.effect(
  Migrate,
  Effect.gen(function* () {
    const config = yield* Config
    const logger = yield* Logger
    const mpv = yield* Mpv
    const storage = yield* Storage

    const jobRef = yield* Ref.make<MigrationProgress | null>(null)
    const fiberRef = yield* Ref.make<Fiber.RuntimeFiber<void, never> | null>(null)

    const isRunning = () => Ref.get(jobRef).pipe(Effect.map((job) => job?.state === "running"))

    const availableBytes = (dir: string) =>
      Effect.tryPromise({
        try: async () => {
          const proc = Bun.spawn(["df", "-B1", "--output=avail", dir], {
            stdout: "pipe",
            stderr: "ignore",
            stdin: "ignore",
          })
          const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
          if (code !== 0) return 0
          const lines = out.trim().split("\n")
          const last = lines[lines.length - 1]?.trim() ?? "0"
          const parsed = Number(last)
          return Number.isFinite(parsed) ? parsed : 0
        },
        catch: (cause) =>
          new MigrateError({ kind: "Space", message: "Failed to check free space.", cause }),
      })

    const start = (targetRoot: string) =>
      Effect.gen(function* () {
        if (yield* isRunning()) {
          return yield* Effect.fail(
            new MigrateError({ kind: "Busy", message: "A migration is already in progress. Please wait." })
          )
        }

        const fromRoot = yield* storage.mediaRoot()
        const toRoot = targetRoot

        const player = yield* mpv.status()
        if (player.path && isPathInsideRoot(player.path, fromRoot)) {
          return yield* Effect.fail(
            new MigrateError({ kind: "Busy", message: "Please stop playback before switching roots." })
          )
        }

        const subdirs = [config.paths.source_dir, config.paths.optimized_dir]
        const sized = yield* Effect.forEach(subdirs, (sub) =>
          Effect.promise(() => estimateSize(resolve(fromRoot, sub))).pipe(
            Effect.map((bytes) => ({
              bytes,
              from: resolve(fromRoot, sub),
              to: resolve(toRoot, sub),
            }))
          )
        )
        const totalBytes = sized.reduce((sum, entry) => sum + entry.bytes, 0)

        const avail = yield* availableBytes(toRoot)
        if (avail < totalBytes) {
          return yield* Effect.fail(
            new MigrateError({
              kind: "Space",
              message: `Not enough space for migration (needs ${formatGb(totalBytes)}, available ${formatGb(avail)}).`,
            })
          )
        }

        const initial: MigrationProgress = {
          state: "running",
          moved_bytes: 0,
          total_bytes: totalBytes,
          error: null,
        }
        yield* Ref.set(jobRef, initial)

        const job = Effect.gen(function* () {
          let movedBase = 0
          for (const { bytes, from, to } of sized) {
            yield* Effect.tryPromise({
              try: (signal) =>
                copyTree({
                  from,
                  to,
                  signal,
                  onProgress: (moved) => {
                    Effect.runSync(
                      Ref.set(jobRef, {
                        state: "running",
                        moved_bytes: movedBase + moved,
                        total_bytes: totalBytes,
                        error: null,
                      })
                    )
                  },
                }),
              catch: toMigrateError,
            })
            movedBase += bytes
            yield* Ref.set(jobRef, {
              state: "running",
              moved_bytes: movedBase,
              total_bytes: totalBytes,
              error: null,
            })
          }

          for (const { from, to } of sized) {
            yield* Effect.tryPromise({
              try: () => verifyTree({ from, to }),
              catch: toMigrateError,
            })
          }

          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              yield* storage.saveRoot(toRoot)
              for (const { from } of sized) {
                yield* Effect.tryPromise({
                  try: () => removeTree(from),
                  catch: toMigrateError,
                })
              }
            })
          )

          yield* Ref.set(jobRef, {
            state: "done",
            moved_bytes: totalBytes,
            total_bytes: totalBytes,
            error: null,
          })
          yield* logger.info(`Storage migration complete: ${fromRoot} -> ${toRoot}`)
        }).pipe(
          Effect.catchAll((error) =>
            Effect.gen(function* () {
              const message =
                error instanceof MigrateError
                  ? friendlyMigrateError(error)
                  : friendlyStorageError(error)
              yield* logger.warn(
                `Storage migration failed: ${error instanceof Error ? error.message : String(error)}`
              )
              yield* Ref.set(jobRef, {
                state: "failed",
                moved_bytes: 0,
                total_bytes: totalBytes,
                error: message,
              })
            })
          ),
          Effect.onInterrupt(() => Ref.set(jobRef, null))
        )

        const fiber = yield* Effect.forkDaemon(job)
        yield* Ref.set(fiberRef, fiber)
        return initial
      })

    const cancel = () =>
      Effect.gen(function* () {
        const fiber = yield* Ref.get(fiberRef)
        if (fiber) {
          yield* Fiber.interrupt(fiber)
          yield* Ref.set(fiberRef, null)
        }
        yield* Ref.set(jobRef, null)
        return yield* Ref.get(jobRef)
      })

    return {
      start,
      status: () => Ref.get(jobRef),
      cancel,
      isRunning,
    }
  })
)
