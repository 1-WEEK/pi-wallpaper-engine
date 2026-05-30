import { Effect, Layer, ManagedRuntime } from "effect"
import { ConfigLive, Config as ConfigTag } from "./services/Config.js"
import { DbLive } from "./services/Db.js"
import { DisplayLive } from "./services/Display.js"
import { DownloadTasksLive } from "./services/DownloadTasks.js"
import { LibraryLive } from "./services/Library.js"
import { LoggerLive } from "./services/Logger.js"
import { MigrateLive } from "./services/Migrate.js"
import { MpvLive } from "./services/Mpv.js"
import { PlayerPowerLive } from "./services/PlayerPower.js"
import { PlayerStateLive } from "./services/PlayerState.js"
import { SteamCmdLive } from "./services/SteamCmd.js"
import { SteamWorkshopLive } from "./services/SteamWorkshop.js"
import { StorageLive } from "./services/Storage.js"
import { TranscodeMonitorLive } from "./services/TranscodeMonitor.js"
import { TranscodeQueueLive } from "./services/TranscodeQueue.js"

/**
 * Build the application layer. Order matters here — we provide leaves
 * (Config, Logger) last in the chain because `.pipe(Layer.provideMerge(X))`
 * means "X provides for the layer above it." Each step adds a service whose
 * dependencies have already been declared earlier.
 *
 * Phase 2 transcoding is live: TranscodeQueueLive enqueues real jobs, and
 * TranscodeMonitorLive forks a 30s reaper to reset stale claimed/running rows.
 * Operators must run a Worker container against /api/transcode/* — otherwise
 * pending jobs sit forever.
 */
export const buildLayer = (configPath: string) =>
  TranscodeMonitorLive.pipe(
    Layer.provideMerge(TranscodeQueueLive),
    Layer.provideMerge(PlayerPowerLive),
    Layer.provideMerge(PlayerStateLive),
    Layer.provideMerge(DownloadTasksLive),
    Layer.provideMerge(MigrateLive),
    Layer.provideMerge(LibraryLive),
    Layer.provideMerge(DisplayLive),
    Layer.provideMerge(SteamCmdLive),
    Layer.provideMerge(StorageLive(configPath)),
    Layer.provideMerge(DbLive),
    Layer.provideMerge(MpvLive),
    Layer.provideMerge(SteamWorkshopLive),
    Layer.provideMerge(LoggerLive),
    Layer.provideMerge(ConfigLive(configPath))
  )

export const makeRuntime = (configPath: string) => ManagedRuntime.make(buildLayer(configPath))

export type AppRuntime = ReturnType<typeof makeRuntime>

export const getConfig = (runtime: AppRuntime) =>
  runtime.runPromise(Effect.flatMap(ConfigTag, (c) => Effect.succeed(c)))
