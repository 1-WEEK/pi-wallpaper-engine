import { Context, Effect, Layer, Ref, Schedule } from "effect"
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { constants, existsSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { StorageError } from "@pwe/shared"
import {
  SMB_CONNECTION_NAME,
  STORAGE_HELPER_PATH,
  STORAGE_MOUNT_BASE,
  STORAGE_MOUNT_SENTINEL,
  resolveStateRoot,
  storageSecretKey,
} from "../statePath.js"
import { Config, type RuntimeStorageConfig } from "./Config.js"
import { Logger } from "./Logger.js"

type StorageStateKind = "local" | "connected" | "disconnected" | "error"

interface StorageRuntimeState {
  readonly kind: StorageStateKind
  readonly lastError: string | null
}

export interface SmbInput {
  readonly server: string
  readonly share: string
  readonly username: string
  readonly password?: string | null
}

export interface SmbRecord {
  readonly server: string
  readonly share: string
  readonly username: string
  readonly has_password: boolean
}

/** Storage-owned status. The HTTP layer merges in live migration progress. */
export interface StorageState {
  readonly mode: "local" | "mounted_share"
  readonly available: boolean
  readonly data_root: string
  readonly last_error: string | null
  readonly smb: SmbRecord | null
}

export interface StorageImpl {
  readonly status: () => Effect.Effect<StorageState, StorageError>
  readonly mediaRoot: () => Effect.Effect<string, StorageError>
  readonly mediaRootOrNull: () => Effect.Effect<string | null>
  /** Media root a given mode would use, regardless of the current mode. */
  readonly mediaRootFor: (mode: "local" | "mounted_share") => string
  /** Persist SMB credentials/config. Does not change mode or mount anything. */
  readonly saveSmb: (input: SmbInput) => Effect.Effect<StorageState, StorageError>
  /** Set storage mode and reconcile the mount. Used for instant (no-move) switches and after a migration. */
  readonly applyMode: (mode: "local" | "mounted_share") => Effect.Effect<StorageState, StorageError>
  /** Persist the target mode after migration verification. Keeps SMB mounted for NAS→local cleanup. */
  readonly finishMigration: (mode: "local" | "mounted_share") => Effect.Effect<StorageState, StorageError>
  /** Ensure the SMB share is mounted. Idempotent. Used by migration and the reconcile loop. */
  readonly connect: () => Effect.Effect<void, StorageError>
}

export class Storage extends Context.Tag("Storage")<Storage, StorageImpl>() {}

const DEFAULT_MOUNT_OPTIONS = [
  "vers=3.0",
  "iocharset=utf8",
  "uid=1000",
  "gid=1000",
  "file_mode=0644",
  "dir_mode=0755",
] as const

const ALLOWED_MOUNT_OPTION_KEYS = new Set([
  "vers",
  "iocharset",
  "uid",
  "gid",
  "file_mode",
  "dir_mode",
  "nobrl",
])

const FORBIDDEN_MOUNT_OPTIONS = [
  /^credentials=/i,
  /^password=/i,
  /^passwd=/i,
  /^guest$/i,
  /^noperm$/i,
  /^sec=ntlm$/i,
  /^vers=1(?:\.0)?$/i,
] as const

const FORBIDDEN_CREDENTIAL_VALUE_RE = /[\r\n\0]/
const FORBIDDEN_SMB_COMPONENT_RE = /[\/\\\r\n\0]/

export const assertCredentialFileValue = (
  field: string,
  value: string,
  kind: "Config" | "Secret" = "Config"
): Effect.Effect<string, StorageError> =>
  FORBIDDEN_CREDENTIAL_VALUE_RE.test(value)
    ? Effect.fail(
        new StorageError({
          kind,
          message: `${field} cannot contain newline or NUL characters.`,
        })
      )
    : Effect.succeed(value)

export const assertSmbComponentValue = (
  field: string,
  value: string
): Effect.Effect<string, StorageError> =>
  FORBIDDEN_SMB_COMPONENT_RE.test(value)
    ? Effect.fail(
        new StorageError({
          kind: "Config",
          message: `${field} cannot contain slashes, newline, or NUL characters.`,
        })
      )
    : Effect.succeed(value)

export const isPathInsideRoot = (candidatePath: string, rootPath: string): boolean => {
  const rel = relative(rootPath, candidatePath)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

export const normalizeMountOptions = (
  mountOptions: readonly string[]
): Effect.Effect<string[], StorageError> =>
  Effect.forEach(mountOptions, (option) => {
    const trimmed = option.trim()
    if (!trimmed) {
      return Effect.fail(
        new StorageError({ kind: "Config", message: "Mount options cannot be empty." })
      )
    }
    if (FORBIDDEN_MOUNT_OPTIONS.some((pattern) => pattern.test(trimmed))) {
      return Effect.fail(
        new StorageError({ kind: "Config", message: `Mount option ${trimmed} is not allowed.` })
      )
    }
    const [key] = trimmed.split("=", 1)
    if (!key || !ALLOWED_MOUNT_OPTION_KEYS.has(key)) {
      return Effect.fail(
        new StorageError({ kind: "Config", message: `Mount option ${trimmed} is not supported.` })
      )
    }
    return Effect.succeed(trimmed)
  })

/** Map an internal StorageError to a message safe to show a non-technical user. */
export const friendlyStorageError = (error: StorageError): string => {
  switch (error.kind) {
    case "Mount":
    case "Validation":
      return "连不上网络存储。请确认设备已开机,且地址、用户名、密码正确。"
    case "Disconnected":
      return "网络存储未连接。"
    case "Secret":
      return "网络存储密码未保存,请重新填写。"
    case "Busy":
      return "正在播放网络存储上的视频,请先停止播放再切换。"
    case "Config":
      return "网络存储配置不完整。"
  }
}

const serializeConfig = (raw: Record<string, unknown>, storage: RuntimeStorageConfig): string =>
  `${JSON.stringify({ ...raw, storage }, null, 2)}\n`

export const StorageLive = (configPath: string) =>
  Layer.scoped(
    Storage,
    Effect.gen(function* () {
      const config = yield* Config
      const logger = yield* Logger
      const storageRef = yield* Ref.make<RuntimeStorageConfig>(config.storage)
      const stateRef = yield* Ref.make<StorageRuntimeState>({
        kind: config.storage.mode === "local" ? "local" : "disconnected",
        lastError: null,
      })

      const MOUNT_ROOT = resolve(STORAGE_MOUNT_BASE, SMB_CONNECTION_NAME)
      const SECRET_NAME = storageSecretKey(SMB_CONNECTION_NAME)

      const setState = (kind: StorageStateKind, lastError: string | null) =>
        Ref.set(stateRef, { kind, lastError })

      const getStorage = () => Ref.get(storageRef)

      const mediaRootFor = (mode: "local" | "mounted_share"): string =>
        mode === "local" ? config.paths.data_root : MOUNT_ROOT

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

      const getStoredPassword = () =>
        Effect.tryPromise({
          try: async () => {
            const password = await Bun.secrets.get({
              service: "pi-wallpaper-engine",
              name: SECRET_NAME,
            })
            if (!password) throw new Error("No password stored in keyring")
            return password
          },
          catch: (cause) =>
            new StorageError({ kind: "Secret", message: "No SMB password stored.", cause }),
        })

      const setStoredPassword = (password: string) =>
        Effect.tryPromise({
          try: () =>
            Bun.secrets.set({ service: "pi-wallpaper-engine", name: SECRET_NAME, value: password }),
          catch: (cause) =>
            new StorageError({ kind: "Secret", message: "Failed to store SMB password.", cause }),
        })

      const hasStoredPassword = (): Effect.Effect<boolean> =>
        Effect.tryPromise({
          try: async () => {
            const secret = await Bun.secrets.get({
              service: "pi-wallpaper-engine",
              name: SECRET_NAME,
            })
            return Boolean(secret)
          },
          catch: () => new Error("keyring read failed"),
        }).pipe(Effect.orElseSucceed(() => false))

      const runHelper = (args: string[], action: string) =>
        Effect.tryPromise({
          try: async () => {
            const proc = Bun.spawn(["sudo", "-n", STORAGE_HELPER_PATH, ...args], {
              stdout: "pipe",
              stderr: "pipe",
              stdin: "ignore",
            })
            const [stdout, stderr, code] = await Promise.all([
              new Response(proc.stdout).text(),
              new Response(proc.stderr).text(),
              proc.exited,
            ])
            if (code !== 0) {
              throw new Error((stderr || stdout || `exit ${code}`).trim())
            }
          },
          catch: (cause) =>
            new StorageError({
              kind: "Mount",
              message: `${action} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
              cause,
            }),
        })

      const verifyMountedRoot = () =>
        Effect.gen(function* () {
          const sentinel = resolve(MOUNT_ROOT, STORAGE_MOUNT_SENTINEL)
          yield* Effect.tryPromise({
            try: () => access(MOUNT_ROOT, constants.R_OK | constants.W_OK),
            catch: (cause) =>
              new StorageError({
                kind: "Validation",
                message: `Mounted share is not accessible at ${MOUNT_ROOT}.`,
                cause,
              }),
          })
          yield* Effect.tryPromise({
            try: () => access(sentinel, constants.R_OK),
            catch: (cause) =>
              new StorageError({
                kind: "Validation",
                message: `Mounted share is missing sentinel ${STORAGE_MOUNT_SENTINEL}.`,
                cause,
              }),
          })
        })

      const disconnectMount = () =>
        Effect.gen(function* () {
          if (existsSync(MOUNT_ROOT)) {
            yield* runHelper(["umount", MOUNT_ROOT], "Unmount")
          }
        })

      const connect = () =>
        Effect.gen(function* () {
          const storage = yield* getStorage()
          const smb = storage.smb
          if (!smb) {
            return yield* Effect.fail(
              new StorageError({ kind: "Config", message: "SMB storage is not configured." })
            )
          }

          // Already mounted and healthy → nothing to do.
          const healthy = yield* verifyMountedRoot().pipe(
            Effect.as(true),
            Effect.catchTag("StorageError", () => Effect.succeed(false))
          )
          if (healthy) {
            yield* setState("connected", null)
            return
          }

          const credentialDir = resolve(resolveStateRoot(), "storage-credentials")
          const credentialFile = resolve(
            credentialDir,
            `.tmp-${SMB_CONNECTION_NAME}-${Date.now()}.cred`
          )
          const server = yield* assertSmbComponentValue("Server", smb.server)
          const share = yield* assertSmbComponentValue("Share", smb.share)
          const username = yield* assertCredentialFileValue("Username", smb.username)
          const password = yield* getStoredPassword().pipe(
            Effect.flatMap((value) => assertCredentialFileValue("Stored password", value, "Secret"))
          )
          const optionList = [...DEFAULT_MOUNT_OPTIONS, `credentials=${credentialFile}`].join(",")

          // Effect failures do not propagate through JS try/catch/finally inside
          // Effect.gen, so cleanup and error recovery use ensuring / tapError.
          const removeCredentialFile = Effect.tryPromise({
            try: () => rm(credentialFile, { force: true }),
            catch: () => null,
          }).pipe(Effect.ignore)

          yield* Effect.gen(function* () {
            yield* disconnectMount().pipe(Effect.catchTag("StorageError", () => Effect.void))
            yield* Effect.tryPromise({
              try: async () => {
                await mkdir(credentialDir, { recursive: true, mode: 0o700 })
                await writeFile(credentialFile, `username=${username}\npassword=${password}\n`, {
                  mode: 0o600,
                })
              },
              catch: (cause) =>
                new StorageError({
                  kind: "Mount",
                  message: "Failed to prepare mount credentials.",
                  cause,
                }),
            })
            yield* runHelper(
              ["mount", `//${server}/${share}`, MOUNT_ROOT, optionList],
              "Mount"
            )
            yield* verifyMountedRoot()
            yield* setState("connected", null)
            yield* logger.info("Connected SMB storage")
          }).pipe(
            Effect.tapError((error) =>
              Effect.gen(function* () {
                yield* logger.warn(`SMB connect failed: ${error.message}`)
                yield* setState("error", friendlyStorageError(error))
                yield* runHelper(["umount", MOUNT_ROOT], "Unmount").pipe(
                  Effect.catchTag("StorageError", () => Effect.void)
                )
              })
            ),
            Effect.ensuring(removeCredentialFile)
          )
        })

      const buildStatus = (): Effect.Effect<StorageState, StorageError> =>
        Effect.gen(function* () {
          const storage = yield* getStorage()
          const state = yield* Ref.get(stateRef)
          const hasPassword = storage.smb ? yield* hasStoredPassword() : false
          return {
            mode: storage.mode,
            available: state.kind === "local" || state.kind === "connected",
            data_root: mediaRootFor(storage.mode),
            last_error: state.lastError,
            smb: storage.smb
              ? {
                  server: storage.smb.server,
                  share: storage.smb.share,
                  username: storage.smb.username,
                  has_password: hasPassword,
                }
              : null,
          } satisfies StorageState
        })

      const mediaRoot = () =>
        Effect.gen(function* () {
          const storage = yield* getStorage()
          if (storage.mode === "local") return config.paths.data_root
          const state = yield* Ref.get(stateRef)
          if (state.kind !== "connected") {
            return yield* Effect.fail(
              new StorageError({ kind: "Disconnected", message: "SMB storage is not connected." })
            )
          }
          return MOUNT_ROOT
        })

      const mediaRootOrNull = () =>
        mediaRoot().pipe(Effect.catchTag("StorageError", () => Effect.succeed(null)))

      const saveSmb = (input: SmbInput) =>
        Effect.gen(function* () {
          const server = input.server.trim()
          const share = input.share.trim()
          const username = input.username.trim()
          if (!server || !share || !username) {
            return yield* Effect.fail(
              new StorageError({
                kind: "Config",
                message: "Server, share, and username are required.",
              })
            )
          }
          yield* assertSmbComponentValue("Server", server)
          yield* assertSmbComponentValue("Share", share)
          yield* assertCredentialFileValue("Username", username)

          const password = input.password?.trim() ? input.password : null
          const hadPassword = yield* hasStoredPassword()
          if (!password && !hadPassword) {
            return yield* Effect.fail(
              new StorageError({ kind: "Config", message: "A storage password is required." })
            )
          }
          if (password) {
            yield* assertCredentialFileValue("Password", password, "Secret")
            yield* setStoredPassword(password)
          }

          const storage = yield* getStorage()
          yield* writePersistedStorage({ ...storage, smb: { server, share, username } })
          return yield* buildStatus()
        })

      const finishMigration = (mode: "local" | "mounted_share") =>
        Effect.gen(function* () {
          const storage = yield* getStorage()
          yield* writePersistedStorage({ ...storage, mode })
          if (mode === "local") {
            // Keep the SMB mount available until Migrate removes the old NAS
            // source tree; applyMode("local") performs the final unmount.
            yield* setState("local", null)
          } else {
            yield* connect().pipe(Effect.catchTag("StorageError", () => Effect.void))
          }
          return yield* buildStatus()
        })

      const applyMode = (mode: "local" | "mounted_share") =>
        Effect.gen(function* () {
          const storage = yield* getStorage()
          yield* writePersistedStorage({ ...storage, mode })
          if (mode === "local") {
            yield* disconnectMount().pipe(Effect.catchTag("StorageError", () => Effect.void))
            yield* setState("local", null)
          } else {
            yield* connect().pipe(Effect.catchTag("StorageError", () => Effect.void))
          }
          return yield* buildStatus()
        })

      // Reconcile loop: when in mounted_share mode, keep the SMB share mounted.
      // Runs immediately at startup, then every 30s — without this, a share
      // that boots slower than the Pi or briefly drops would stay "unavailable".
      const reconcileTick = Effect.gen(function* () {
        const storage = yield* getStorage()
        if (storage.mode !== "mounted_share") return
        yield* connect().pipe(Effect.catchTag("StorageError", () => Effect.void))
      })

      yield* reconcileTick.pipe(
        Effect.repeat(Schedule.spaced("30 seconds")),
        Effect.forkScoped
      )

      return {
        status: buildStatus,
        mediaRoot,
        mediaRootOrNull,
        mediaRootFor,
        saveSmb,
        applyMode,
        finishMigration,
        connect,
      }
    })
  )
