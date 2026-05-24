import { Elysia } from "elysia"
import { Effect } from "effect"
import { Display } from "../services/Display.js"
import { PlayerPower } from "../services/PlayerPower.js"
import type { AppRuntime } from "../runtime.js"

export const displayRoutes = (runtime: AppRuntime) =>
  new Elysia({ prefix: "/api/display" })
    .post("/on", ({ set }) =>
      runtime
        .runPromise(
          Effect.gen(function* () {
            const playerPower = yield* PlayerPower
            return yield* playerPower.displayOn()
          })
        )
        .catch((err) => {
          const kind = (err as { kind?: string }).kind
          set.status = kind === "NotConfigured" ? 503 : 500
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            kind,
            stderr: (err as { stderr?: string }).stderr,
          }
        })
    )
    .post("/off", ({ set }) =>
      runtime
        .runPromise(
          Effect.gen(function* () {
            const playerPower = yield* PlayerPower
            return yield* playerPower.displayOff()
          })
        )
        .catch((err) => {
          const kind = (err as { kind?: string }).kind
          set.status = kind === "NotConfigured" ? 503 : 500
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            kind,
            stderr: (err as { stderr?: string }).stderr,
          }
        })
    )
    .get("/status", ({ set }) =>
      runtime
        .runPromise(
          Effect.gen(function* () {
            const display = yield* Display
            return yield* display.status()
          })
        )
        .catch((err) => {
          const kind = (err as { kind?: string }).kind
          set.status = kind === "NotConfigured" ? 503 : 500
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            kind,
          }
        })
    )
