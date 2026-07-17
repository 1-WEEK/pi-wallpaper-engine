import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { dirname } from "node:path"
import { ensureTaskColumns, migrateLegacyDownloadTasks } from "./Db.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATION_SQL = readFileSync(resolve(__dirname, "../db/migrations/001_init.sql"), "utf-8")

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

interface TaskRow {
  task_id: string
  task_type: string
  workshop_id: string
  title: string
  stage: string
  started_at: number
}

// Runs the real production boot sequence against a legacy on-disk shape.
const runBootMigration = (db: Database) => {
  migrateLegacyDownloadTasks(db)
  db.exec(MIGRATION_SQL)
  ensureTaskColumns(db)
}

const tasksRows = (db: Database): TaskRow[] =>
  db.query(`SELECT task_id, task_type, workshop_id, title, stage, started_at FROM tasks ORDER BY started_at ASC`).all() as TaskRow[]

const tableExists = (db: Database, name: string): boolean =>
  db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name) !== null

// Schema as of the pre-task_id releases: workshop_id is the primary key.
const createLegacySchemaA = (db: Database) => {
  db.exec(`
    CREATE TABLE download_tasks (
      workshop_id TEXT PRIMARY KEY,
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
  db.exec(
    `INSERT INTO download_tasks (workshop_id, title, stage, started_at, finished_at)
     VALUES ('ws-1', 'First wallpaper', 'complete', 1000, 2000),
            ('ws-2', 'Second wallpaper', 'error', 3000, 4000)`
  )
}

// Schema as of the download_tasks-with-task_id release.
const createLegacySchemaB = (db: Database) => {
  db.exec(`
    CREATE TABLE download_tasks (
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
  db.exec(
    `INSERT INTO download_tasks (task_id, workshop_id, title, stage, started_at, finished_at)
     VALUES ('existing-id-1', 'ws-1', 'First wallpaper', 'complete', 1000, 2000)`
  )
}

describe("legacy download_tasks migration", () => {
  test("schema A (no task_id): rows land in tasks with unique UUID v4 task_ids", () => {
    const db = new Database(":memory:")
    createLegacySchemaA(db)

    runBootMigration(db)

    expect(tableExists(db, "download_tasks")).toBe(false)
    const rows = tasksRows(db)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.workshop_id)).toEqual(["ws-1", "ws-2"])
    for (const row of rows) {
      expect(row.task_id).toMatch(UUID_V4)
      expect(row.task_id).not.toBe(row.workshop_id)
      expect(row.task_type).toBe("download")
    }
    expect(new Set(rows.map((r) => r.task_id)).size).toBe(2)
    expect(rows[0]?.title).toBe("First wallpaper")
    expect(rows[1]?.stage).toBe("error")
  })

  test("schema B (task_id present): ids are preserved, task_type is added", () => {
    const db = new Database(":memory:")
    createLegacySchemaB(db)

    runBootMigration(db)

    expect(tableExists(db, "download_tasks")).toBe(false)
    const rows = tasksRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.task_id).toBe("existing-id-1")
    expect(rows[0]?.task_type).toBe("download")
  })

  test("both tables exist (init SQL ran first): legacy rows merge into tasks", () => {
    const db = new Database(":memory:")
    // Simulates the broken boot order: init SQL created `tasks` already.
    db.exec(MIGRATION_SQL)
    db.exec(
      `INSERT INTO tasks (task_id, task_type, workshop_id, title, stage, started_at)
       VALUES ('new-id-1', 'download', 'ws-9', 'New wallpaper', 'complete', 5000)`
    )
    createLegacySchemaA(db)

    runBootMigration(db)

    expect(tableExists(db, "download_tasks")).toBe(false)
    const rows = tasksRows(db)
    expect(rows).toHaveLength(3)
    const ids = rows.map((r) => r.task_id)
    expect(ids).toContain("new-id-1")
    const migrated = rows.filter((r) => r.task_id !== "new-id-1")
    for (const row of migrated) {
      expect(row.task_id).toMatch(UUID_V4)
      expect(row.task_type).toBe("download")
    }
  })

  test("fresh install: migration is a no-op and tasks is empty", () => {
    const db = new Database(":memory:")

    runBootMigration(db)

    expect(tableExists(db, "tasks")).toBe(true)
    expect(tasksRows(db)).toHaveLength(0)
  })
})
