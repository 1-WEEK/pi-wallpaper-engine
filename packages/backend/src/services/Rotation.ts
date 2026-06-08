import { Context, Effect, Layer, Ref } from "effect"
import { DbError, isAdultContent } from "@pwe/shared"
import type { PlayMode } from "@pwe/shared"
import { Library } from "./Library.js"
import { Logger } from "./Logger.js"
import { Mpv } from "./Mpv.js"
import { PlaybackPrefs } from "./PlaybackPrefs.js"

// --- Pure helpers (unit-tested in Day 4) ---

// Fisher-Yates shuffle into a new array. rng is injectable for deterministic tests.
export const shuffleSequence = <T>(items: readonly T[], rng: () => number = Math.random): T[] => {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const a = arr[i]!
    const b = arr[j]!
    arr[i] = b
    arr[j] = a
  }
  return arr
}

export const buildSequence = (
  ids: readonly string[],
  mode: PlayMode,
  rng?: () => number
): string[] => (mode === "shuffle" ? shuffleSequence(ids, rng) : [...ids])

// Advance an index with wraparound. Returns -1 for an empty sequence.
export const advanceIndex = (current: number, len: number, dir: 1 | -1): number => {
  if (len <= 0) return -1
  return (((current + dir) % len) + len) % len
}

const MIN_INTERVAL_SEC = 5

export interface RotationImpl {
  // Build the sequence for the current mode, anchor it on the given wallpaper,
  // and start the interval timer (no-op timer when mode is "single").
  readonly arm: (fromWorkshopId: string) => Effect.Effect<void, DbError>
  readonly next: () => Effect.Effect<void, DbError>
  readonly prev: () => Effect.Effect<void, DbError>
  readonly setMode: (mode: PlayMode) => Effect.Effect<void, DbError>
  readonly disarm: () => Effect.Effect<void>
}

export class Rotation extends Context.Tag("Rotation")<Rotation, RotationImpl>() {}

export const RotationLive = Layer.scoped(
  Rotation,
  Effect.gen(function* () {
    const library = yield* Library
    const logger = yield* Logger
    const mpv = yield* Mpv
    const prefs = yield* PlaybackPrefs

    const seqRef = yield* Ref.make<string[]>([])
    const idxRef = yield* Ref.make<number>(-1)
    const timerRef = yield* Ref.make<ReturnType<typeof setInterval> | null>(null)

    const logWarn = (m: string) => logger.warn(m).pipe(Effect.ignore)

    const clearTimer = Effect.gen(function* () {
      const t = yield* Ref.get(timerRef)
      if (t) clearInterval(t)
      yield* Ref.set(timerRef, null)
    })

    // Load the wallpaper at startIdx; if it is missing on disk, keep advancing in
    // `dir` until one plays or the whole sequence is exhausted.
    const playAt = (startIdx: number, dir: 1 | -1): Effect.Effect<void, DbError> =>
      Effect.gen(function* () {
        const seq = yield* Ref.get(seqRef)
        if (seq.length === 0) return
        let idx = startIdx
        for (let attempts = 0; attempts < seq.length; attempts++) {
          const id = seq[idx]
          if (id === undefined) {
            idx = advanceIndex(idx, seq.length, dir)
            continue
          }
          const item = yield* library.get(id).pipe(Effect.catchAll(() => Effect.succeed(null)))
          const path = item
            ? yield* library.playablePath(item).pipe(Effect.catchAll(() => Effect.succeed(null)))
            : null
          if (item && path) {
            yield* mpv
              .play(item.workshop_id, path)
              .pipe(Effect.catchAll((e) => logWarn(`Rotation play failed: ${String(e)}`)))
            yield* mpv.setDisplayMode(item.display_mode).pipe(Effect.ignore)
            yield* library.update(item.workshop_id, { last_played_at: Date.now() }).pipe(Effect.ignore)
            yield* Ref.set(idxRef, idx)
            return
          }
          idx = advanceIndex(idx, seq.length, dir)
        }
        yield* logWarn("Rotation: no playable wallpaper in the sequence")
      })

    const startTimer = (intervalSec: number) =>
      Effect.gen(function* () {
        yield* clearTimer
        const ms = Math.max(MIN_INTERVAL_SEC, intervalSec) * 1000
        const timer = setInterval(() => {
          Effect.runFork(
            Effect.gen(function* () {
              const seq = yield* Ref.get(seqRef)
              const cur = yield* Ref.get(idxRef)
              const nextIdx = advanceIndex(cur, seq.length, 1)
              if (nextIdx < 0) return
              yield* playAt(nextIdx, 1)
            }).pipe(Effect.catchAll((e) => logWarn(`Rotation tick failed: ${String(e)}`)))
          )
        }, ms)
        ;(timer as { unref?: () => void }).unref?.()
        yield* Ref.set(timerRef, timer)
      })

    // Build a sequence from the live library, anchored on `anchorId` when present.
    const rebuild = (mode: PlayMode, anchorId: string | null) =>
      Effect.gen(function* () {
        const rows = yield* library.list()
        // Rotation never auto-plays adult wallpapers: exclude them from the
        // sequence so an unattended rotation can't surface hidden content.
        const ids = rows
          .filter(
            (r) =>
              !isAdultContent({
                title: r.title,
                contentRating: r.content_rating,
                ratingSex: r.rating_sex,
              })
          )
          .map((r) => r.workshop_id)
        const seq = buildSequence(ids, mode)
        const at = anchorId ? seq.indexOf(anchorId) : -1
        yield* Ref.set(seqRef, seq)
        yield* Ref.set(idxRef, at >= 0 ? at : -1)
      })

    const ensureSequence = Effect.gen(function* () {
      const seq = yield* Ref.get(seqRef)
      if (seq.length > 0) return
      const { play_mode } = yield* prefs.get()
      // Manual next/prev should work even in single mode: fall back to sequential.
      const effectiveMode: PlayMode = play_mode === "shuffle" ? "shuffle" : "sequential"
      const status = yield* mpv.status()
      yield* rebuild(effectiveMode, status.current_workshop_id)
    })

    const step = (dir: 1 | -1) =>
      Effect.gen(function* () {
        yield* ensureSequence
        const seq = yield* Ref.get(seqRef)
        if (seq.length === 0) return
        // Anchor on the wallpaper actually on screen so manual next/prev always
        // continues from it, even after a single-mode play left idxRef stale.
        const status = yield* mpv.status()
        const anchorIdx = status.current_workshop_id
          ? seq.indexOf(status.current_workshop_id)
          : -1
        const cur = anchorIdx >= 0 ? anchorIdx : yield* Ref.get(idxRef)
        const start = cur < 0 ? (dir === 1 ? 0 : seq.length - 1) : advanceIndex(cur, seq.length, dir)
        yield* playAt(start, dir)
        const { play_mode, rotation_interval_sec } = yield* prefs.get()
        if (play_mode !== "single") yield* startTimer(rotation_interval_sec)
      })

    yield* Effect.addFinalizer(() => clearTimer)

    return {
      arm: (fromWorkshopId) =>
        Effect.gen(function* () {
          const { play_mode, rotation_interval_sec } = yield* prefs.get()
          if (play_mode === "single") {
            yield* clearTimer
            return
          }
          yield* rebuild(play_mode, fromWorkshopId)
          yield* startTimer(rotation_interval_sec)
        }),

      next: () => step(1),
      prev: () => step(-1),

      setMode: (mode) =>
        Effect.gen(function* () {
          yield* prefs.setMode(mode)
          if (mode === "single") {
            yield* clearTimer
            return
          }
          const status = yield* mpv.status()
          yield* rebuild(mode, status.current_workshop_id)
          const { rotation_interval_sec } = yield* prefs.get()
          yield* startTimer(rotation_interval_sec)
        }),

      disarm: () => clearTimer,
    }
  })
)
