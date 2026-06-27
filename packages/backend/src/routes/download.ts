import { Elysia } from "elysia"
import { Effect, Stream } from "effect"
import { DownloadIntake, type DownloadCancelResult, type DownloadStartResult } from "../services/DownloadIntake.js"
import { DownloadTasks } from "../services/DownloadTasks.js"
import { httpFromError } from "./httpError.js"
import type { AppRuntime } from "../runtime.js"
import type { AuthService } from "../services/Auth.js"

export const downloadStartHttp = (
  result: DownloadStartResult
): { readonly status: number; readonly body: Record<string, unknown> } => {
  switch (result._tag) {
    case "Started":
      return {
        status: 202,
        body: { ok: true, workshopId: result.workshopId, status: "started" },
      }
    case "AlreadyRunning":
      return {
        status: 409,
        body: {
          ok: false,
          error: "Download already in progress",
          workshopId: result.workshopId,
          stage: result.stage,
        },
      }
    case "StorageUnavailable":
      return { status: 503, body: { ok: false, error: result.message } }
    case "MigrationRunning":
      return { status: 503, body: { ok: false, error: result.message } }
  }
}

export const downloadCancelHttp = (
  result: DownloadCancelResult
): { readonly status: number; readonly body: Record<string, unknown> } => {
  switch (result._tag) {
    case "Cancelling":
      return {
        status: 202,
        body: { ok: true, workshopId: result.workshopId, status: "cancelling" },
      }
    case "CancelledZombie":
      return {
        status: 202,
        body: { ok: true, workshopId: result.workshopId, status: "cancelled" },
      }
    case "NotFound":
      return { status: 404, body: { ok: false, error: result.message } }
  }
}

export const downloadRoutes = (runtime: AppRuntime, auth: AuthService | null = null) =>
  new Elysia({ prefix: "/api/download" })
    .post("/:workshopId", async ({ params, set }) => {
      try {
        const result = await runtime.runPromise(
          Effect.gen(function* () {
            const intake = yield* DownloadIntake
            return yield* intake.start(params.workshopId)
          })
        )
        const response = downloadStartHttp(result)
        set.status = response.status
        return response.body
      } catch (err) {
        const response = httpFromError(err as { _tag?: string })
        set.status = response.status
        return { ok: false, ...response.body }
      }
    })

    .post("/:workshopId/cancel", async ({ params, set }) => {
      try {
        const result = await runtime.runPromise(
          Effect.gen(function* () {
            const intake = yield* DownloadIntake
            return yield* intake.cancel(params.workshopId)
          })
        )
        const response = downloadCancelHttp(result)
        set.status = response.status
        return response.body
      } catch (err) {
        const response = httpFromError(err as { _tag?: string })
        set.status = response.status
        return { ok: false, ...response.body }
      }
    })

    .get("/tasks", () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const tasks = yield* DownloadTasks
          return yield* tasks.list()
        })
      )
    )

    .delete("/tasks/:workshopId", ({ params }) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const tasks = yield* DownloadTasks
          yield* tasks.dismiss(params.workshopId)
          return { ok: true }
        })
      )
    )

    .ws("/progress/:workshopId", {
      open: async (ws) => {
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
              ws.send(JSON.stringify({ stage: "error", message: "Authentication required" }))
            } catch {
              // ignore
            }
            ws.close()
            return
          }
        }

        const workshopId = (ws.data.params as { workshopId: string }).workshopId
        const stream = await runtime.runPromise(
          Effect.gen(function* () {
            const intake = yield* DownloadIntake
            return intake.progressStream(workshopId)
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
