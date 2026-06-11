import { Elysia, t } from "elysia"
import { Effect } from "effect"
import type { DisplayMode } from "@pwe/shared"
import { Library } from "../services/Library.js"
import { httpFromError } from "./httpError.js"
import type { AppContext, AppRuntime } from "../runtime.js"

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
