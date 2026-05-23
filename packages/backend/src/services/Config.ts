import { Context, Effect, Layer, Schema } from "effect"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { homedir } from "node:os"
import {
  Config as ConfigSchema,
  ConfigError,
  type Config as AppConfig,
  type SmbConfig,
} from "@pwe/shared"

export type RuntimeSmbConfig = Omit<SmbConfig, "path"> & {
  path: string
}

export type RuntimeStorageConfig = {
  mode: "local" | "mounted_share"
  smb: RuntimeSmbConfig | null
}

export type RuntimeConfig = Omit<AppConfig, "storage"> & {
  storage: RuntimeStorageConfig
}

export class Config extends Context.Tag("Config")<Config, RuntimeConfig>() {}

const expandHome = (p: string): string =>
  p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p)

const withStorageDefaults = (decoded: AppConfig): RuntimeConfig => {
  const smb = decoded.storage?.smb
    ? {
        ...decoded.storage.smb,
        path: decoded.storage.smb.path ?? "",
      }
    : null

  return {
    ...decoded,
    storage: {
      mode: decoded.storage?.mode ?? "local",
      smb,
    },
  }
}

const decodeConfig = Schema.decodeUnknown(ConfigSchema)

export const loadConfig = (configPath: string): Effect.Effect<RuntimeConfig, ConfigError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () => readFile(configPath, "utf-8"),
      catch: (e) =>
        new ConfigError({
          path: configPath,
          reason: `Cannot read config file: ${e instanceof Error ? e.message : String(e)}`,
        }),
    })

    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (e) =>
        new ConfigError({
          path: configPath,
          reason: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
        }),
    })

    const decoded = yield* decodeConfig(parsed).pipe(
      Effect.mapError(
        (e) =>
          new ConfigError({
            path: configPath,
            reason: `Schema validation failed: ${e.message}`,
          })
      )
    )

    const hydrated = withStorageDefaults(decoded)

    return {
      ...hydrated,
      paths: {
        ...hydrated.paths,
        data_root: expandHome(hydrated.paths.data_root),
      },
      mpv: {
        ...hydrated.mpv,
        binary_path: hydrated.mpv.binary_path.startsWith("/")
          ? hydrated.mpv.binary_path
          : hydrated.mpv.binary_path,
        ipc_socket: expandHome(hydrated.mpv.ipc_socket),
      },
      steam: {
        ...hydrated.steam,
        steamcmd_path: hydrated.steam.steamcmd_path,
      },
    }
  })

export const ConfigLive = (configPath: string): Layer.Layer<Config, ConfigError> =>
  Layer.effect(Config, loadConfig(configPath))
