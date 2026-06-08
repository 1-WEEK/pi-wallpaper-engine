import { Elysia, t } from "elysia"
import { Effect, Stream } from "effect"
import { Mpv } from "../services/Mpv.js"
import { PlayerPower } from "../services/PlayerPower.js"
import { PlayerWatch } from "../services/PlayerWatch.js"
import { Rotation } from "../services/Rotation.js"
import type { AppRuntime } from "../runtime.js"
import type { AuthService } from "../services/Auth.js"

export const playerRoutes = (runtime: AppRuntime, auth: AuthService | null = null) =>
  new Elysia({ prefix: "/api/player" })
    .post("/play/:workshopId", ({ params, set }) =>
      runtime
        .runPromise(
          Effect.gen(function* () {
            const playerPower = yield* PlayerPower
            const rotation = yield* Rotation
            const result = yield* playerPower.play(params.workshopId)
            // Best-effort: a play succeeds even if arming rotation hiccups.
            yield* rotation.arm(params.workshopId).pipe(Effect.catchAll(() => Effect.void))
            return result
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
    .post("/stop", ({ set }) =>
      runtime
        .runPromise(
          Effect.gen(function* () {
            const playerPower = yield* PlayerPower
            const rotation = yield* Rotation
            yield* rotation.disarm()
            return yield* playerPower.stopForIdle()
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
    .post(
      "/mode",
      ({ body, set }) =>
        runtime
          .runPromise(
            Effect.gen(function* () {
              const rotation = yield* Rotation
              yield* rotation.setMode(body.mode)
              return { ok: true, mode: body.mode }
            }).pipe(
              Effect.catchAll((e) =>
                Effect.sync(() => {
                  set.status = 500
                  return { error: String(e) }
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
          mode: t.Union([t.Literal("single"), t.Literal("sequential"), t.Literal("shuffle")]),
        }),
      }
    )
    .post("/next", ({ set }) =>
      runtime
        .runPromise(
          Effect.gen(function* () {
            const rotation = yield* Rotation
            yield* rotation.next()
            return { ok: true }
          }).pipe(
            Effect.catchAll((e) =>
              Effect.sync(() => {
                set.status = 500
                return { error: String(e) }
              })
            )
          )
        )
        .catch((e) => {
          set.status = 500
          return { error: e instanceof Error ? e.message : String(e) }
        })
    )
    .post("/prev", ({ set }) =>
      runtime
        .runPromise(
          Effect.gen(function* () {
            const rotation = yield* Rotation
            yield* rotation.prev()
            return { ok: true }
          }).pipe(
            Effect.catchAll((e) =>
              Effect.sync(() => {
                set.status = 500
                return { error: String(e) }
              })
            )
          )
        )
        .catch((e) => {
          set.status = 500
          return { error: e instanceof Error ? e.message : String(e) }
        })
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
