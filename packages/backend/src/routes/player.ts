import { Elysia, t } from "elysia"
import { Effect } from "effect"
import { Library } from "../services/Library.js"
import { Mpv } from "../services/Mpv.js"
import type { AppRuntime } from "../runtime.js"

export const playerRoutes = (runtime: AppRuntime) =>
  new Elysia({ prefix: "/api/player" })
    .post("/play/:workshopId", ({ params, set }) =>
      runtime
        .runPromise(
          Effect.gen(function* () {
            const lib = yield* Library
            const mpv = yield* Mpv
            const item = yield* lib.get(params.workshopId)
            const path = yield* lib.playablePath(item)
            yield* mpv.play(item.workshop_id, path)
            yield* lib.update(item.workshop_id, { last_played_at: Date.now() })
            // Apply the item's stored display mode each time
            yield* mpv.setDisplayMode(item.display_mode)
            return { ok: true, path }
          }).pipe(
            Effect.catchTag("LibraryNotFoundError", () =>
              Effect.sync(() => {
                set.status = 404
                return { error: "Not found" }
              })
            ),
            Effect.catchTag("StorageError", (e) =>
              Effect.sync(() => {
                set.status = 503
                return { error: e.message }
              })
            ),
            Effect.catchTag("MpvIpcError", (e) =>
              Effect.sync(() => {
                set.status = 500
                return { error: `mpv: ${e.reason}` }
              })
            )
          )
        )
        .catch((e) => {
          set.status = 500
          return { error: e instanceof Error ? e.message : String(e) }
        })
    )
    .post("/pause", ({ set }) =>
      runtime
        .runPromise(
          Effect.gen(function* () {
            const mpv = yield* Mpv
            yield* mpv.pause()
            return { ok: true }
          }).pipe(
            Effect.catchTag("MpvIpcError", (e) =>
              Effect.sync(() => {
                set.status = 500
                return { error: e.reason }
              })
            )
          )
        )
        .catch((e) => {
          set.status = 500
          return { error: e instanceof Error ? e.message : String(e) }
        })
    )
    .post("/resume", () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const mpv = yield* Mpv
          yield* mpv.resume()
          return { ok: true }
        }).pipe(Effect.catchAll((e) => Effect.succeed({ error: String(e) })))
      )
    )
    .post("/stop", () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const mpv = yield* Mpv
          yield* mpv.stop()
          return { ok: true }
        }).pipe(Effect.catchAll((e) => Effect.succeed({ error: String(e) })))
      )
    )
    .post(
      "/display-mode",
      ({ body, set }) =>
        runtime
          .runPromise(
            Effect.gen(function* () {
              const mpv = yield* Mpv
              yield* mpv.setDisplayMode(body.mode)
              return { ok: true }
            }).pipe(
              Effect.catchTag("MpvIpcError", (e) =>
                Effect.sync(() => {
                  set.status = 500
                  return { error: e.reason }
                })
              )
            )
          )
          .catch((e) => {
            set.status = 500
            return { error: e instanceof Error ? e.message : String(e) }
          }),
      {
        body: t.Object({
          mode: t.Union([t.Literal("fill"), t.Literal("fit"), t.Literal("stretch")]),
        }),
      }
    )
    .get("/status", () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const mpv = yield* Mpv
          return yield* mpv.status()
        })
      )
    )
