import { Context, Effect, Fiber, Layer, Ref } from "effect"
import { resolve } from "node:path"
import { MigrateError, StorageError } from "@pwe/shared"
import { copyTree, estimateSize, removeTree, verifyTree } from "@pwe/migrate"
import { Config } from "./Config.js"
import { Logger } from "./Logger.js"
import { Mpv } from "./Mpv.js"
import { Storage, friendlyStorageError, isPathInsideRoot } from "./Storage.js"

export interface MigrationProgress {
  readonly direction: "to_nas" | "to_local"
  readonly state: "running" | "done" | "failed"
  readonly moved_bytes: number
  readonly total_bytes: number
  readonly error: string | null
}

export interface MigrateImpl {
  /** Begin migrating media to the storage `targetMode` uses. Returns once the
   *  background job is forked; progress is tracked via status. */
  readonly start: (
    targetMode: "local" | "mounted_share"
  ) => Effect.Effect<MigrationProgress, MigrateError | StorageError>
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
      return "迁移文件时出错,请重试。"
    case "Verify":
      return "迁移校验未通过,文件可能未完整复制,请重试。"
    case "Cancelled":
      return "迁移已取消。"
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

    const start = (targetMode: "local" | "mounted_share") =>
      Effect.gen(function* () {
        if (yield* isRunning()) {
          return yield* Effect.fail(
            new MigrateError({ kind: "Busy", message: "已有迁移正在进行,请稍候。" })
          )
        }

        const current = (yield* storage.status()).mode
        const direction = current === "local" ? ("to_nas" as const) : ("to_local" as const)
        const fromRoot = storage.mediaRootFor(current)
        const toRoot = storage.mediaRootFor(targetMode)

        // Both directions need the SMB share mounted (copy into or out of it).
        yield* storage.connect()

        const player = yield* mpv.status()
        if (player.path && isPathInsideRoot(player.path, fromRoot)) {
          return yield* Effect.fail(
            new MigrateError({ kind: "Busy", message: "请先停止播放,再切换存储。" })
          )
        }

        const subdirs = [config.paths.source_dir, config.paths.optimized_dir]
        const sized = yield* Effect.forEach(subdirs, (sub) =>
          Effect.promise(() => estimateSize(resolve(fromRoot, sub))).pipe(
            Effect.map((bytes) => ({
              sub,
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
              message: `目标空间不足,无法迁移(需 ${formatGb(totalBytes)},可用 ${formatGb(avail)})。`,
            })
          )
        }

        const initial: MigrationProgress = {
          direction,
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
                        direction,
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
              direction,
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

          // Commit only after every directory has copied and verified. Persist
          // the target mode before deleting the old source so a config write
          // failure cannot leave mode pointing at a root whose files were already
          // removed. For NAS→local, finishMigration intentionally keeps the NAS
          // mount alive until the remote source tree is cleaned up.
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              yield* storage.finishMigration(targetMode)
              for (const { from } of sized) {
                yield* Effect.tryPromise({
                  try: () => removeTree(from),
                  catch: toMigrateError,
                })
              }
              if (targetMode === "local") {
                yield* storage.applyMode("local")
              }
            })
          )

          yield* Ref.set(jobRef, {
            direction,
            state: "done",
            moved_bytes: totalBytes,
            total_bytes: totalBytes,
            error: null,
          })
          yield* logger.info(`Storage migration ${direction} complete`)
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
                direction,
                state: "failed",
                moved_bytes: 0,
                total_bytes: totalBytes,
                error: message,
              })
            })
          ),
          // Cancellation interrupts the fiber before the commit phase: drop the
          // job, leaving the source intact. The final delete + mode switch is
          // intentionally uninterruptible.
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
