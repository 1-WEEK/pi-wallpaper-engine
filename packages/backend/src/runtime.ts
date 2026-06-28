import { Effect, Layer, ManagedRuntime } from "effect"
import { ConfigLive, Config as ConfigTag } from "./services/Config.js"
import { DbLive } from "./services/Db.js"
import { DisplayLive } from "./services/Display.js"
import { DownloadIntakeLive } from "./services/DownloadIntake.js"
import { DownloadProcessRegistryLive } from "./services/DownloadProcessRegistry.js"
import { DownloadReconcilerLive } from "./services/DownloadReconciler.js"
import { DownloadTasksLive } from "./services/DownloadTasks.js"
import { LibraryLive } from "./services/Library.js"
import { LoggerLive } from "./services/Logger.js"
import { MigrateLive } from "./services/Migrate.js"
import { MpvLive } from "./services/Mpv.js"
import { PlaybackPrefsLive } from "./services/PlaybackPrefs.js"
import { PlayerPowerLive } from "./services/PlayerPower.js"
import { RotationLive } from "./services/Rotation.js"
import { SleepTimerLive } from "./services/SleepTimer.js"
import { PlayerStateLive } from "./services/PlayerState.js"
import { PlayerWatchLive } from "./services/PlayerWatch.js"
import { SteamCmdLive } from "./services/SteamCmd.js"
import { SteamWorkshopLive } from "./services/SteamWorkshop.js"
import { StorageLive } from "./services/Storage.js"
import { TranscodeMonitorLive } from "./services/TranscodeMonitor.js"
import { TranscodeQueueLive, TranscodeQueueNoop } from "./services/TranscodeQueue.js"

/**
 * Pick the transcode queue mode from the operator's environment.
 *
 * `PWE_WORKER_API_KEY` is the same signal that gates `/api/transcode/*` mount
 * in index.ts — using one switch for both keeps backend-only deploys clean.
 * With the key set: Live queue + routes mounted, ready for a Worker.
 * Without it: Noop queue (downloads mark `transcode_status='skipped'`) and
 * routes unmounted, so the Pi works fine even with no Worker in sight.
 */
export const transcodeMode = (): "live" | "noop" => {
  const key = process.env["PWE_WORKER_API_KEY"]
  return key && key.length >= 8 ? "live" : "noop"
}

/**
 * Build the application layer. Order matters here — we provide leaves
 * (Config, Logger) last in the chain because `.pipe(Layer.provideMerge(X))`
 * means "X provides for the layer above it." Each step adds a service whose
 * dependencies have already been declared earlier.
 */
export const buildLayer = (configPath: string) => {
  const queueLayer = transcodeMode() === "live" ? TranscodeQueueLive : TranscodeQueueNoop
  const applicationLayer = TranscodeMonitorLive.pipe(
    Layer.provideMerge(DownloadIntakeLive),
    Layer.provideMerge(queueLayer),
    Layer.provideMerge(SleepTimerLive),
    Layer.provideMerge(PlayerWatchLive),
    Layer.provideMerge(RotationLive),
    Layer.provideMerge(PlayerPowerLive),
    Layer.provideMerge(PlayerStateLive),
    Layer.provideMerge(PlaybackPrefsLive),
    Layer.provideMerge(DownloadReconcilerLive),
    Layer.provideMerge(DownloadTasksLive)
  )

  return applicationLayer.pipe(
    Layer.provideMerge(MigrateLive),
    Layer.provideMerge(LibraryLive),
    Layer.provideMerge(DisplayLive),
    Layer.provideMerge(SteamCmdLive),
    Layer.provideMerge(DownloadProcessRegistryLive),
    Layer.provideMerge(StorageLive(configPath)),
    Layer.provideMerge(DbLive),
    Layer.provideMerge(MpvLive),
    Layer.provideMerge(SteamWorkshopLive),
    Layer.provideMerge(LoggerLive),
    Layer.provideMerge(ConfigLive(configPath))
  )
}

export const makeRuntime = (configPath: string) => ManagedRuntime.make(buildLayer(configPath))

export type AppRuntime = ReturnType<typeof makeRuntime>

// The full service context the runtime provides, recovered by inference so the
// large service union never has to be hand-written. Route helpers pin an
// effect's R channel to this so `runtime.runPromise` accepts it (a free generic
// R can't be proven to be a subset of the context).
export type AppContext =
  AppRuntime extends ManagedRuntime.ManagedRuntime<infer R, infer _E> ? R : never

export const getConfig = (runtime: AppRuntime) =>
  runtime.runPromise(Effect.flatMap(ConfigTag, (c) => Effect.succeed(c)))
