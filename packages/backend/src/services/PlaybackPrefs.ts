import { Context, Effect, Layer, Ref } from "effect"
import { DbError } from "@pwe/shared"
import type { PlayMode } from "@pwe/shared"
import { Db } from "./Db.js"

export interface PlaybackPrefsState {
  readonly play_mode: PlayMode
  readonly rotation_interval_sec: number
  readonly play_limit_minutes: number
}

// Defaults match the 001_init.sql column defaults, returned when no row exists
// yet so callers never have to special-case a fresh database. A play limit of 0
// means "no limit" — the feature is opt-in and off until the administrator
// turns it on in Settings.
const DEFAULT_PREFS: PlaybackPrefsState = {
  play_mode: "single",
  rotation_interval_sec: 600,
  play_limit_minutes: 0,
}

export interface PlaybackPrefsImpl {
  readonly get: () => Effect.Effect<PlaybackPrefsState, DbError>
  readonly setMode: (mode: PlayMode) => Effect.Effect<void, DbError>
  readonly setInterval: (sec: number) => Effect.Effect<void, DbError>
  readonly setPlayLimit: (minutes: number) => Effect.Effect<void, DbError>
}

export class PlaybackPrefs extends Context.Service<
  PlaybackPrefs,
  PlaybackPrefsImpl
>()("PlaybackPrefs") {}

interface PrefsRow {
  readonly play_mode: PlayMode
  readonly rotation_interval_sec: number
  readonly play_limit_minutes: number
}

export const PlaybackPrefsLive = Layer.effect(
  PlaybackPrefs,
  Effect.gen(function* () {
    const db = yield* Db

    const readDb = (): Effect.Effect<PlaybackPrefsState, DbError> =>
      Effect.gen(function* () {
        const row = yield* db.queryOne<PrefsRow>(
          `SELECT play_mode, rotation_interval_sec, play_limit_minutes
           FROM playback_prefs
           WHERE id = 'singleton'`
        )
        if (!row) return DEFAULT_PREFS
        return {
          play_mode: row.play_mode,
          rotation_interval_sec: row.rotation_interval_sec,
          play_limit_minutes: row.play_limit_minutes,
        }
      })

    // Cache prefs in memory so PlayerWatch's 1Hz tick reads a Ref, not the DB.
    // All writes go through here, so the cache stays the source of truth.
    const initial = yield* readDb().pipe(Effect.catch(() => Effect.succeed(DEFAULT_PREFS)))
    const cache = yield* Ref.make(initial)

    const upsert = (next: PlaybackPrefsState) =>
      db.exec(
        `INSERT INTO playback_prefs (
           id, play_mode, rotation_interval_sec, play_limit_minutes, updated_at
         )
         VALUES ('singleton', ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           play_mode = excluded.play_mode,
           rotation_interval_sec = excluded.rotation_interval_sec,
           play_limit_minutes = excluded.play_limit_minutes,
           updated_at = excluded.updated_at`,
        [next.play_mode, next.rotation_interval_sec, next.play_limit_minutes, Date.now()]
      )

    const update = (fn: (cur: PlaybackPrefsState) => PlaybackPrefsState) =>
      Effect.gen(function* () {
        const next = fn(yield* Ref.get(cache))
        yield* upsert(next)
        yield* Ref.set(cache, next)
      })

    return {
      get: () => Ref.get(cache),
      setMode: (mode) => update((cur) => ({ ...cur, play_mode: mode })),
      setInterval: (sec) => update((cur) => ({ ...cur, rotation_interval_sec: sec })),
      // Negative input would arm an auto-stop in the past; clamp to "off" so a
      // bad value can never turn the limit on by accident.
      setPlayLimit: (minutes) =>
        update((cur) => ({ ...cur, play_limit_minutes: Math.max(0, Math.floor(minutes)) })),
    }
  })
)
