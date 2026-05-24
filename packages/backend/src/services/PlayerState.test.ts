import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Database } from "bun:sqlite"
import { DbError } from "@pwe/shared"
import { Db, type DbImpl } from "./Db.js"
import { PlayerState, PlayerStateLive } from "./PlayerState.js"

let openDbs: Database[] = []

const makeDbLayer = () => {
  const sqlite = new Database(":memory:")
  openDbs.push(sqlite)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS player_state (
      id                  TEXT PRIMARY KEY CHECK (id = 'singleton'),
      restore_workshop_id TEXT NOT NULL,
      restore_reason      TEXT NOT NULL,
      updated_at          INTEGER NOT NULL
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

describe("PlayerStateLive", () => {
  test("stores, overwrites, and clears a singleton restore state", async () => {
    const runtime = ManagedRuntime.make(PlayerStateLive.pipe(Layer.provide(makeDbLayer())))

    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const state = yield* PlayerState

          expect(yield* state.getRestore()).toBeNull()

          yield* state.setRestore("123", "manual_stop")
          expect(yield* state.getRestore()).toMatchObject({
            workshop_id: "123",
            reason: "manual_stop",
          })

          yield* state.setRestore("456", "display_off")
          expect(yield* state.getRestore()).toMatchObject({
            workshop_id: "456",
            reason: "display_off",
          })

          yield* state.clearRestore()
          expect(yield* state.getRestore()).toBeNull()
        })
      )
    } finally {
      await runtime.dispose()
    }
  })
})
