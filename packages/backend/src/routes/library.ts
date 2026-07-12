import { Elysia, t } from "elysia"
import { Effect } from "effect"
import type { DisplayMode, LibraryItem } from "@pwe/shared"
import { Config } from "../services/Config.js"
import { Db } from "../services/Db.js"
import { Library } from "../services/Library.js"
import { TranscodeQueue } from "../services/TranscodeQueue.js"
import { decideTranscode, type TranscodeSourceSpec } from "../transcode/decide.js"
import { httpFromError } from "./httpError.js"
import { transcodeMode, type AppContext, type AppRuntime } from "../runtime.js"

// Manual retrigger only makes sense from a terminal state: `failed` (retry)
// and `skipped` (items downloaded before a worker existed, or re-evaluate
// after config changes). Active states are already owned by a worker and
// `completed` items keep their optimized file.
const canRetrigger = (status: LibraryItem["transcode_status"]): boolean =>
  status === "failed" || status === "skipped"

// Rebuild only the inputs decideTranscode needs from what intake persisted.
const sourceSpecFromRow = (row: LibraryItem): TranscodeSourceSpec | null => {
  const match = /^(\d+)x(\d+)$/.exec(row.source_resolution)
  if (!match) return null
  return {
    width: Number(match[1]),
    height: Number(match[2]),
    codec: row.source_codec,
  }
}

type RetriggerResult =
  | { readonly kind: "queued"; readonly reason: string }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "conflict"; readonly status: LibraryItem["transcode_status"] }
  | { readonly kind: "invalid"; readonly resolution: string }

export const libraryRoutes = (runtime: AppRuntime) => {
  // See player.ts for the rationale: closes over `runtime` to keep the R
  // channel inferred, owns only the error path via httpFromError.
  const runRoute = <A, E extends { readonly _tag: string }>(
    set: { status?: number | string },
    effect: Effect.Effect<A, E, AppContext>
  ) =>
    runtime
      .runPromise(
        effect.pipe(
          Effect.catchAll((err) =>
            Effect.sync(() => {
              const { status, body } = httpFromError(err)
              set.status = status
              return body
            })
          )
        )
      )
      .catch((e: unknown) => {
        set.status = 500
        return { error: e instanceof Error ? e.message : String(e) }
      })

  const retrigger = (workshopId: string) =>
    Effect.gen(function* () {
      const db = yield* Db
      const lib = yield* Library
      const config = yield* Config
      const queue = yield* TranscodeQueue

      return yield* db.transaction(() =>
        Effect.gen(function* () {
          const row = yield* lib.get(workshopId)
          if (!canRetrigger(row.transcode_status)) {
            return { kind: "conflict", status: row.transcode_status } as const
          }

          const source = sourceSpecFromRow(row)
          if (!source) {
            return { kind: "invalid", resolution: row.source_resolution } as const
          }

          const decision = decideTranscode(source, config.screen, config.transcode.target_codec)
          yield* queue.enqueue(row.workshop_id, decision, row.source_path)
          return {
            kind: decision.kind === "skip" ? "skipped" : "queued",
            reason: decision.reason,
          } as RetriggerResult
        })
      )
    })

  return new Elysia({ prefix: "/api/library" })
    .get("/", () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const lib = yield* Library
          return yield* lib.list()
        })
      )
    )
    .delete("/:workshopId", ({ params, set }) =>
      runRoute(
        set,
        Effect.gen(function* () {
          const lib = yield* Library
          yield* lib.remove(params.workshopId)
          return { ok: true }
        })
      )
    )
    .post("/transcode/retry-all", ({ set }) =>
      runRoute(
        set,
        Effect.gen(function* () {
          if (transcodeMode() === "noop") {
            set.status = 503
            return { error: "No transcode worker is configured (PWE_WORKER_API_KEY is not set)." }
          }
          const lib = yield* Library
          const rows = yield* lib.list()

          let queued = 0
          let skipped = 0
          let invalid = 0
          for (const row of rows) {
            if (!canRetrigger(row.transcode_status)) continue
            const result = yield* retrigger(row.workshop_id)
            if (result.kind === "invalid") invalid += 1
            else if (result.kind === "skipped") skipped += 1
            else if (result.kind === "queued") queued += 1
          }
          return { ok: true, queued, skipped, invalid }
        })
      )
    )
    .post("/:workshopId/transcode", ({ params, set }) =>
      runRoute(
        set,
        Effect.gen(function* () {
          if (transcodeMode() === "noop") {
            set.status = 503
            return { error: "No transcode worker is configured (PWE_WORKER_API_KEY is not set)." }
          }
          const result = yield* retrigger(params.workshopId)
          if (result.kind === "conflict") {
            set.status = 409
            return {
              error: `Transcode can only be retriggered from failed or skipped (current: ${result.status}).`,
            }
          }
          if (result.kind === "invalid") {
            set.status = 422
            return { error: `Source resolution "${result.resolution}" is not parseable.` }
          }
          return {
            ok: true,
            transcode_status: result.kind === "skipped" ? "skipped" : "pending",
            reason: result.reason,
          }
        })
      )
    )
    .patch(
      "/:workshopId",
      ({ params, body, set }) =>
        runRoute(
          set,
          Effect.gen(function* () {
            const lib = yield* Library
            yield* lib.get(params.workshopId) // existence check
            const patch: Record<string, unknown> = {}
            if (body.display_mode) patch["display_mode"] = body.display_mode as DisplayMode
            yield* lib.update(params.workshopId, patch as never)
            return { ok: true }
          })
        ),
      {
        body: t.Object({
          display_mode: t.Optional(t.Union([t.Literal("fill"), t.Literal("fit"), t.Literal("stretch")])),
        }),
      }
    )
}
