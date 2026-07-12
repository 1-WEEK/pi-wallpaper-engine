import { Elysia, t } from "elysia"
import { Effect } from "effect"
import { MigrateError, StorageError } from "@pwe/shared"
import { homedir } from "node:os"
import { Migrate, friendlyMigrateError } from "../services/Migrate.js"
import {
  Storage,
  friendlyStorageError,
} from "../services/Storage.js"
import {
  StorageRootSelection,
  type ValidatedStorageRoot,
} from "../services/StorageRootSelection.js"
import type { AppRuntime } from "../runtime.js"

const directoryBody = t.Object({
  parent: t.String(),
  name: t.String(),
})

const targetBody = t.Object({
  target_root: t.String(),
})

const mapError = (set: { status?: number | string }, error: unknown) => {
  if (error instanceof StorageError) {
    set.status =
      error.kind === "Busy"
        ? 409
        : error.kind === "Disconnected"
          ? 503
          : error.kind === "Validation"
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

const mapDirectoryError = (set: { status?: number | string }, error: unknown) => {
  if (error instanceof StorageError) {
    set.status = error.kind === "Disconnected" ? 503 : 400
  }
  return mapError(set, error)
}

export const displayPath = (path: string): string =>
  path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path

const mapValidatedTarget = (target: ValidatedStorageRoot) => ({
  ok: true as const,
  path: target.path,
  display_path: displayPath(target.path),
  free_bytes: target.freeBytes,
  total_bytes: target.totalBytes,
  used_bytes: target.usedBytes,
  is_empty: target.isEmpty,
  has_source: target.hasSource,
  has_optimized: target.hasOptimized,
  message: "Directory is available and ready.",
})

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
    .get("/locations", ({ set }) =>
      runtime
        .runPromise(
          Effect.gen(function* () {
            const selection = yield* StorageRootSelection
            const roots = yield* selection.listLocations()
            return roots.map((root) => ({
              ...root,
              display_path: displayPath(root.path),
            }))
          })
        )
        .catch((error) => mapDirectoryError(set, error))
    )
    .get(
      "/directories",
      ({ query, set }) =>
        runtime
          .runPromise(
            Effect.gen(function* () {
              const selection = yield* StorageRootSelection
              const listing = yield* selection.browseDirectories(query.path)
              return {
                path: listing.path,
                display_path: displayPath(listing.path),
                entries: listing.entries,
              }
            })
          )
          .catch((error) => mapDirectoryError(set, error)),
      { query: t.Object({ path: t.String() }) }
    )
    .post(
      "/directories",
      ({ body, set }) =>
        runtime
          .runPromise(
            Effect.gen(function* () {
              const selection = yield* StorageRootSelection
              const path = yield* selection.createDirectory(body.parent, body.name)
              return { path, display_path: displayPath(path) }
            })
          )
          .catch((error) => mapDirectoryError(set, error)),
      { body: directoryBody }
    )
    .post(
      "/validate-target",
      ({ body }) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const selection = yield* StorageRootSelection
            return yield* selection.validateTarget(body.target_root).pipe(
              Effect.map(mapValidatedTarget),
              Effect.catchAll((cause) =>
                Effect.succeed({
                  ok: false as const,
                  error: cause.message,
                })
              )
            )
          })
        ),
      { body: targetBody }
    )
    .post(
      "/root",
      ({ body, set }) =>
        runtime
          .runPromise(
            Effect.gen(function* () {
              const selection = yield* StorageRootSelection
              const storage = yield* Storage
              const migrate = yield* Migrate

              const plan = yield* selection.planSwitch(body.target_root)
              if (plan.action === "save") {
                yield* storage.saveRoot(plan.target.path)
              } else if (plan.action === "migrate") {
                yield* migrate.start(plan.target.path)
              }

              const status = yield* composedStatus
              return { status, migrating: plan.action === "migrate" }
            })
          )
          .then(({ status, migrating }) => {
            set.status = migrating ? 202 : 200
            return status
          })
          .catch((error) => mapError(set, error)),
      { body: targetBody }
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
