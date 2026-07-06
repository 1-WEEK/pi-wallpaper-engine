import { Elysia, t } from "elysia"
import { Effect, Stream } from "effect"
import { Mpv } from "../services/Mpv.js"
import { Playback } from "../services/Playback.js"
import { PlayerWatch } from "../services/PlayerWatch.js"
import { httpFromError } from "./httpError.js"
import type { AppContext, AppRuntime } from "../runtime.js"
import type { AuthService } from "../services/Auth.js"

export const playerRoutes = (runtime: AppRuntime, auth: AuthService | null = null) => {
  // Funnel a route's effect through the canonical error→HTTP mapping. Closes
  // over `runtime` so the AppContext R channel stays inferred (no need to name
  // it). Owns only the error path — success status codes (none in this router)
  // stay inside the effect.
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

  return new Elysia({ prefix: "/api/player" })
    .post("/play/:workshopId", ({ params, set }) =>
      runRoute(
        set,
        Effect.gen(function* () {
          const playback = yield* Playback
          return yield* playback.play(params.workshopId)
        })
      )
    )
    .post("/pause", ({ set }) =>
      runRoute(
        set,
        Effect.gen(function* () {
          const mpv = yield* Mpv
          yield* mpv.pause()
          return { ok: true }
        })
      )
    )
    .post("/resume", ({ set }) =>
      // Previously returned 200 even on failure (catchAll → succeed without
      // setting status). runRoute maps MpvIpcError to 500 — a failed resume
      // should not report success. Intentional contract fix (was a latent bug).
      runRoute(
        set,
        Effect.gen(function* () {
          const mpv = yield* Mpv
          yield* mpv.resume()
          return { ok: true }
        })
      )
    )
    .post("/stop", ({ set }) =>
      runRoute(
        set,
        Effect.gen(function* () {
          const playback = yield* Playback
          return yield* playback.stop()
        })
      )
    )
    .post(
      "/display-mode",
      ({ body, set }) =>
        runRoute(
          set,
          Effect.gen(function* () {
            const mpv = yield* Mpv
            yield* mpv.setDisplayMode(body.mode)
            return { ok: true }
          })
        ),
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
    .post(
      "/mode",
      ({ body, set }) =>
        runRoute(
          set,
          Effect.gen(function* () {
            const playback = yield* Playback
            yield* playback.setMode(body.mode)
            return { ok: true, mode: body.mode }
          })
        ),
      {
        body: t.Object({
          mode: t.Union([t.Literal("single"), t.Literal("sequential"), t.Literal("shuffle")]),
        }),
      }
    )
    .post("/next", ({ set }) =>
      runRoute(
        set,
        Effect.gen(function* () {
          const playback = yield* Playback
          yield* playback.next()
          return { ok: true }
        })
      )
    )
    .post("/prev", ({ set }) =>
      runRoute(
        set,
        Effect.gen(function* () {
          const playback = yield* Playback
          yield* playback.prev()
          return { ok: true }
        })
      )
    )
    .post(
      "/sleep",
      ({ body, set }) =>
        runRoute(
          set,
          Effect.gen(function* () {
            const playback = yield* Playback
            return yield* playback.sleep(body.minutes)
          })
        ),
      {
        body: t.Object({ minutes: t.Number() }),
      }
    )
    .post(
      "/interval",
      ({ body, set }) =>
        runRoute(
          set,
          Effect.gen(function* () {
            const playback = yield* Playback
            yield* playback.setRotationInterval(body.seconds)
            return { ok: true, seconds: body.seconds }
          })
        ),
      {
        body: t.Object({ seconds: t.Number() }),
      }
    )
    .ws("/watch", {
      open: async (ws) => {
        // WebSocket frames bypass the global sessionGuard onBeforeHandle, so
        // when auth is enabled we re-check the cookie session here, matching
        // the download/progress WS pattern.
        if (auth) {
          const headers = new Headers()
          const cookieHeader = (ws.data as { headers?: Record<string, string | undefined> }).headers
            ?.cookie
          if (cookieHeader) headers.set("cookie", cookieHeader)
          const session = await auth.instance.api.getSession({ headers }).catch(() => null)
          if (!session) {
            try {
              ws.send(JSON.stringify({ error: "Authentication required" }))
            } catch {
              // ignore
            }
            ws.close()
            return
          }
        }

        const initial = await runtime
          .runPromise(
            Effect.gen(function* () {
              const watch = yield* PlayerWatch
              return yield* watch.current()
            })
          )
          .catch(() => null)
        if (initial) {
          try {
            ws.send(JSON.stringify(initial))
          } catch {
            // ignore send-after-close
          }
        }

        const fiber = runtime.runFork(
          Effect.gen(function* () {
            const watch = yield* PlayerWatch
            yield* watch.stream().pipe(
              Stream.runForEach((snap) =>
                Effect.sync(() => {
                  try {
                    ws.send(JSON.stringify(snap))
                  } catch {
                    // ignore send-after-close
                  }
                })
              )
            )
          })
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
