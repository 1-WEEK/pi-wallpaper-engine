import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { resolveStateRoot } from "../statePath.js"

// All direct SQL against Better Auth's internal tables (user, passkey) lives
// in this file. If a Better Auth upgrade renames or restructures those tables,
// the breakage is contained here. The schema versions assumed:
//   - user(id, email, ...)
//   - passkey(id, userId, ...)
//   - session(userId) ON DELETE CASCADE from user
//   - account(userId) ON DELETE CASCADE from user
// "Setup complete" is derived from "at least one passkey exists" rather than
// stored separately — a separate flag could drift if sign-up succeeded but
// passkey registration didn't, leaving the admin locked out.

export const resolveAuthDbPath = (): string => resolve(resolveStateRoot(), "auth.db")

export interface AuthDbHandle {
  readonly db: Database
  readonly hasAnyPasskey: () => boolean
  readonly countUserPasskeys: (userId: string) => number
  readonly listOrphanUserIds: () => string[]
  readonly deleteUser: (id: string) => void
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

  // Drop the legacy auth_setup_state table from earlier phases of this branch.
  // setup completion is now derived from passkey existence, so the table is
  // unused; this keeps existing dev databases tidy.
  db.exec("DROP TABLE IF EXISTS auth_setup_state")

  const selectAnyPasskey = db.prepare<{ x: number }, []>(
    "SELECT 1 AS x FROM passkey LIMIT 1"
  )
  const countPasskeysForUser = db.prepare<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM passkey WHERE userId = ?"
  )
  const selectOrphanUsers = db.prepare<{ id: string }, []>(
    "SELECT id FROM user WHERE id NOT IN (SELECT DISTINCT userId FROM passkey)"
  )
  const deleteUserById = db.prepare<unknown, [string]>("DELETE FROM user WHERE id = ?")

  return {
    db,
    hasAnyPasskey: () => selectAnyPasskey.get() !== null,
    countUserPasskeys: (userId) => countPasskeysForUser.get(userId)?.n ?? 0,
    listOrphanUserIds: () => selectOrphanUsers.all().map((r) => r.id),
    // session/account cascade on user delete (see schema comment above).
    deleteUser: (id) => {
      deleteUserById.run(id)
    },
    dispose: () => {
      db.close()
    },
  }
}
