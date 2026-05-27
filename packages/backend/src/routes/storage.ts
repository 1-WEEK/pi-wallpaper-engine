import { Elysia, t } from "elysia"
import { Effect } from "effect"
import { MigrateError, StorageError } from "@pwe/shared"
import { access, mkdir, readdir, realpath, stat, statfs } from "node:fs/promises"
import { constants } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import { homedir } from "node:os"
import { Config, type RuntimeConfig } from "../services/Config.js"
import { DownloadTasks } from "../services/DownloadTasks.js"
import { Library } from "../services/Library.js"
import { Migrate, friendlyMigrateError } from "../services/Migrate.js"
import {
  Storage,
  friendlyStorageError,
  isPathInsideRoot,
  normalizeCustomRootPath,
} from "../services/Storage.js"
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

const mapDirectoryError = (set: { status?: number | string }, error: unknown) => {
  if (error instanceof StorageError) {
    set.status =
      error.kind === "Disconnected" ? 503 : error.kind === "Mount" ? 502 : 400
    return { ok: false, error: error.message, kind: error.kind }
  }
  return mapError(set, error)
}

const isFinishedTask = (stage: string, finishedAt: number | null): boolean =>
  stage === "complete" || stage === "error" || finishedAt !== null

const expandHome = (path: string): string =>
  path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(path)

const displayPath = (path: string): string =>
  path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path

const hasControlChars = (value: string): boolean => /[\r\n\0]/.test(value)

const safeDirName = (name: string): string | null => {
  const trimmed = name.trim()
  if (
    !trimmed ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    hasControlChars(trimmed)
  ) {
    return null
  }
  return trimmed
}

const uniqueByPath = <T extends { path: string }>(items: T[]): T[] => {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.path)) return false
    seen.add(item.path)
    return true
  })
}

const candidateRoots = async (config: RuntimeConfig, currentRoot: string) =>
  uniqueByPath([
    { id: "mnt", label: "Mounts", path: "/mnt" },
    { id: "media", label: "External media", path: "/media" },
    { id: "home", label: "Home", path: homedir() },
    { id: "default", label: "Default media root", path: expandHome(config.paths.data_root) },
    { id: "current", label: "Current media root", path: currentRoot },
    { id: "current-parent", label: "Parent of current", path: dirname(currentRoot) },
  ])

const existingAllowedRoots = async (config: RuntimeConfig, currentRoot: string) => {
  const roots = await candidateRoots(config, currentRoot)
  const existing: Array<{ id: string; label: string; path: string; real: string }> = []
  for (const root of roots) {
    try {
      const s = await stat(root.path)
      if (!s.isDirectory()) continue
      const real = await realpath(root.path)
      if (existing.some((item) => item.real === real)) continue
      existing.push({ ...root, path: real, real })
    } catch {
      // Some common roots may not exist on every Pi.
    }
  }
  return existing
}

const assertInsideAllowedRoots = async (
  inputPath: string,
  config: RuntimeConfig,
  currentRoot: string
): Promise<string> => {
  if (!isAbsolute(inputPath) || hasControlChars(inputPath)) {
    throw new StorageError({ kind: "Config", message: "Path must be absolute." })
  }
  const candidate = await realpath(resolve(inputPath))
  const roots = await existingAllowedRoots(config, currentRoot)
  if (!roots.some((root) => isPathInsideRoot(candidate, root.real))) {
    throw new StorageError({ kind: "Config", message: "Path is outside the allowed roots." })
  }
  return candidate
}

const validateTargetRoot = async (targetRoot: string, config: RuntimeConfig, currentRoot: string) => {
  const normalized = await Effect.runPromise(normalizeCustomRootPath("Target root", targetRoot))
  const path = await assertInsideAllowedRoots(normalized, config, currentRoot)
  const s = await stat(path)
  if (!s.isDirectory()) {
    throw new StorageError({ kind: "Config", message: "Target path is not a directory." })
  }
  await access(path, constants.R_OK | constants.W_OK)
  const [fs, entries] = await Promise.all([statfs(path), readdir(path)])
  const total = fs.blocks * fs.bsize
  const free = fs.bavail * fs.bsize
  return {
    ok: true as const,
    path,
    display_path: displayPath(path),
    free_bytes: free,
    total_bytes: total,
    used_bytes: Math.max(0, total - free),
    is_empty: entries.length === 0,
    has_source: entries.includes(config.paths.source_dir),
    has_optimized: entries.includes(config.paths.optimized_dir),
    message: "Directory is available and ready.",
  }
}

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
            const config = yield* Config
            const storage = yield* Storage
            const status = yield* storage.status()
            const roots = yield* Effect.promise(() =>
              existingAllowedRoots(config, status.data_root)
            )
            return roots.map(({ id, label, path }) => ({
              id,
              label,
              path,
              display_path: displayPath(path),
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
              const config = yield* Config
              const storage = yield* Storage
              const status = yield* storage.status()
              const current = yield* Effect.tryPromise({
                try: () => assertInsideAllowedRoots(query.path, config, status.data_root),
                catch: (cause) =>
                  cause instanceof StorageError
                    ? cause
                    : new StorageError({
                        kind: "Config",
                        message: cause instanceof Error ? cause.message : String(cause),
                        cause,
                      }),
              })
              const entries = yield* Effect.tryPromise({
                try: async () => {
                  const children = await readdir(current, { withFileTypes: true })
                  return children
                    .filter((child) => child.isDirectory())
                    .map((child) => ({
                      name: child.name,
                      path: resolve(current, child.name),
                    }))
                    .sort((a, b) => a.name.localeCompare(b.name))
                },
                catch: (cause) =>
                  new StorageError({
                    kind: "Validation",
                    message: cause instanceof Error ? cause.message : String(cause),
                    cause,
                  }),
              })
              return {
                path: current,
                display_path: displayPath(current),
                entries,
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
              const config = yield* Config
              const storage = yield* Storage
              const status = yield* storage.status()
              const parent = yield* Effect.tryPromise({
                try: () => assertInsideAllowedRoots(body.parent, config, status.data_root),
                catch: (cause) =>
                  cause instanceof StorageError
                    ? cause
                    : new StorageError({
                        kind: "Config",
                        message: cause instanceof Error ? cause.message : String(cause),
                        cause,
                      }),
              })
              const name = safeDirName(body.name)
              if (!name) {
                return yield* Effect.fail(
                  new StorageError({ kind: "Config", message: "Directory name is not valid." })
                )
              }
              const target = resolve(parent, name)
              if (!isPathInsideRoot(target, parent)) {
                return yield* Effect.fail(
                  new StorageError({ kind: "Config", message: "Directory path is not valid." })
                )
              }
              const path = yield* Effect.tryPromise({
                try: async () => {
                  await mkdir(target)
                  return realpath(target)
                },
                catch: (cause) =>
                  new StorageError({
                    kind: "Validation",
                    message: cause instanceof Error ? cause.message : String(cause),
                    cause,
                  }),
              })
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
            const config = yield* Config
            const storage = yield* Storage
            const status = yield* storage.status()
            return yield* Effect.tryPromise({
              try: () => validateTargetRoot(body.target_root, config, status.data_root),
              catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
            }).pipe(
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
              const config = yield* Config
              const storage = yield* Storage
              const migrate = yield* Migrate
              const library = yield* Library
              const tasks = yield* DownloadTasks

              const currentStatus = yield* storage.status()
              const target = yield* Effect.tryPromise({
                try: () => validateTargetRoot(body.target_root, config, currentStatus.data_root),
                catch: (cause) =>
                  cause instanceof StorageError
                    ? cause
                    : new StorageError({
                        kind: "Config",
                        message: cause instanceof Error ? cause.message : String(cause),
                        cause,
                      }),
              })

              const libraryRows = yield* library.list()
              const targetChanged = target.path !== currentStatus.data_root
              if (targetChanged) {
                const activeDownloads = (yield* tasks.list()).filter(
                  (task) => !isFinishedTask(task.stage, task.finished_at)
                )
                if (activeDownloads.length > 0) {
                  return yield* Effect.fail(
                    new MigrateError({
                      kind: "Busy",
                      message: "Downloads are in progress. Wait for them to finish before switching roots.",
                    })
                  )
                }
              }

              const needsMigration = targetChanged && libraryRows.length > 0
              if (needsMigration) {
                yield* migrate.start(target.path)
              } else {
                yield* storage.saveRoot(target.path)
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
