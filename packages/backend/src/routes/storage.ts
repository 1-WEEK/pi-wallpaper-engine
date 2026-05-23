import { Elysia, t } from "elysia"
import { Effect } from "effect"
import { MigrateError, StorageError } from "@pwe/shared"
import { DownloadTasks } from "../services/DownloadTasks.js"
import { Library } from "../services/Library.js"
import { Migrate, friendlyMigrateError } from "../services/Migrate.js"
import { Storage, friendlyStorageError } from "../services/Storage.js"
import type { AppRuntime } from "../runtime.js"

const updateBody = t.Object({
  mode: t.Union([t.Literal("local"), t.Literal("mounted_share")]),
  smb: t.Union([
    t.Null(),
    t.Object({
      server: t.String(),
      share: t.String(),
      username: t.String(),
      password: t.Optional(t.Nullable(t.String())),
    }),
  ]),
})

const mapError = (set: { status?: number | string }, error: unknown) => {
  if (error instanceof StorageError) {
    set.status =
      error.kind === "Busy"
        ? 409
        : error.kind === "Disconnected"
          ? 503
          : error.kind === "Mount" || error.kind === "Validation"
            ? 502
            : 400
    return { ok: false, error: friendlyStorageError(error), kind: error.kind }
  }
  if (error instanceof MigrateError) {
    set.status = error.kind === "Busy" ? 409 : error.kind === "Space" ? 400 : 500
    return { ok: false, error: friendlyMigrateError(error), kind: error.kind }
  }
  set.status = 500
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

const isFinishedTask = (stage: string, finishedAt: number | null): boolean =>
  stage === "complete" || stage === "error" || finishedAt !== null

// Storage status plus any live migration progress, the shape the UI consumes.
const composedStatus = Effect.gen(function* () {
  const storage = yield* Storage
  const migrate = yield* Migrate
  const state = yield* storage.status()
  const migration = yield* migrate.status()
  return { ...state, migration }
})

export const storageRoutes = (runtime: AppRuntime) =>
  new Elysia({ prefix: "/api/storage" })
    .get("/", ({ set }) =>
      runtime.runPromise(composedStatus).catch((error) => mapError(set, error))
    )
    .put(
      "/",
      ({ body, set }) =>
        runtime
          .runPromise(
            Effect.gen(function* () {
              const storage = yield* Storage
              const migrate = yield* Migrate
              const library = yield* Library
              const tasks = yield* DownloadTasks

              const current = (yield* storage.status()).mode
              const mutatesActiveRoot =
                body.mode !== current || (body.smb !== null && current === "mounted_share")
              if (mutatesActiveRoot) {
                const activeDownloads = (yield* tasks.list()).filter(
                  (task) => !isFinishedTask(task.stage, task.finished_at)
                )
                if (activeDownloads.length > 0) {
                  return yield* Effect.fail(
                    new MigrateError({
                      kind: "Busy",
                      message: "有下载正在进行,请等待完成后再切换存储。",
                    })
                  )
                }
              }

              if (body.smb) {
                yield* storage.saveSmb(body.smb)
              }

              const libraryRows = yield* library.list()
              // Switching with a populated library moves the media files; this
              // runs as a background job. An empty library (or no mode change)
              // switches instantly.
              const needsMigration = body.mode !== current && libraryRows.length > 0

              if (needsMigration) {
                yield* migrate.start(body.mode)
              } else {
                yield* storage.applyMode(body.mode)
              }

              const status = yield* composedStatus
              return { status, migrating: needsMigration }
            })
          )
          .then(({ status, migrating }) => {
            set.status = migrating ? 202 : 200
            return status
          })
          .catch((error) => mapError(set, error)),
      { body: updateBody }
    )
    .post("/cancel", ({ set }) =>
      runtime
        .runPromise(
          Effect.gen(function* () {
            const migrate = yield* Migrate
            yield* migrate.cancel()
            return yield* composedStatus
          })
        )
        .catch((error) => mapError(set, error))
    )
