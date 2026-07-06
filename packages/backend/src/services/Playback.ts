import { Context, Effect, Layer, Ref } from "effect"
import type {
  DbError,
  DisplayError,
  LibraryNotFoundError,
  MpvIpcError,
  PlayMode,
  StorageError,
} from "@pwe/shared"
import { Logger } from "./Logger.js"
import { PlayerPower, type PowerOnResult } from "./PlayerPower.js"
import { Rotation } from "./Rotation.js"

export interface SleepStatus {
  readonly active: boolean
  readonly deadline: number | null // epoch ms when the display turns off
}

// Playback orchestration (ADR 0009): the single owner of the rotation linkage
// around every play/stop-ish intent.
export interface PlaybackImpl {
  readonly play: (
    workshopId: string
  ) => Effect.Effect<
    { readonly ok: true; readonly path: string },
    DbError | LibraryNotFoundError | MpvIpcError | StorageError
  >
  readonly stop: () => Effect.Effect<{ readonly ok: true }, MpvIpcError>
  readonly displayOff: () => Effect.Effect<
    { readonly ok: true; readonly state: "off" },
    DisplayError | MpvIpcError
  >
  readonly displayOn: () => Effect.Effect<PowerOnResult, DisplayError>
  readonly next: () => Effect.Effect<void, DbError>
  readonly prev: () => Effect.Effect<void, DbError>
  readonly setMode: (mode: PlayMode) => Effect.Effect<void, DbError>
  readonly setRotationInterval: (sec: number) => Effect.Effect<void, DbError>
  readonly sleep: (minutes: number) => Effect.Effect<SleepStatus>
  readonly sleepStatus: () => Effect.Effect<SleepStatus>
}

export class Playback extends Context.Tag("Playback")<Playback, PlaybackImpl>() {}

export const PlaybackLive = Layer.scoped(
  Playback,
  Effect.gen(function* () {
    const logger = yield* Logger
    const playerPower = yield* PlayerPower
    const rotation = yield* Rotation

    const timerRef = yield* Ref.make<ReturnType<typeof setTimeout> | null>(null)
    const deadlineRef = yield* Ref.make<number | null>(null)

    const clearSleep = Effect.gen(function* () {
      const t = yield* Ref.get(timerRef)
      if (t) clearTimeout(t)
      yield* Ref.set(timerRef, null)
      yield* Ref.set(deadlineRef, null)
    })

    const sleepStatus = (): Effect.Effect<SleepStatus> =>
      Effect.gen(function* () {
        const deadline = yield* Ref.get(deadlineRef)
        return { active: deadline !== null, deadline }
      })

    // On elapse: stop rotation, then power the display off. Fall back to a plain
    // stop when display commands are not configured.
    const onSleepElapsed = Effect.gen(function* () {
      yield* Ref.set(timerRef, null)
      yield* Ref.set(deadlineRef, null)
      yield* rotation.disarm()
      yield* playerPower
        .displayOff()
        .pipe(Effect.catchAll(() => playerPower.stopForIdle().pipe(Effect.asVoid)))
    }).pipe(
      Effect.catchAll((e) =>
        logger.warn(`Sleep timer action failed: ${String(e)}`).pipe(Effect.ignore)
      )
    )

    yield* Effect.addFinalizer(() => clearSleep)

    return {
      play: (workshopId) =>
        Effect.gen(function* () {
          const result = yield* playerPower.play(workshopId)
          // Best-effort: a play succeeds even if arming rotation hiccups.
          yield* rotation.arm(workshopId).pipe(Effect.catchAll(() => Effect.void))
          return result
        }),

      stop: () =>
        Effect.gen(function* () {
          yield* rotation.disarm()
          return yield* playerPower.stopForIdle()
        }),

      displayOff: () =>
        Effect.gen(function* () {
          yield* rotation.disarm()
          return yield* playerPower.displayOff()
        }),

      // Deliberately no rotation.arm after restore (ADR 0009 preserved behavior).
      displayOn: () => playerPower.displayOn(),

      next: () => rotation.next(),
      prev: () => rotation.prev(),
      setMode: (mode) => rotation.setMode(mode),
      setRotationInterval: (sec) => rotation.setInterval(sec),

      sleep: (minutes) =>
        Effect.gen(function* () {
          yield* clearSleep
          if (minutes <= 0) return yield* sleepStatus()
          const ms = minutes * 60_000
          const deadline = Date.now() + ms
          const timer = setTimeout(() => {
            Effect.runFork(onSleepElapsed)
          }, ms)
          ;(timer as { unref?: () => void }).unref?.()
          yield* Ref.set(timerRef, timer)
          yield* Ref.set(deadlineRef, deadline)
          return yield* sleepStatus()
        }),

      sleepStatus,
    }
  })
)
