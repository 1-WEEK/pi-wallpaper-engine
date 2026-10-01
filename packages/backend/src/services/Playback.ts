import { Context, Effect, Layer, Ref, Stream } from "effect"
import type {
  DbError,
  DisplayError,
  LibraryNotFoundError,
  MpvIpcError,
  PlayMode,
  StorageError,
} from "@pwe/shared"
import { Logger } from "./Logger.js"
import { PlaybackPrefs, clampPlayLimitMinutes } from "./PlaybackPrefs.js"
import { PlayerPower, type PowerOnResult } from "./PlayerPower.js"
import { Rotation } from "./Rotation.js"

export interface SleepStatus {
  readonly active: boolean
  readonly deadline: number | null // epoch ms when the display turns off
}

/**
 * The durable "stop playback after N minutes" policy as the orchestrator sees
 * it: the stored setting plus the deadline the CURRENT playback session is
 * counting down to.
 *
 * The limit is armed per playback SESSION, not per wallpaper: it starts when a
 * session begins and is deliberately NOT re-armed by pause/next/prev, so a
 * session can actually reach its end (otherwise rotating every N minutes would
 * push the deadline out forever). It survives rotation ticks for free — the
 * rotation timer calls mpv directly and never re-enters this module.
 */
export interface PlayLimitStatus {
  readonly minutes: number
  readonly deadline: number | null // epoch ms when playback auto-stops
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
  readonly setPlayLimit: (minutes: number) => Effect.Effect<void, DbError>
  readonly playLimitStatus: () => Effect.Effect<PlayLimitStatus>
}

export class Playback extends Context.Service<Playback, PlaybackImpl>()("Playback") {}

export const PlaybackLive = Layer.effect(
  Playback,
  Effect.gen(function* () {
    const logger = yield* Logger
    const playerPower = yield* PlayerPower
    const rotation = yield* Rotation
    const prefs = yield* PlaybackPrefs

    const timerRef = yield* Ref.make<Timer | null>(null)
    const deadlineRef = yield* Ref.make<number | null>(null)
    // Play limit: armed per playback session, separate from the one-shot sleep.
    const limitTimerRef = yield* Ref.make<Timer | null>(null)
    const limitDeadlineRef = yield* Ref.make<number | null>(null)

    const clearPlayLimit = Effect.gen(function* () {
      const pending = yield* Ref.get(limitTimerRef)
      if (pending) clearTimeout(pending)
      yield* Ref.set(limitTimerRef, null)
      yield* Ref.set(limitDeadlineRef, null)
    })

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

    // The stop recipe shared by the sleep timer and the play limit: disarm the
    // sequence, then power the display off, falling back to a plain stop when
    // display commands are not configured. Both timers racing to the same
    // deadline must land on the same effect.
    const stopPlayback = Effect.gen(function* () {
      yield* rotation.disarm()
      yield* playerPower
        .displayOff()
        .pipe(Effect.catch(() => playerPower.stopForIdle().pipe(Effect.asVoid)))
    })

    // On elapse: stop rotation, then power the display off. Fall back to a plain
    // stop when display commands are not configured.
    const onSleepElapsed = Effect.gen(function* () {
      yield* Ref.set(timerRef, null)
      yield* Ref.set(deadlineRef, null)
      // Whichever of the two deadlines lands first owns the shutdown; the other
      // must not stay armed and keep reporting "active".
      yield* clearPlayLimit
      yield* stopPlayback
    }).pipe(
      Effect.catch((e) =>
        logger.warn(`Sleep timer action failed: ${String(e)}`).pipe(Effect.ignore)
      )
    )

    // prefs.get() reads a Ref and only fails on a DB read at boot, but the type
    // carries DbError; every caller here wants the same conservative fallback
    // (no limit, single loop) rather than an error path through a timer.
    const readPrefs = () =>
      prefs.get().pipe(
        Effect.catch(() =>
          Effect.succeed({
            play_mode: "single" as const,
            rotation_interval_sec: 600,
            play_limit_minutes: 0,
          })
        )
      )

    const playLimitStatus = (): Effect.Effect<PlayLimitStatus> =>
      Effect.gen(function* () {
        const { play_limit_minutes } = yield* readPrefs()
        return { minutes: play_limit_minutes, deadline: yield* Ref.get(limitDeadlineRef) }
      })

    // Arm the limit for a NEW playback session. Never called by pause/next/prev:
    // re-arming on every wallpaper change would push the deadline out forever
    // and the limit would never fire.
    const armPlayLimit = Effect.gen(function* () {
      yield* clearPlayLimit
      const { play_limit_minutes } = yield* readPrefs()
      // Clamp here as well as at the store: an already-persisted row can hold
      // a value written before the ceiling existed, and a duration above the
      // platform timer ceiling fires *immediately* rather than never.
      const minutes = clampPlayLimitMinutes(play_limit_minutes)
      if (minutes <= 0) return
      const ms = minutes * 60_000
      const deadline = Date.now() + ms
      const timer = setTimeout(() => {
        Effect.runFork(onPlayLimitElapsed)
      }, ms)
      timer.unref()
      yield* Ref.set(limitTimerRef, timer)
      yield* Ref.set(limitDeadlineRef, deadline)
      yield* logger.info(`Play limit armed: ${minutes}m`)
    })

    const onPlayLimitElapsed = Effect.gen(function* () {
      yield* Ref.set(limitTimerRef, null)
      yield* Ref.set(limitDeadlineRef, null)
      // Symmetric with the sleep timer: the loser of the race is disarmed so the
      // summary never reports a deadline for a session that has already stopped.
      yield* clearSleep
      yield* stopPlayback
    }).pipe(
      Effect.catch((e) =>
        logger.warn(`Play limit action failed: ${String(e)}`).pipe(Effect.ignore)
      )
    )

    // Either timer elapsing ends the playback session, so an explicit stop drops
    // the limit too — a later play re-arms it from zero.
    const clearSessionTimers = Effect.all([clearPlayLimit, clearSleep], {
      discard: true,
    })

    yield* Effect.addFinalizer(() => clearSleep)
    yield* Effect.addFinalizer(() => clearPlayLimit)

    // Ticket 01 (media-root recovery): PlayerPower restores a wallpaper on its
    // own when the media root comes back (a file that vanished mid-playback, or
    // a startup restore that aborted). Rotation linkage stays owned here, per
    // ADR 0009, so this is the one place that observes those restores and arms
    // the sequence on them — the same thing `displayOn` does explicitly.
    yield* Effect.forkScoped(
      playerPower
        .recovered()
        .pipe(
          Stream.mapEffect((workshopId) =>
            rotation.arm(workshopId).pipe(
              Effect.tap(() => logger.info(`Armed rotation on recovered wallpaper ${workshopId}`)),
              Effect.catch(() => Effect.void)
            )
          ),
          Stream.runDrain
        )
        .pipe(
          Effect.catchCause((cause) =>
            logger.error(`Recovery rotation arm loop failed: ${String(cause)}`)
          )
        )
    )

    return {
      play: (workshopId) =>
        Effect.gen(function* () {
          const result = yield* playerPower.play(workshopId)
          // Best-effort: a play succeeds even if arming rotation hiccups.
          yield* rotation.arm(workshopId).pipe(Effect.catch(() => Effect.void))
          // A play starts a new session, so the limit is armed from zero here —
          // and only here (plus display-on restore below).
          yield* armPlayLimit.pipe(Effect.catch(() => Effect.void))
          return result
        }),

      stop: () =>
        Effect.gen(function* () {
          yield* clearSessionTimers
          yield* rotation.disarm()
          return yield* playerPower.stopForIdle()
        }),

      displayOff: () =>
        Effect.gen(function* () {
          yield* clearSessionTimers
          yield* rotation.disarm()
          return yield* playerPower.displayOff()
        }),

      displayOn: () =>
        Effect.gen(function* () {
          const { restored_workshop_id, ...result } = yield* playerPower.displayOn()
          // Re-arm rotation on the restored wallpaper (ADR 0009 follow-up,
          // signed off 2026-07-06). Best-effort, like arming after play.
          if (result.restored && restored_workshop_id) {
            yield* rotation.arm(restored_workshop_id).pipe(Effect.catch(() => Effect.void))
            yield* armPlayLimit.pipe(Effect.catch(() => Effect.void))
          }
          return result
        }),

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
      // The status is read through prefs + the live deadline on every call, so
      // this reads the setting rather than a cached copy.
      playLimitStatus,
      setPlayLimit: (minutes) =>
        Effect.gen(function* () {
          yield* prefs.setPlayLimit(minutes)
          // Turning the limit off (or changing it) applies from now on, not to a
          // session already running: an in-flight deadline keeps its original
          // value, which is what the UI is already counting down. Clear it only
          // when the setting is switched off, so "off" cannot strand a live
          // deadline in the summary.
          if (minutes <= 0) yield* clearPlayLimit
        }),
    }
  })
)
