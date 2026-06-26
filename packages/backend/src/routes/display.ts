import { Elysia } from "elysia"
import { Effect } from "effect"
import { Display } from "../services/Display.js"
import { PlayerPower } from "../services/PlayerPower.js"
import { Rotation } from "../services/Rotation.js"
import { httpFromError } from "./httpError.js"
import type { AppContext, AppRuntime } from "../runtime.js"

export const displayRoutes = (runtime: AppRuntime) => {
  // See player.ts for the rationale. DisplayError maps NotConfigured -> 503,
  // else 500 (same as the previous hand-rolled kind check); MpvIpcError -> 500.
  // The previous `{ ok, error, kind, stderr }` error bodies collapse to
  // `{ error }` — the frontend's json() helper only reads `error` on failure.
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

  return new Elysia({ prefix: "/api/display" })
    .post("/on", ({ set }) =>
      runRoute(
        set,
        Effect.gen(function* () {
          const playerPower = yield* PlayerPower
          return yield* playerPower.displayOn()
        })
      )
    )
    .post("/off", ({ set }) =>
      runRoute(
        set,
        Effect.gen(function* () {
          const playerPower = yield* PlayerPower
          const rotation = yield* Rotation
          yield* rotation.disarm()
          return yield* playerPower.displayOff()
        })
      )
    )
    .get("/status", ({ set }) =>
      runRoute(
        set,
        Effect.gen(function* () {
          const display = yield* Display
          return yield* display.status()
        })
      )
    )
}
