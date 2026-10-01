import { Context, Effect, Layer, Ref } from "effect"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { constants, existsSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { StorageError } from "@pwe/shared"
import { Config, type RuntimeStorageConfig } from "./Config.js"

/** Storage-owned status. The HTTP layer merges in live migration progress. */
export interface StorageState {
  readonly available: boolean
  readonly data_root: string
  readonly default_root: string
  readonly using_default: boolean
  /**
   * Human-readable description of the current accessibility failure, naming the
   * causing path. `null` when the root is reachable.
   *
   * Derived fresh on every `status()` read from the same probe the availability
   * verdict comes from, so the two can never disagree and a recovery clears it
   * without any cache to invalidate.
   */
  readonly last_error: string | null
}

/**
 * Result of one accessibility probe of the active media root.
 * `reason` is null exactly when `available` is true.
 */
export interface MediaRootProbe {
  readonly root: string
  readonly available: boolean
  readonly reason: string | null
}

/**
 * Distinguish "the media root directory is gone" from "the path is there but
 * not usable". Both are `Disconnected` to callers; the message differs so an
 * administrator can tell an unmounted share from a permissions problem.
 */
export const describeAccessFailure = (
  root: string,
  cause: unknown,
  exists: boolean
): string => {
  const detail =
    cause && typeof cause === "object" && "code" in cause
      ? String(cause.code)
      : cause instanceof Error
        ? cause.message
        : String(cause)
  return exists
    ? `Media root at ${root} exists but is not readable and writable (${detail}).`
    : `Media root is not accessible at ${root}: the directory does not exist (${detail}).`
}

/**
 * One accessibility probe of a media root, shared by `Storage.status()`,
 * `Storage.mediaRoot()`, and `MediaRootWatch` so all three agree on both the
 * verdict and the wording shown to an administrator.
 *
 * A probe never fails: "unreachable" is a result, not an error, because callers
 * need it to converge state rather than abort. `mediaRoot()` keeps the failing
 * behaviour on top of this.
 */
export const probeMediaRoot = (root: string): Effect.Effect<MediaRootProbe> =>
  Effect.tryPromise({
    try: () => access(root, constants.R_OK | constants.W_OK),
    catch: (cause) => cause,
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.as<MediaRootProbe>({ root, available: true, reason: null }),
    // A probe never fails: "unreachable" is a result, not an error, because
    // callers need it to converge state rather than abort. `mediaRoot()` puts
    // the failing behaviour back on top of this.
    Effect.catch((cause) =>
      Effect.succeed<MediaRootProbe>({
        root,
        available: false,
        reason: describeAccessFailure(root, cause, existsSync(root)),
      })
    )
  )

export interface StorageImpl {
  /**
   * The active root and its probe verdict.
   *
   * Infallible on purpose: a probe reports "unreachable" as a result, never as
   * an error, so callers converge on a state instead of aborting. Only
   * `mediaRoot`/`saveRoot` fail.
   */
  readonly status: () => Effect.Effect<StorageState>
  readonly mediaRoot: () => Effect.Effect<string, StorageError>
  readonly mediaRootOrNull: () => Effect.Effect<string | null>
  readonly saveRoot: (root: string | null) => Effect.Effect<StorageState, StorageError>
}

export class Storage extends Context.Service<Storage, StorageImpl>()("Storage") {}

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
  }
}

const serializeConfig = (raw: Record<string, unknown>, storage: RuntimeStorageConfig): string =>
  `${JSON.stringify({ ...raw, storage }, null, 2)}\n`

export const StorageLive = (configPath: string) =>
  Layer.effect(
    Storage,
    Effect.gen(function* () {
      const config = yield* Config
      const storageRef = yield* Ref.make<RuntimeStorageConfig>(config.storage)

      const getStorage = () => Ref.get(storageRef)

      const currentRoot = (storage: RuntimeStorageConfig): string => storage.root ?? config.paths.data_root

      const collapseStoredRoot = (root: string | null): string | null =>
        root === null || root === config.paths.data_root ? null : root

      const ensureAccessible = (root: string) =>
        probeMediaRoot(root).pipe(
          Effect.flatMap((probe) =>
            probe.available
              ? Effect.void
              : Effect.fail(
                  new StorageError({
                    kind: "Disconnected",
                    message: probe.reason ?? `Media root is not accessible at ${root}.`,
                  })
                )
          )
        )

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

      const buildStatus = (): Effect.Effect<StorageState> =>
        Effect.gen(function* () {
          const storage = yield* getStorage()
          const root = currentRoot(storage)
          const probe = yield* probeMediaRoot(root)
          return {
            available: probe.available,
            data_root: root,
            default_root: config.paths.data_root,
            using_default: storage.root === null,
            // Derived fresh on every read, so a recovery clears it. Never
            // cached: a stale failure would outlive the outage it describes.
            last_error: probe.reason,
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
