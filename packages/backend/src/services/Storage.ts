import { Context, Effect, Layer, Ref } from "effect"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { StorageError } from "@pwe/shared"
import { Config, type RuntimeStorageConfig } from "./Config.js"

/** Storage-owned status. The HTTP layer merges in live migration progress. */
export interface StorageState {
  readonly available: boolean
  readonly data_root: string
  readonly default_root: string
  readonly using_default: boolean
  readonly last_error: string | null
}

export interface StorageImpl {
  readonly status: () => Effect.Effect<StorageState, StorageError>
  readonly mediaRoot: () => Effect.Effect<string, StorageError>
  readonly mediaRootOrNull: () => Effect.Effect<string | null>
  readonly saveRoot: (root: string | null) => Effect.Effect<StorageState, StorageError>
}

export class Storage extends Context.Tag("Storage")<Storage, StorageImpl>() {}

export const normalizeCustomRootPath = (
  field: string,
  value: string | null | undefined
): Effect.Effect<string, StorageError> => {
  const trimmed = (value ?? "").trim()
  if (!trimmed || !isAbsolute(trimmed) || /[\r\n\0]/.test(trimmed)) {
    return Effect.fail(
      new StorageError({
        kind: "Config",
        message: `${field} must be an absolute directory path.`,
      })
    )
  }
  return Effect.succeed(resolve(trimmed))
}

export const isPathInsideRoot = (candidatePath: string, rootPath: string): boolean => {
  const rel = relative(rootPath, candidatePath)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/** Map an internal StorageError to a message safe to show a non-technical user. */
export const friendlyStorageError = (error: StorageError): string => {
  switch (error.kind) {
    case "Validation":
    case "Config":
      return "Invalid directory. Make sure it exists and the app can read and write to it."
    case "Disconnected":
      return "Current media root is unavailable."
    case "Busy":
      return "A video from this directory is playing. Stop playback before switching roots."
    case "Mount":
      return "Directory is temporarily unavailable."
    case "Secret":
      return "Directory configuration is unavailable."
  }
}

const serializeConfig = (raw: Record<string, unknown>, storage: RuntimeStorageConfig): string =>
  `${JSON.stringify({ ...raw, storage }, null, 2)}\n`

export const StorageLive = (configPath: string) =>
  Layer.scoped(
    Storage,
    Effect.gen(function* () {
      const config = yield* Config
      const storageRef = yield* Ref.make<RuntimeStorageConfig>(config.storage)

      const getStorage = () => Ref.get(storageRef)

      const currentRoot = (storage: RuntimeStorageConfig): string => storage.root ?? config.paths.data_root

      const collapseStoredRoot = (root: string | null): string | null =>
        root === null || root === config.paths.data_root ? null : root

      const ensureAccessible = (root: string) =>
        Effect.tryPromise({
          try: () => access(root, constants.R_OK | constants.W_OK),
          catch: (cause) =>
            new StorageError({
              kind: "Disconnected",
              message: `Media root is not accessible at ${root}.`,
              cause,
            }),
        })

      const getPersistedConfig = () =>
        Effect.tryPromise({
          try: async () => JSON.parse(await readFile(configPath, "utf-8")) as Record<string, unknown>,
          catch: (cause) =>
            new StorageError({ kind: "Config", message: `Failed to read ${configPath}.`, cause }),
        })

      const writePersistedStorage = (nextStorage: RuntimeStorageConfig) =>
        Effect.gen(function* () {
          const raw = yield* getPersistedConfig()
          yield* Effect.tryPromise({
            try: async () => {
              await mkdir(dirname(configPath), { recursive: true })
              await writeFile(configPath, serializeConfig(raw, nextStorage), "utf-8")
            },
            catch: (cause) =>
              new StorageError({ kind: "Config", message: `Failed to write ${configPath}.`, cause }),
          })
          yield* Ref.set(storageRef, nextStorage)
        })

      const buildStatus = (): Effect.Effect<StorageState, StorageError> =>
        Effect.gen(function* () {
          const storage = yield* getStorage()
          const dataRoot = currentRoot(storage)
          const available = yield* ensureAccessible(dataRoot).pipe(
            Effect.as(true),
            Effect.catchTag("StorageError", () => Effect.succeed(false))
          )
          return {
            available,
            data_root: dataRoot,
            default_root: config.paths.data_root,
            using_default: storage.root === null,
            last_error: available ? null : "Directory is unavailable. Make sure it exists and is readable and writable.",
          } satisfies StorageState
        })

      const mediaRoot = () =>
        Effect.gen(function* () {
          const storage = yield* getStorage()
          const root = currentRoot(storage)
          yield* ensureAccessible(root)
          return root
        })

      const mediaRootOrNull = () =>
        mediaRoot().pipe(Effect.catchTag("StorageError", () => Effect.succeed(null)))

      const saveRoot = (root: string | null) =>
        Effect.gen(function* () {
          const storage = yield* getStorage()
          const nextRoot =
            root === null
              ? null
              : yield* normalizeCustomRootPath("Media root", root).pipe(
                  Effect.map(collapseStoredRoot)
                )
          yield* writePersistedStorage({ ...storage, root: nextRoot })
          return yield* buildStatus()
        })

      return {
        status: buildStatus,
        mediaRoot,
        mediaRootOrNull,
        saveRoot,
      }
    })
  )
