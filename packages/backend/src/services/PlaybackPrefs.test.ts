import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Database } from "bun:sqlite"
import { DbError } from "@pwe/shared"
import { Db, type DbImpl } from "./Db.js"
import {
  MAX_PLAY_LIMIT_MINUTES,
  PlaybackPrefs,
  PlaybackPrefsLive,
  clampPlayLimitMinutes,
} from "./PlaybackPrefs.js"

describe("clampPlayLimitMinutes", () => {
  test("passes values in range through unchanged", () => {
    expect(clampPlayLimitMinutes(45)).toBe(45)
    expect(clampPlayLimitMinutes(0)).toBe(0)
  })

  test("clamps negatives to off", () => {
    expect(clampPlayLimitMinutes(-10)).toBe(0)
  })

  test("caps above the native timer ceiling", () => {
    // Above 2^31-1 ms a native timer fires after ~1 ms, so an uncapped value
    // would stop playback instantly — and keep doing so after every restart.
    expect(clampPlayLimitMinutes(MAX_PLAY_LIMIT_MINUTES + 1)).toBe(MAX_PLAY_LIMIT_MINUTES)
    expect(clampPlayLimitMinutes(Number.MAX_SAFE_INTEGER)).toBe(MAX_PLAY_LIMIT_MINUTES)
    // The ceiling itself must stay inside the platform timer range.
    expect(MAX_PLAY_LIMIT_MINUTES * 60_000).toBeLessThan(2 ** 31 - 1)
  })

  test("treats non-finite input as off rather than arming a NaN timer", () => {
    expect(clampPlayLimitMinutes(Number.NaN)).toBe(0)
    expect(clampPlayLimitMinutes(Number.POSITIVE_INFINITY)).toBe(0)
    expect(clampPlayLimitMinutes(Number.NEGATIVE_INFINITY)).toBe(0)
  })
})

let openDbs: Database[] = []

const makeDbLayer = () => {
  const sqlite = new Database(":memory:")
  openDbs.push(sqlite)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS playback_prefs (
      id                    TEXT PRIMARY KEY CHECK (id = 'singleton'),
      play_mode             TEXT NOT NULL DEFAULT 'single',
      rotation_interval_sec INTEGER NOT NULL DEFAULT 600,
      play_limit_minutes    INTEGER NOT NULL DEFAULT 0,
      play_limit_once       INTEGER NOT NULL DEFAULT 0,
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

          expect(yield* prefs.get()).toEqual({
            play_mode: "single",
            rotation_interval_sec: 600,
            play_limit_minutes: 0,
            play_limit_once: false,
          })

          yield* prefs.setMode("shuffle")
          expect(yield* prefs.get()).toEqual({
            play_mode: "shuffle",
            rotation_interval_sec: 600,
            play_limit_minutes: 0,
            play_limit_once: false,
          })

          yield* prefs.setInterval(120)
          expect(yield* prefs.get()).toEqual({
            play_mode: "shuffle",
            rotation_interval_sec: 120,
            play_limit_minutes: 0,
            play_limit_once: false,
          })

          yield* prefs.setPlayLimit(45, false)
          expect(yield* prefs.get()).toEqual({
            play_mode: "shuffle",
            rotation_interval_sec: 120,
            play_limit_minutes: 45,
            play_limit_once: false,
          })

          yield* prefs.setMode("sequential")
          expect(yield* prefs.get()).toEqual({
            play_mode: "sequential",
            rotation_interval_sec: 120,
            play_limit_minutes: 45,
            play_limit_once: false,
          })

          // A negative limit would arm an auto-stop in the past; it clamps to off,
          // and the mode still follows the last set so the next set keeps it.
          yield* prefs.setPlayLimit(-10, true)
          expect(yield* prefs.get()).toEqual({
            play_mode: "sequential",
            rotation_interval_sec: 120,
            play_limit_minutes: 0,
            play_limit_once: true,
          })
        })
      )
    } finally {
      await runtime.dispose()
    }
  })
})
