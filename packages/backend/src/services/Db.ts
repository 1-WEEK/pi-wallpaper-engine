import { Context, Effect, Layer } from "effect"
import { Database } from "bun:sqlite"
import { readFileSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { DbError } from "@pwe/shared"
import { Config } from "./Config.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const MIGRATION_FILE = resolve(__dirname, "../db/migrations/001_init.sql")

const ensureLibraryColumns = (db: Database) => {
  const columns = (db.query(`PRAGMA table_info(library)`).all() as Array<{ name: string }>).map(
    (row) => row.name
  )

  if (!columns.includes("content_rating")) {
    db.exec(`ALTER TABLE library ADD COLUMN content_rating TEXT`)
  }
  if (!columns.includes("rating_sex")) {
    db.exec(`ALTER TABLE library ADD COLUMN rating_sex TEXT`)
  }
}

const ensureDownloadTaskColumns = (db: Database) => {
  const columns = (db.query(`PRAGMA table_info(download_tasks)`).all() as Array<{ name: string }>).map(
    (row) => row.name
  )

  if (!columns.includes("content_rating")) {
    db.exec(`ALTER TABLE download_tasks ADD COLUMN content_rating TEXT`)
  }
  if (!columns.includes("rating_sex")) {
    db.exec(`ALTER TABLE download_tasks ADD COLUMN rating_sex TEXT`)
  }
  if (!columns.includes("adult_hint")) {
    db.exec(`ALTER TABLE download_tasks ADD COLUMN adult_hint INTEGER NOT NULL DEFAULT 0`)
  }
}

export interface DbImpl {
  readonly query: <T = unknown>(sql: string, params?: unknown[]) => Effect.Effect<T[], DbError>
  readonly queryOne: <T = unknown>(
    sql: string,
    params?: unknown[]
  ) => Effect.Effect<T | null, DbError>
  readonly exec: (sql: string, params?: unknown[]) => Effect.Effect<void, DbError>
  readonly transaction: <A, E, R>(fn: () => Effect.Effect<A, E, R>) => Effect.Effect<A, E | DbError, R>
}

export class Db extends Context.Tag("Db")<Db, DbImpl>() {}

const tryDb =
  <T>(op: string) =>
  (fn: () => T): Effect.Effect<T, DbError> =>
    Effect.try({
      try: fn,
      catch: (cause) => new DbError({ operation: op, cause }),
    })

export const DbLive = Layer.scoped(
  Db,
  Effect.gen(function* () {
    const config = yield* Config
    const dbPath = resolve(config.paths.data_root, "pi-wallpaper-engine.db")

    yield* Effect.try({
      try: () => mkdirSync(dirname(dbPath), { recursive: true }),
      catch: (cause) => new DbError({ operation: "mkdir", cause }),
    })

    const sqlite = yield* Effect.acquireRelease(
      tryDb<Database>("open")(() => {
        const db = new Database(dbPath, { create: true })
        db.exec("PRAGMA journal_mode = WAL")
        db.exec("PRAGMA foreign_keys = ON")
        return db
      }),
      (db) => Effect.sync(() => db.close())
    )

    const migrationSql = yield* tryDb<string>("read_migration")(() =>
      readFileSync(MIGRATION_FILE, "utf-8")
    )

    yield* tryDb<void>("migrate")(() => {
      sqlite.exec(migrationSql)
      ensureLibraryColumns(sqlite)
      ensureDownloadTaskColumns(sqlite)
    })

    return {
      query: <T>(sql: string, params: unknown[] = []) =>
        tryDb<T[]>("query")(() => sqlite.query(sql).all(...(params as any[])) as T[]),

      queryOne: <T>(sql: string, params: unknown[] = []) =>
        tryDb<T | null>("queryOne")(() => {
          const row = sqlite.query(sql).get(...(params as any[]))
          return (row as T) ?? null
        }),

      exec: (sql: string, params: unknown[] = []) =>
        tryDb<void>("exec")(() => {
          sqlite.prepare(sql).run(...(params as any[]))
        }),

      transaction: <A, E, R>(fn: () => Effect.Effect<A, E, R>): Effect.Effect<A, E | DbError, R> =>
        Effect.gen(function* () {
          yield* tryDb<void>("begin")(() => sqlite.exec("BEGIN"))
          const result = yield* fn().pipe(
            Effect.tapError(() => tryDb<void>("rollback")(() => sqlite.exec("ROLLBACK")))
          )
          yield* tryDb<void>("commit")(() => sqlite.exec("COMMIT"))
          return result
        }),
    }
  })
)
