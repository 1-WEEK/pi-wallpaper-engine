import { Elysia, t } from "elysia"
import { Effect, Stream } from "effect"
import { resolve, sep } from "node:path"
import type { DisplayMode, LibraryItem } from "@pwe/shared"
import { Config } from "../services/Config.js"
import { Db } from "../services/Db.js"
import { Library } from "../services/Library.js"
import { Storage } from "../services/Storage.js"
import { TranscodeQueue } from "../services/TranscodeQueue.js"
import { decideTranscode, type TranscodeSourceSpec } from "../transcode/decide.js"
import { httpFromError } from "./httpError.js"
import { transcodeMode, type AppContext, type AppRuntime } from "../runtime.js"
import type { AuthService } from "../services/Auth.js"

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

export const libraryRoutes = (runtime: AppRuntime, auth: AuthService | null = null) => {
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
    .get("/:workshopId/stream", async ({ params, request }) => {
      const located = await runtime
        .runPromise(
          Effect.gen(function* () {
            const lib = yield* Library
            const storage = yield* Storage
            const config = yield* Config
            const row = yield* lib.get(params.workshopId)
            const root = yield* storage.mediaRoot()
            return { row, root, optimizedDir: config.paths.optimized_dir }
          }).pipe(Effect.catchAll(() => Effect.succeed(null)))
        )
        .catch(() => null)

      const notFound = () =>
        new Response(JSON.stringify({ error: "No streamable optimized file." }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })

      if (!located) return notFound()
      const { row, root, optimizedDir } = located
      if (row.transcode_status !== "completed" || !row.transcoded_path) return notFound()

      // Only files under optimized/ are streamable, and a hostile
      // transcoded_path ("../../etc/...") must never escape it.
      const optimizedRoot = resolve(root, optimizedDir)
      const abs = resolve(root, row.transcoded_path)
      if (abs !== optimizedRoot && !abs.startsWith(optimizedRoot + sep)) return notFound()

      const file = Bun.file(abs)
      if (!(await file.exists())) return notFound()
      const size = file.size

      const rangeHeader = request.headers.get("range")
      if (!rangeHeader) {
        return new Response(file, {
          status: 200,
          headers: {
            "content-type": "video/mp4",
            "accept-ranges": "bytes",
            "content-length": String(size),
          },
        })
      }

      const unsatisfiable = () =>
        new Response(null, {
          status: 416,
          headers: { "content-range": `bytes */${size}` },
        })

      // bytes=start-end | bytes=start- | bytes=-suffix (single range only —
      // browsers never ask for multipart ranges when scrubbing video).
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
      if (!match || (match[1] === "" && match[2] === "")) return unsatisfiable()

      let start: number
      let end: number
      if (match[1] === "") {
        const suffix = Number(match[2])
        if (suffix === 0) return unsatisfiable()
        start = Math.max(0, size - suffix)
        end = size - 1
      } else {
        start = Number(match[1])
        end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1)
      }
      if (start >= size || end < start) return unsatisfiable()

      return new Response(file.slice(start, end + 1), {
        status: 206,
        headers: {
          "content-type": "video/mp4",
          "accept-ranges": "bytes",
          "content-length": String(end - start + 1),
          "content-range": `bytes ${start}-${end}/${size}`,
        },
      })
    })
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
    .ws("/transcode/watch", {
      open: async (ws) => {
        // WebSocket frames bypass the global sessionGuard onBeforeHandle, so
        // when auth is enabled we re-check the cookie session here.
        if (auth) {
          const headers = new Headers()
          const cookieHeader = (ws.data as { headers?: Record<string, string | undefined> }).headers
            ?.cookie
          if (cookieHeader) headers.set("cookie", cookieHeader)
          const session = await auth.instance.api
            .getSession({ headers })
            .catch(() => null)
          if (!session) {
            try {
              ws.send(JSON.stringify({ status: "failed", error: "Authentication required" }))
            } catch {
              // ignore
            }
            ws.close()
            return
          }
        }

        const stream = await runtime.runPromise(
          Effect.gen(function* () {
            const queue = yield* TranscodeQueue
            return queue.watch()
          })
        )

        const fiber = runtime.runFork(
          stream.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                try {
                  ws.send(JSON.stringify(event))
                } catch {
                  // ignore send-after-close
                }
              })
            )
          )
        )
        ;(ws.data as Record<string, unknown>)["fiber"] = fiber
      },
      close: (ws) => {
        const fiber = (ws.data as Record<string, unknown>)["fiber"] as
          | ReturnType<AppRuntime["runFork"]>
          | undefined
        if (fiber) {
          runtime.runFork(fiber.interruptAsFork(fiber.id()))
        }
      },
    })
}
