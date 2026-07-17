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

const tableExists = (db: Database, name: string): boolean =>
  db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name) !== null

const columnNames = (db: Database, table: string): string[] =>
  (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name)

// RFC 4122 v4 UUID built in SQL, so migrated rows get the same format as the
// runtime's randomUUID() — not the bare 32-hex of hex(randomblob(16)).
const UUID_V4_SQL = `lower(
  substr(hex(randomblob(4)), 1, 8) || '-' ||
  substr(hex(randomblob(2)), 1, 4) || '-4' ||
  substr(hex(randomblob(2)), 2, 3) || '-' ||
  substr('89ab', 1 + abs(random()) % 4, 1) || substr(hex(randomblob(2)), 2, 3) || '-' ||
  substr(hex(randomblob(6)), 1, 12)
)`

/**
 * Pre-init migration: pre-`tasks` releases stored history in `download_tasks`.
 * Must run BEFORE 001_init.sql — the init script creates an empty `tasks`
 * table, and once it exists the legacy rows would be stranded. Renames when
 * `tasks` is absent; merges when an earlier boot already created it.
 */
export const migrateLegacyDownloadTasks = (db: Database): void => {
  if (!tableExists(db, "download_tasks")) return

  if (!tableExists(db, "tasks")) {
    db.exec(`ALTER TABLE download_tasks RENAME TO tasks`)
    return
  }

  const legacyColumns = columnNames(db, "download_tasks")
  if (!legacyColumns.includes("content_rating")) {
    db.exec(`ALTER TABLE download_tasks ADD COLUMN content_rating TEXT`)
  }
  if (!legacyColumns.includes("rating_sex")) {
    db.exec(`ALTER TABLE download_tasks ADD COLUMN rating_sex TEXT`)
  }
  if (!legacyColumns.includes("adult_hint")) {
    db.exec(`ALTER TABLE download_tasks ADD COLUMN adult_hint INTEGER NOT NULL DEFAULT 0`)
  }
  if (!legacyColumns.includes("task_id")) {
    db.exec(`ALTER TABLE download_tasks ADD COLUMN task_id TEXT`)
    db.exec(`UPDATE download_tasks SET task_id = ${UUID_V4_SQL} WHERE task_id IS NULL`)
  }

  db.exec(`
    INSERT OR IGNORE INTO tasks (
      task_id, task_type, workshop_id, title, preview_url, content_rating, rating_sex, adult_hint,
      stage, message, started_at, finished_at, percent, bytes_done, bytes_total
    )
    SELECT
      task_id, 'download', workshop_id, title, preview_url, content_rating, rating_sex, adult_hint,
      stage, message, started_at, finished_at, percent, bytes_done, bytes_total
    FROM download_tasks
  `)
  db.exec(`DROP TABLE download_tasks`)
}

export const ensureTaskColumns = (db: Database): void => {
  let columns = columnNames(db, "tasks")

  if (!columns.includes("content_rating")) {
    db.exec(`ALTER TABLE tasks ADD COLUMN content_rating TEXT`)
  }
  if (!columns.includes("rating_sex")) {
    db.exec(`ALTER TABLE tasks ADD COLUMN rating_sex TEXT`)
  }
  if (!columns.includes("adult_hint")) {
    db.exec(`ALTER TABLE tasks ADD COLUMN adult_hint INTEGER NOT NULL DEFAULT 0`)
  }
  if (!columns.includes("task_type")) {
    db.exec(`ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'download'`)
  }

  columns = columnNames(db, "tasks")

  if (!columns.includes("task_id")) {
    // Renamed legacy table (workshop_id was the primary key). Rebuild with a
    // real UUID key so repeat downloads of one item are distinct entries.
    db.transaction(() => {
      db.exec(`
        CREATE TABLE tasks_new (
          task_id     TEXT PRIMARY KEY,
          task_type   TEXT NOT NULL DEFAULT 'download',
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
        INSERT INTO tasks_new (
          task_id, task_type, workshop_id, title, preview_url, content_rating, rating_sex, adult_hint,
          stage, message, started_at, finished_at, percent, bytes_done, bytes_total
        )
        SELECT
          ${UUID_V4_SQL}, task_type, workshop_id, title, preview_url, content_rating, rating_sex, adult_hint,
          stage, message, started_at, finished_at, percent, bytes_done, bytes_total
        FROM tasks
      `)
      db.exec(`DROP TABLE tasks`)
      db.exec(`ALTER TABLE tasks_new RENAME TO tasks`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_started_at ON tasks(started_at DESC)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_workshop_id ON tasks(workshop_id)`)
    })()
  } else {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_started_at ON tasks(started_at DESC)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_workshop_id ON tasks(workshop_id)`)
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
      migrateLegacyDownloadTasks(sqlite)
      sqlite.exec(migrationSql)
      ensureLibraryColumns(sqlite)
      ensureTaskColumns(sqlite)
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
