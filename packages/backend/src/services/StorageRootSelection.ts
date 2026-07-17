import { Context, Effect, Layer } from "effect"
import { constants } from "node:fs"
import { access, mkdir, readdir, realpath, stat, statfs } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import { homedir } from "node:os"
import { DbError, MigrateError, StorageError } from "@pwe/shared"
import { expandHome } from "../paths.js"
import { Config } from "./Config.js"
import { Db } from "./Db.js"
import { Tasks } from "./Tasks.js"
import { Library } from "./Library.js"
import { Storage, isPathInsideRoot, normalizeCustomRootPath } from "./Storage.js"
import {
  ACTIVE_TRANSCODE_JOB_STATUSES,
  activeTranscodeStatusesSql,
} from "./TranscodeJobStatus.js"

export interface StorageLocation {
  readonly id: string
  readonly label: string
  readonly path: string
}

export interface StorageDirectoryEntry {
  readonly name: string
  readonly path: string
}

export interface StorageDirectoryListing {
  readonly path: string
  readonly entries: ReadonlyArray<StorageDirectoryEntry>
}

export interface ValidatedStorageRoot {
  readonly path: string
  readonly freeBytes: number
  readonly totalBytes: number
  readonly usedBytes: number
  readonly isEmpty: boolean
  readonly hasSource: boolean
  readonly hasOptimized: boolean
}

export type SwitchPlan =
  | { readonly action: "noop"; readonly target: ValidatedStorageRoot }
  | { readonly action: "save"; readonly target: ValidatedStorageRoot }
  | { readonly action: "migrate"; readonly target: ValidatedStorageRoot }

export interface StorageRootSelectionImpl {
  readonly listLocations: () => Effect.Effect<ReadonlyArray<StorageLocation>, StorageError>
  readonly browseDirectories: (
    path: string
  ) => Effect.Effect<StorageDirectoryListing, StorageError>
  readonly createDirectory: (parent: string, name: string) => Effect.Effect<string, StorageError>
  readonly validateTarget: (
    path: string
  ) => Effect.Effect<ValidatedStorageRoot, StorageError>
  readonly planSwitch: (
    targetRoot: string
  ) => Effect.Effect<SwitchPlan, StorageError | MigrateError | DbError>
}

export class StorageRootSelection extends Context.Tag("StorageRootSelection")<
  StorageRootSelection,
  StorageRootSelectionImpl
>() {}

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

const uniqueByPath = <T extends { path: string }>(items: ReadonlyArray<T>): T[] => {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.path)) return false
    seen.add(item.path)
    return true
  })
}

const toStorageError = (kind: StorageError["kind"], message: string, cause: unknown): StorageError =>
  cause instanceof StorageError ? cause : new StorageError({ kind, message, cause })

export const StorageRootSelectionLive = Layer.effect(
  StorageRootSelection,
  Effect.gen(function* () {
    const config = yield* Config
    const db = yield* Db
    const downloadTasks = yield* Tasks
    const library = yield* Library
    const storage = yield* Storage

    const candidateRoots = (currentRoot: string): ReadonlyArray<StorageLocation> =>
      uniqueByPath([
        { id: "mnt", label: "Mounts", path: "/mnt" },
        { id: "media", label: "External media", path: "/media" },
        { id: "home", label: "Home", path: homedir() },
        { id: "default", label: "Default media root", path: expandHome(config.paths.data_root) },
        { id: "current", label: "Current media root", path: currentRoot },
        { id: "current-parent", label: "Parent of current", path: dirname(currentRoot) },
      ])

    const existingAllowedRoots = async (currentRoot: string) => {
      const roots = candidateRoots(currentRoot)
      const existing: Array<StorageLocation & { real: string }> = []
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

    const assertInsideAllowedRoots = async (inputPath: string, currentRoot: string): Promise<string> => {
      if (!isAbsolute(inputPath) || hasControlChars(inputPath)) {
        throw new StorageError({ kind: "Config", message: "Path must be absolute." })
      }
      const candidate = await realpath(resolve(inputPath))
      const roots = await existingAllowedRoots(currentRoot)
      if (!roots.some((root) => isPathInsideRoot(candidate, root.real))) {
        throw new StorageError({ kind: "Config", message: "Path is outside the allowed roots." })
      }
      return candidate
    }

    const validateTargetWithCurrentRoot = (
      targetRoot: string,
      currentRoot: string
    ): Effect.Effect<ValidatedStorageRoot, StorageError> =>
      Effect.tryPromise({
        try: async () => {
          const normalized = await Effect.runPromise(
            normalizeCustomRootPath("Target root", targetRoot)
          )
          const path = await assertInsideAllowedRoots(normalized, currentRoot)
          const s = await stat(path)
          if (!s.isDirectory()) {
            throw new StorageError({ kind: "Config", message: "Target path is not a directory." })
          }
          await access(path, constants.R_OK | constants.W_OK)
          const [fs, entries] = await Promise.all([statfs(path), readdir(path)])
          const totalBytes = fs.blocks * fs.bsize
          const freeBytes = fs.bavail * fs.bsize
          return {
            path,
            freeBytes,
            totalBytes,
            usedBytes: Math.max(0, totalBytes - freeBytes),
            isEmpty: entries.length === 0,
            hasSource: entries.includes(config.paths.source_dir),
            hasOptimized: entries.includes(config.paths.optimized_dir),
          } satisfies ValidatedStorageRoot
        },
        catch: (cause) =>
          toStorageError(
            cause instanceof StorageError ? cause.kind : "Validation",
            cause instanceof Error ? cause.message : String(cause),
            cause
          ),
      })

    return {
      listLocations: () =>
        Effect.gen(function* () {
          const status = yield* storage.status()
          const roots = yield* Effect.tryPromise({
            try: () => existingAllowedRoots(status.data_root),
            catch: (cause) =>
              toStorageError(
                "Validation",
                cause instanceof Error ? cause.message : String(cause),
                cause
              ),
          })
          return roots.map(({ real: _real, ...root }) => root)
        }),

      browseDirectories: (path) =>
        Effect.gen(function* () {
          const status = yield* storage.status()
          const current = yield* Effect.tryPromise({
            try: () => assertInsideAllowedRoots(path, status.data_root),
            catch: (cause) =>
              toStorageError(
                cause instanceof StorageError ? cause.kind : "Config",
                cause instanceof Error ? cause.message : String(cause),
                cause
              ),
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
              toStorageError(
                "Validation",
                cause instanceof Error ? cause.message : String(cause),
                cause
              ),
          })
          return { path: current, entries }
        }),

      createDirectory: (parent, name) =>
        Effect.gen(function* () {
          const status = yield* storage.status()
          const normalizedParent = yield* Effect.tryPromise({
            try: () => assertInsideAllowedRoots(parent, status.data_root),
            catch: (cause) =>
              toStorageError(
                cause instanceof StorageError ? cause.kind : "Config",
                cause instanceof Error ? cause.message : String(cause),
                cause
              ),
          })
          const safeName = safeDirName(name)
          if (!safeName) {
            return yield* Effect.fail(
              new StorageError({ kind: "Config", message: "Directory name is not valid." })
            )
          }
          const target = resolve(normalizedParent, safeName)
          if (!isPathInsideRoot(target, normalizedParent)) {
            return yield* Effect.fail(
              new StorageError({ kind: "Config", message: "Directory path is not valid." })
            )
          }
          return yield* Effect.tryPromise({
            try: async () => {
              await mkdir(target)
              return realpath(target)
            },
            catch: (cause) =>
              toStorageError(
                "Validation",
                cause instanceof Error ? cause.message : String(cause),
                cause
              ),
          })
        }),

      validateTarget: (targetRoot) =>
        Effect.gen(function* () {
          const status = yield* storage.status()
          return yield* validateTargetWithCurrentRoot(targetRoot, status.data_root)
        }),

      planSwitch: (targetRoot) =>
        Effect.gen(function* () {
          const status = yield* storage.status()
          const target = yield* validateTargetWithCurrentRoot(targetRoot, status.data_root)
          const targetChanged = target.path !== status.data_root
          if (!targetChanged) return { action: "noop", target } satisfies SwitchPlan

          // Count via .total — .items is capped by the list limit and would
          // miss an active download older than the newest page.
          const activeDownloads = (yield* downloadTasks.list({ type: "download", active: true, limit: 1 })).total
          if (activeDownloads > 0) {
            return yield* Effect.fail(
              new MigrateError({
                kind: "Busy",
                message: "Downloads are in progress. Wait for them to finish before switching roots.",
              })
            )
          }

          const activeTranscodes = yield* db.queryOne<{ n: number }>(
            `SELECT COUNT(*) AS n
             FROM transcode_jobs
             WHERE ${activeTranscodeStatusesSql()}`,
            [...ACTIVE_TRANSCODE_JOB_STATUSES]
          )
          if (Number(activeTranscodes?.n ?? 0) > 0) {
            return yield* Effect.fail(
              new MigrateError({
                kind: "Busy",
                message: "A transcode job is active. Wait for it to finish before switching roots.",
              })
            )
          }

          const libraryRows = yield* library.list()
          return {
            action: libraryRows.length > 0 ? "migrate" : "save",
            target,
          } satisfies SwitchPlan
        }),
    }
  })
)
