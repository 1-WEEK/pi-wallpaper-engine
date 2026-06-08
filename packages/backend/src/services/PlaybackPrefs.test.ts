import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Database } from "bun:sqlite"
import { DbError } from "@pwe/shared"
import { Db, type DbImpl } from "./Db.js"
import { PlaybackPrefs, PlaybackPrefsLive } from "./PlaybackPrefs.js"

let openDbs: Database[] = []

const makeDbLayer = () => {
  const sqlite = new Database(":memory:")
  openDbs.push(sqlite)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS playback_prefs (
      id                    TEXT PRIMARY KEY CHECK (id = 'singleton'),
      play_mode             TEXT NOT NULL DEFAULT 'single',
      rotation_interval_sec INTEGER NOT NULL DEFAULT 600,
      updated_at            INTEGER NOT NULL
    );
  `)

  const tryDb =
    <T>(operation: string, fn: () => T): Effect.Effect<T, DbError> =>
      Effect.try({
        try: fn,
        catch: (cause) => new DbError({ operation, cause }),
      })

  const impl: DbImpl = {
    query: <T>(sql: string, params: unknown[] = []) =>
      tryDb("query", () => sqlite.query(sql).all(...(params as any[])) as T[]),
    queryOne: <T>(sql: string, params: unknown[] = []) =>
      tryDb("queryOne", () => (sqlite.query(sql).get(...(params as any[])) as T) ?? null),
    exec: (sql: string, params: unknown[] = []) =>
      tryDb("exec", () => {
        sqlite.prepare(sql).run(...(params as any[]))
      }),
    transaction: <A, E, R>(fn: () => Effect.Effect<A, E, R>) => fn() as Effect.Effect<A, E | DbError, R>,
  }

  return Layer.succeed(Db, impl)
}

afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs = []
})

describe("PlaybackPrefsLive", () => {
  test("defaults to single/600 and persists mode and interval independently", async () => {
    const runtime = ManagedRuntime.make(PlaybackPrefsLive.pipe(Layer.provide(makeDbLayer())))

    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const prefs = yield* PlaybackPrefs

          expect(yield* prefs.get()).toEqual({ play_mode: "single", rotation_interval_sec: 600 })

          yield* prefs.setMode("shuffle")
          expect(yield* prefs.get()).toEqual({ play_mode: "shuffle", rotation_interval_sec: 600 })

          yield* prefs.setInterval(120)
          expect(yield* prefs.get()).toEqual({ play_mode: "shuffle", rotation_interval_sec: 120 })

          yield* prefs.setMode("sequential")
          expect(yield* prefs.get()).toEqual({ play_mode: "sequential", rotation_interval_sec: 120 })
        })
      )
    } finally {
      await runtime.dispose()
    }
  })
})
