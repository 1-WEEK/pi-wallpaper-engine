import { Context, Effect, Layer, PubSub, Ref, Schedule, Stream } from "effect"
import type { PlayMode } from "@pwe/shared"
import { Library } from "./Library.js"
import { Logger } from "./Logger.js"
import { Mpv, type PlayerStatus } from "./Mpv.js"
import { PlaybackPrefs } from "./PlaybackPrefs.js"

export interface PlayerSnapshot extends PlayerStatus {
  readonly current_title: string | null
  readonly current_preview_url: string | null
  readonly current_resolution: string | null
  readonly current_codec: string | null
  readonly play_mode: PlayMode
  readonly rotation_interval_sec: number
}

export interface PlayerWatchImpl {
  readonly current: () => Effect.Effect<PlayerSnapshot>
  readonly stream: () => Stream.Stream<PlayerSnapshot>
}

export class PlayerWatch extends Context.Tag("PlayerWatch")<PlayerWatch, PlayerWatchImpl>() {}

const snapshotsEqual = (a: PlayerSnapshot, b: PlayerSnapshot): boolean =>
  a.playing === b.playing &&
  a.current_workshop_id === b.current_workshop_id &&
  a.path === b.path &&
  a.display_mode === b.display_mode &&
  a.current_title === b.current_title &&
  a.current_preview_url === b.current_preview_url &&
  a.current_resolution === b.current_resolution &&
  a.current_codec === b.current_codec &&
  a.play_mode === b.play_mode &&
  a.rotation_interval_sec === b.rotation_interval_sec

const buildSnapshot = (
  mpv: Context.Tag.Service<Mpv>,
  library: Context.Tag.Service<Library>,
  prefs: Context.Tag.Service<PlaybackPrefs>
): Effect.Effect<PlayerSnapshot> =>
  Effect.gen(function* () {
    const status = yield* mpv.status()
    const item = status.current_workshop_id
      ? yield* library.get(status.current_workshop_id).pipe(
          Effect.catchAll(() => Effect.succeed(null))
        )
      : null
    const prefsState = yield* prefs.get().pipe(
      Effect.catchAll(() =>
        Effect.succeed({ play_mode: "single" as const, rotation_interval_sec: 600 })
      )
    )
    return {
      ...status,
      current_title: item?.title ?? null,
      current_preview_url: item?.preview_url || null,
      current_resolution:
        item?.transcoded_resolution ?? item?.source_resolution ?? null,
      current_codec: item?.transcoded_codec ?? item?.source_codec ?? null,
      play_mode: prefsState.play_mode,
      rotation_interval_sec: prefsState.rotation_interval_sec,
    }
  })

// 1Hz is the cadence that feels live for play/pause/stop toggles without
// burning IPC on a Pi. Mpv.status() reads a Ref so this is cheap, and the
// equality gate ensures the PubSub only fires when something actually changed.
const TICK = Schedule.spaced("1 second")

export const PlayerWatchLive = Layer.scoped(
  PlayerWatch,
  Effect.gen(function* () {
    const mpv = yield* Mpv
    const library = yield* Library
    const logger = yield* Logger
    const prefs = yield* PlaybackPrefs
    const pubsub = yield* PubSub.unbounded<PlayerSnapshot>()
    const lastRef = yield* Ref.make<PlayerSnapshot | null>(null)

    const tick = Effect.gen(function* () {
      const snap = yield* buildSnapshot(mpv, library, prefs)
      const last = yield* Ref.get(lastRef)
      if (last && snapshotsEqual(last, snap)) return
      yield* Ref.set(lastRef, snap)
      yield* pubsub.publish(snap)
    }).pipe(
      Effect.catchAllCause((cause) =>
        logger.warn(`PlayerWatch tick failed: ${String(cause)}`)
      )
    )

    // Seed the Ref so the first /watch subscriber sees current state even if
    // mpv has been idle since boot and the polling loop has not fired yet.
    yield* tick

    yield* Effect.forkScoped(
      tick.pipe(
        Effect.repeat(TICK),
        Effect.ensuring(logger.info("PlayerWatch stopped"))
      )
    )
    yield* logger.info("PlayerWatch started (1s tick)")

    return {
      current: () =>
        Effect.gen(function* () {
          const last = yield* Ref.get(lastRef)
          if (last) return last
          return yield* buildSnapshot(mpv, library, prefs)
        }),
      stream: () => Stream.fromPubSub(pubsub),
    }
  })
)
