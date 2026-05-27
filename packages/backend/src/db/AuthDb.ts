import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { resolveStateRoot } from "../statePath.js"

export const resolveAuthDbPath = (): string => resolve(resolveStateRoot(), "auth.db")

export interface AuthDbHandle {
  readonly db: Database
  readonly isSetupComplete: () => boolean
  readonly markSetupComplete: () => void
  readonly dispose: () => void
}

export const openAuthDb = (): AuthDbHandle => {
  const path = resolveAuthDbPath()
  const dir = dirname(path)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const db = new Database(path)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")

  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_setup_state (
      id TEXT PRIMARY KEY CHECK (id = 'singleton'),
      completed_at INTEGER NOT NULL
    )
  `)

  const selectComplete = db.prepare<{ completed_at: number }, []>(
    "SELECT completed_at FROM auth_setup_state WHERE id = 'singleton'"
  )
  const insertComplete = db.prepare<unknown, [number]>(
    "INSERT OR REPLACE INTO auth_setup_state (id, completed_at) VALUES ('singleton', ?)"
  )

  return {
    db,
    isSetupComplete: () => selectComplete.get() !== null,
    markSetupComplete: () => {
      insertComplete.run(Date.now())
    },
    dispose: () => {
      db.close()
    },
  }
}
