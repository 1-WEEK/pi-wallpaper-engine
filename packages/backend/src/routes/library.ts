import { Elysia, t } from "elysia"
import { Effect } from "effect"
import type { DisplayMode } from "@pwe/shared"
import { Library } from "../services/Library.js"
import type { AppRuntime } from "../runtime.js"

export const libraryRoutes = (runtime: AppRuntime) =>
  new Elysia({ prefix: "/api/library" })
    .get("/", () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const lib = yield* Library
          return yield* lib.list()
        })
      )
    )
    .delete("/:workshopId", ({ params, set }) =>
      runtime
        .runPromise(
          Effect.gen(function* () {
            const lib = yield* Library
            yield* lib.remove(params.workshopId)
            return { ok: true }
          }).pipe(
            Effect.catchTag("LibraryNotFoundError", () =>
              Effect.sync(() => {
                set.status = 404
                return { error: "Not found" }
              })
            )
          )
        )
        .catch((e) => {
          set.status = 500
          return { error: e instanceof Error ? e.message : String(e) }
        })
    )
    .patch(
      "/:workshopId",
      ({ params, body, set }) =>
        runtime
          .runPromise(
            Effect.gen(function* () {
              const lib = yield* Library
              yield* lib.get(params.workshopId) // existence check
              const patch: Record<string, unknown> = {}
              if (body.display_mode) patch["display_mode"] = body.display_mode as DisplayMode
              yield* lib.update(params.workshopId, patch as never)
              return { ok: true }
            }).pipe(
              Effect.catchTag("LibraryNotFoundError", () =>
                Effect.sync(() => {
                  set.status = 404
                  return { error: "Not found" }
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
          display_mode: t.Optional(t.Union([t.Literal("fill"), t.Literal("fit"), t.Literal("stretch")])),
        }),
      }
    )
