import { Context, Effect, Layer, Ref } from "effect"
import { DbError } from "@pwe/shared"
import type { PlayMode } from "@pwe/shared"
import { Db } from "./Db.js"

export interface PlaybackPrefsState {
  readonly play_mode: PlayMode
  readonly rotation_interval_sec: number
}

// Defaults match the 001_init.sql column defaults, returned when no row exists
// yet so callers never have to special-case a fresh database.
const DEFAULT_PREFS: PlaybackPrefsState = {
  play_mode: "single",
  rotation_interval_sec: 600,
}

export interface PlaybackPrefsImpl {
  readonly get: () => Effect.Effect<PlaybackPrefsState, DbError>
  readonly setMode: (mode: PlayMode) => Effect.Effect<void, DbError>
  readonly setInterval: (sec: number) => Effect.Effect<void, DbError>
}

export class PlaybackPrefs extends Context.Tag("PlaybackPrefs")<
  PlaybackPrefs,
  PlaybackPrefsImpl
>() {}

interface PrefsRow {
  readonly play_mode: PlayMode
  readonly rotation_interval_sec: number
}

export const PlaybackPrefsLive = Layer.scoped(
  PlaybackPrefs,
  Effect.gen(function* () {
    const db = yield* Db

    const readDb = (): Effect.Effect<PlaybackPrefsState, DbError> =>
      Effect.gen(function* () {
        const row = yield* db.queryOne<PrefsRow>(
          `SELECT play_mode, rotation_interval_sec
           FROM playback_prefs
           WHERE id = 'singleton'`
        )
        if (!row) return DEFAULT_PREFS
        return {
          play_mode: row.play_mode,
          rotation_interval_sec: row.rotation_interval_sec,
        }
      })

    // Cache prefs in memory so PlayerWatch's 1Hz tick reads a Ref, not the DB.
    // All writes go through here, so the cache stays the source of truth.
    const initial = yield* readDb().pipe(Effect.catchAll(() => Effect.succeed(DEFAULT_PREFS)))
    const cache = yield* Ref.make(initial)

    const upsert = (mode: PlayMode, sec: number) =>
      db.exec(
        `INSERT INTO playback_prefs (id, play_mode, rotation_interval_sec, updated_at)
         VALUES ('singleton', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           play_mode = excluded.play_mode,
           rotation_interval_sec = excluded.rotation_interval_sec,
           updated_at = excluded.updated_at`,
        [mode, sec, Date.now()]
      )

    return {
      get: () => Ref.get(cache),
      setMode: (mode) =>
        Effect.gen(function* () {
          const cur = yield* Ref.get(cache)
          yield* upsert(mode, cur.rotation_interval_sec)
          yield* Ref.set(cache, { ...cur, play_mode: mode })
        }),
      setInterval: (sec) =>
        Effect.gen(function* () {
          const cur = yield* Ref.get(cache)
          yield* upsert(cur.play_mode, sec)
          yield* Ref.set(cache, { ...cur, rotation_interval_sec: sec })
        }),
    }
  })
)
