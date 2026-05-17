import { Context, Effect, Layer } from "effect"
import { readFile, rm, unlink } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { DbError, LibraryItem, LibraryNotFoundError } from "@pwe/shared"
import { ffprobe } from "../transcode/ffprobe.js"
import { Config } from "./Config.js"
import { Db } from "./Db.js"
import { Logger } from "./Logger.js"
import { normalizeAdultMetadata } from "./WallpaperFile.js"

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
  "content_rating",
  "rating_sex",
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

export const hasSuspectSourceMetadata = (
  sourceCodec: string,
  sourceResolution: string
): boolean => sourceCodec === "unknown" || sourceResolution === "0x0"

const hasMissingAdultMetadata = (row: LibraryRow): boolean =>
  row.content_rating === null && row.rating_sex === null

export const LibraryLive = Layer.effect(
  Library,
  Effect.gen(function* () {
    const config = yield* Config
    const db = yield* Db
    const logger = yield* Logger

    const dataRoot = config.paths.data_root

    const readAdultMetadata = (mediaPath: string) =>
      Effect.tryPromise({
        try: async () => {
          const raw = await readFile(resolve(dirname(mediaPath), "project.json"), "utf-8")
          return normalizeAdultMetadata(JSON.parse(raw) as { contentrating?: string; ratingsex?: string })
        },
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      }).pipe(Effect.catchAll(() => Effect.succeed(normalizeAdultMetadata(null))))

    const reconcileSuspectRows = Effect.gen(function* () {
      const suspectRows = yield* db.query<LibraryRow>(
        `SELECT * FROM library
         WHERE source_codec = 'unknown'
            OR source_resolution = '0x0'
            OR content_rating IS NULL AND rating_sex IS NULL`
      )

      for (const row of suspectRows) {
        const mediaPath = resolve(dataRoot, row.source_path)
        const adultMetadata = yield* readAdultMetadata(mediaPath)

        if (hasMissingAdultMetadata(row)) {
          yield* db.exec(
            `UPDATE library SET content_rating = ?, rating_sex = ? WHERE workshop_id = ?`,
            [adultMetadata.contentRating, adultMetadata.ratingSex, row.workshop_id]
          )
        }

        if (!hasSuspectSourceMetadata(row.source_codec, row.source_resolution)) continue

        const probe = yield* ffprobe(mediaPath).pipe(
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catchTag("FfprobeError", () => Effect.succeed({ ok: false as const }))
        )

        if (!probe.ok) {
          yield* db.exec(`DELETE FROM library WHERE workshop_id = ?`, [row.workshop_id])
          const sourceDir = resolve(dataRoot, config.paths.source_dir, row.workshop_id)
          yield* Effect.tryPromise({
            try: () => rm(sourceDir, { recursive: true, force: true }),
            catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
          }).pipe(
            Effect.tap(() => logger.warn(`Removed invalid library row ${row.workshop_id}`)),
            Effect.catchAll((e) => logger.warn(`Failed to clean invalid library row ${row.workshop_id}: ${e.message}`))
          )
          continue
        }

        yield* db.exec(
          `UPDATE library
           SET source_resolution = ?, source_codec = ?, source_size = ?, content_rating = ?, rating_sex = ?
           WHERE workshop_id = ?`,
          [
            `${probe.value.width}x${probe.value.height}`,
            probe.value.codec,
            probe.value.size_bytes || row.source_size,
            adultMetadata.contentRating,
            adultMetadata.ratingSex,
            row.workshop_id,
          ]
        )
        yield* logger.info(`Healed library metadata for ${row.workshop_id}`)
      }
    }).pipe(Effect.catchAll((e) => logger.error(`Library reconcile failed: ${e.message}`)))

    yield* reconcileSuspectRows

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
