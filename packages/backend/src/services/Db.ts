import { Context, Effect, Layer } from "effect"
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { DbError } from "@pwe/shared"
import { resolveDbPath } from "../statePath.js"
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
  let columns = (db.query(`PRAGMA table_info(download_tasks)`).all() as Array<{ name: string }>).map(
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

  columns = (db.query(`PRAGMA table_info(download_tasks)`).all() as Array<{ name: string }>).map(
    (row) => row.name
  )

  if (!columns.includes("task_id")) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE download_tasks_new (
          task_id     TEXT PRIMARY KEY,
          workshop_id TEXT NOT NULL,
          title       TEXT NOT NULL,
          preview_url TEXT NOT NULL DEFAULT '',
          content_rating TEXT,
          rating_sex  TEXT,
          adult_hint  INTEGER NOT NULL DEFAULT 0,
          stage       TEXT NOT NULL,
          message     TEXT NOT NULL DEFAULT '',
          started_at  INTEGER NOT NULL,
          finished_at INTEGER,
          percent     REAL,
          bytes_done  INTEGER,
          bytes_total INTEGER
        )
      `)
      db.exec(`
        INSERT INTO download_tasks_new (
          task_id, workshop_id, title, preview_url, content_rating, rating_sex, adult_hint,
          stage, message, started_at, finished_at, percent, bytes_done, bytes_total
        )
        SELECT 
          lower(hex(randomblob(16))), workshop_id, title, preview_url, content_rating, rating_sex, adult_hint,
          stage, message, started_at, finished_at, percent, bytes_done, bytes_total
        FROM download_tasks
      `)
      db.exec(`DROP TABLE download_tasks`)
      db.exec(`ALTER TABLE download_tasks_new RENAME TO download_tasks`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_download_tasks_started_at ON download_tasks(started_at DESC)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_download_tasks_workshop_id ON download_tasks(workshop_id)`)
    })()
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
    const dbPath = resolveDbPath()

    yield* Effect.try({
      try: () => mkdirSync(dirname(dbPath), { recursive: true }),
      catch: (cause) => new DbError({ operation: "mkdir", cause }),
    })

    // One-time migration: earlier versions stored the SQLite DB next to the
    // media files. The DB is now always local state, decoupled from storage
    // mode. Best-effort — a failed move just starts with a fresh database.
    const legacyDbPath = resolve(config.paths.data_root, "pi-wallpaper-engine.db")
    if (legacyDbPath !== dbPath && !existsSync(dbPath) && existsSync(legacyDbPath)) {
      try {
        for (const suffix of ["", "-wal", "-shm"]) {
          if (existsSync(legacyDbPath + suffix)) {
            renameSync(legacyDbPath + suffix, dbPath + suffix)
          }
        }
        console.log(`Migrated SQLite DB ${legacyDbPath} -> ${dbPath}`)
      } catch (cause) {
        console.warn(
          `Could not migrate legacy SQLite DB from ${legacyDbPath}: ` +
            `${cause instanceof Error ? cause.message : String(cause)}. ` +
            `Starting with a fresh database.`
        )
      }
    }

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
