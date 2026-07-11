import { Elysia, t } from "elysia"
import { Effect } from "effect"
import type { DisplayMode, LibraryItem, VideoProbe } from "@pwe/shared"
import { Config } from "../services/Config.js"
import { Library } from "../services/Library.js"
import { TranscodeQueue } from "../services/TranscodeQueue.js"
import { decideTranscode } from "../transcode/decide.js"
import { httpFromError } from "./httpError.js"
import { transcodeMode, type AppContext, type AppRuntime } from "../runtime.js"

// Manual retrigger only makes sense from a terminal state: `failed` (retry)
// and `skipped` (items downloaded before a worker existed, or re-evaluate
// after config changes). Active states are already owned by a worker and
// `completed` items keep their optimized file.
const canRetrigger = (status: LibraryItem["transcode_status"]): boolean =>
  status === "failed" || status === "skipped"

// Rebuild the probe decideTranscode needs from what intake stored on the
// library row — width/height/codec are all the decision reads, so no
// re-ffprobe of the source file is required.
const probeFromRow = (row: LibraryItem): VideoProbe | null => {
  const match = /^(\d+)x(\d+)$/.exec(row.source_resolution)
  if (!match) return null
  return {
    width: Number(match[1]),
    height: Number(match[2]),
    codec: row.source_codec,
    duration_seconds: 0,
    size_bytes: row.source_size,
  }
}

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
          const config = yield* Config
          const queue = yield* TranscodeQueue
          const rows = yield* lib.list()

          let queued = 0
          let skipped = 0
          let invalid = 0
          for (const row of rows) {
            if (!canRetrigger(row.transcode_status)) continue
            const probe = probeFromRow(row)
            if (!probe) {
              invalid += 1
              continue
            }
            const decision = decideTranscode(probe, config.screen, config.transcode.target_codec)
            yield* queue.enqueue(row.workshop_id, decision, row.source_path)
            if (decision.kind === "skip") skipped += 1
            else queued += 1
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
          const lib = yield* Library
          const row = yield* lib.get(params.workshopId)
          if (!canRetrigger(row.transcode_status)) {
            set.status = 409
            return {
              error: `Transcode can only be retriggered from failed or skipped (current: ${row.transcode_status}).`,
            }
          }
          const probe = probeFromRow(row)
          if (!probe) {
            set.status = 422
            return { error: `Source resolution "${row.source_resolution}" is not parseable.` }
          }
          const config = yield* Config
          const queue = yield* TranscodeQueue
          const decision = decideTranscode(probe, config.screen, config.transcode.target_codec)
          yield* queue.enqueue(row.workshop_id, decision, row.source_path)
          return {
            ok: true,
            transcode_status: decision.kind === "skip" ? "skipped" : "pending",
            reason: decision.reason,
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
