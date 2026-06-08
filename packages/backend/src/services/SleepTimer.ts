import { Context, Effect, Layer, Ref } from "effect"
import { Logger } from "./Logger.js"
import { PlayerPower } from "./PlayerPower.js"
import { Rotation } from "./Rotation.js"

export interface SleepStatus {
  readonly active: boolean
  readonly deadline: number | null // epoch ms when the display turns off
}

export interface SleepTimerImpl {
  readonly set: (minutes: number) => Effect.Effect<SleepStatus>
  readonly cancel: () => Effect.Effect<SleepStatus>
  readonly status: () => Effect.Effect<SleepStatus>
}

export class SleepTimer extends Context.Tag("SleepTimer")<SleepTimer, SleepTimerImpl>() {}

export const SleepTimerLive = Layer.scoped(
  SleepTimer,
  Effect.gen(function* () {
    const logger = yield* Logger
    const playerPower = yield* PlayerPower
    const rotation = yield* Rotation

    const timerRef = yield* Ref.make<ReturnType<typeof setTimeout> | null>(null)
    const deadlineRef = yield* Ref.make<number | null>(null)

    const clear = Effect.gen(function* () {
      const t = yield* Ref.get(timerRef)
      if (t) clearTimeout(t)
      yield* Ref.set(timerRef, null)
      yield* Ref.set(deadlineRef, null)
    })

    const status = (): Effect.Effect<SleepStatus> =>
      Effect.gen(function* () {
        const deadline = yield* Ref.get(deadlineRef)
        return { active: deadline !== null, deadline }
      })

    // On elapse: stop rotation, then power the display off. Fall back to a plain
    // stop when display commands are not configured.
    const onElapsed = Effect.gen(function* () {
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

    yield* Effect.addFinalizer(() => clear)

    return {
      set: (minutes) =>
        Effect.gen(function* () {
          yield* clear
          if (minutes <= 0) return yield* status()
          const ms = minutes * 60_000
          const deadline = Date.now() + ms
          const timer = setTimeout(() => {
            Effect.runFork(onElapsed)
          }, ms)
          ;(timer as { unref?: () => void }).unref?.()
          yield* Ref.set(timerRef, timer)
          yield* Ref.set(deadlineRef, deadline)
          return yield* status()
        }),
      cancel: () =>
        Effect.gen(function* () {
          yield* clear
          return yield* status()
        }),
      status,
    }
  })
)
