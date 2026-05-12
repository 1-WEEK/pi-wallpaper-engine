import { Context, Effect, Layer } from "effect"
import { unlink } from "node:fs/promises"
import { resolve } from "node:path"
import { DbError, LibraryItem, LibraryNotFoundError } from "@pwe/shared"
import { Config } from "./Config.js"
import { Db } from "./Db.js"
import { Logger } from "./Logger.js"

type LibraryRow = LibraryItem

export interface LibraryImpl {
  readonly list: () => Effect.Effect<LibraryRow[], DbError>
  readonly get: (workshopId: string) => Effect.Effect<LibraryRow, DbError | LibraryNotFoundError>
  readonly insert: (row: LibraryRow) => Effect.Effect<void, DbError>
  readonly update: (
    workshopId: string,
    patch: Partial<LibraryRow>
  ) => Effect.Effect<void, DbError>
  readonly remove: (workshopId: string) => Effect.Effect<void, DbError | LibraryNotFoundError>
  readonly playablePath: (row: LibraryRow) => string
}

export class Library extends Context.Tag("Library")<Library, LibraryImpl>() {}

const COLUMNS = [
  "workshop_id",
  "title",
  "author",
  "preview_url",
  "source_path",
  "source_resolution",
  "source_codec",
  "source_size",
  "downloaded_at",
  "transcode_status",
  "transcode_progress",
  "transcode_error",
  "transcoded_path",
  "transcoded_resolution",
  "transcoded_codec",
  "transcoded_size",
  "display_mode",
  "last_played_at",
] as const

export const LibraryLive = Layer.effect(
  Library,
  Effect.gen(function* () {
    const config = yield* Config
    const db = yield* Db
    const logger = yield* Logger

    const dataRoot = config.paths.data_root

    return {
      list: () => db.query<LibraryRow>(`SELECT * FROM library ORDER BY downloaded_at DESC`),

      get: (workshopId) =>
        Effect.gen(function* () {
          const row = yield* db.queryOne<LibraryRow>(
            `SELECT * FROM library WHERE workshop_id = ?`,
            [workshopId]
          )
          if (!row) return yield* Effect.fail(new LibraryNotFoundError({ workshopId }))
          return row
        }),

      insert: (row) => {
        const placeholders = COLUMNS.map(() => "?").join(",")
        const values = COLUMNS.map((c) => (row as Record<string, unknown>)[c] ?? null)
        return db.exec(
          `INSERT OR REPLACE INTO library (${COLUMNS.join(",")}) VALUES (${placeholders})`,
          values
        )
      },

      update: (workshopId, patch) => {
        const entries = Object.entries(patch).filter(([k]) =>
          (COLUMNS as readonly string[]).includes(k)
        )
        if (entries.length === 0) return Effect.void
        const setClause = entries.map(([k]) => `${k} = ?`).join(", ")
        const values = entries.map(([, v]) => v ?? null)
        return db.exec(`UPDATE library SET ${setClause} WHERE workshop_id = ?`, [
          ...values,
          workshopId,
        ])
      },

      remove: (workshopId) =>
        Effect.gen(function* () {
          const row = yield* db.queryOne<LibraryRow>(
            `SELECT * FROM library WHERE workshop_id = ?`,
            [workshopId]
          )
          if (!row) return yield* Effect.fail(new LibraryNotFoundError({ workshopId }))

          yield* db.exec(`DELETE FROM library WHERE workshop_id = ?`, [workshopId])

          for (const rel of [row.source_path, row.transcoded_path]) {
            if (!rel) continue
            const abs = resolve(dataRoot, rel)
            yield* Effect.tryPromise({
              try: () => unlink(abs),
              catch: () => null,
            }).pipe(
              Effect.tapError(() => logger.warn(`Failed to delete file: ${abs}`)),
              Effect.ignore
            )
          }
        }),

      playablePath: (row) => resolve(dataRoot, row.transcoded_path ?? row.source_path),
    }
  })
)
