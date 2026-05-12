import { Context, Effect, Layer, Schema } from "effect"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { homedir } from "node:os"
import { Config as ConfigSchema, ConfigError } from "@pwe/shared"

export class Config extends Context.Tag("Config")<Config, ConfigSchema>() {}

const expandHome = (p: string): string =>
  p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p)

const decodeConfig = Schema.decodeUnknown(ConfigSchema)

export const loadConfig = (configPath: string): Effect.Effect<ConfigSchema, ConfigError> =>
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

    return {
      ...decoded,
      paths: {
        ...decoded.paths,
        data_root: expandHome(decoded.paths.data_root),
      },
      mpv: {
        ...decoded.mpv,
        binary_path: decoded.mpv.binary_path.startsWith("/")
          ? decoded.mpv.binary_path
          : decoded.mpv.binary_path,
        ipc_socket: expandHome(decoded.mpv.ipc_socket),
      },
      steam: {
        ...decoded.steam,
        steamcmd_path: decoded.steam.steamcmd_path,
      },
    }
  })

export const ConfigLive = (configPath: string): Layer.Layer<Config, ConfigError> =>
  Layer.effect(Config, loadConfig(configPath))
