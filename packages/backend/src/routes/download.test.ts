import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime, PubSub, Stream } from "effect"
import { Elysia } from "elysia"
import { DownloadIntake, type DownloadIntakeImpl, type DownloadProgressEvent } from "../services/DownloadIntake.js"
import { DownloadTasks, type DownloadTasksImpl } from "../services/DownloadTasks.js"
import { downloadRoutes } from "./download.js"

const makeTasks = (): DownloadTasksImpl => ({
  list: () => Effect.succeed([]),
  get: () => Effect.succeed(null),
  upsert: () => Effect.void,
  dismiss: () => Effect.void,
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for WebSocket message")), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const makeRuntime = (intake: DownloadIntakeImpl) =>
  ManagedRuntime.make(
    Layer.succeed(DownloadIntake, intake).pipe(
      Layer.provideMerge(Layer.succeed(DownloadTasks, makeTasks()))
    )
  )

const buildApp = (intake: DownloadIntakeImpl) => {
  const runtime = makeRuntime(intake)
  const app = new Elysia().use(downloadRoutes(runtime as never))
  return { app, runtime }
}

let runtimes: Array<ManagedRuntime.ManagedRuntime<unknown, never>> = []
let servers: Array<{ stop: () => unknown }> = []

afterEach(async () => {
  for (const server of servers) {
    const stopped = server.stop()
    if (stopped instanceof Promise) await Promise.race([stopped, sleep(250)])
  }
  servers = []
  for (const runtime of runtimes) await runtime.dispose()
  runtimes = []
})

describe("download routes", () => {
  test("POST /:workshopId maps Started to the existing 202 body", async () => {
    const { app, runtime } = buildApp({
      start: (workshopId) => Effect.succeed({ _tag: "Started", workshopId }),
      cancel: () => Effect.succeed({ _tag: "NotFound", workshopId: "x", message: "missing" }),
      progressStream: () => Stream.empty,
    })
    runtimes.push(runtime as ManagedRuntime.ManagedRuntime<unknown, never>)

    const res = await app.handle(
      new Request("http://localhost/api/download/abc", { method: "POST" })
    )

    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ ok: true, workshopId: "abc", status: "started" })
  })

  test("POST /:workshopId maps AlreadyRunning to the existing 409 body", async () => {
    const { app, runtime } = buildApp({
      start: (workshopId) =>
        Effect.succeed({ _tag: "AlreadyRunning", workshopId, stage: "downloading" }),
      cancel: () => Effect.succeed({ _tag: "NotFound", workshopId: "x", message: "missing" }),
      progressStream: () => Stream.empty,
    })
    runtimes.push(runtime as ManagedRuntime.ManagedRuntime<unknown, never>)

    const res = await app.handle(
      new Request("http://localhost/api/download/abc", { method: "POST" })
    )

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      ok: false,
      error: "Download already in progress",
      workshopId: "abc",
      stage: "downloading",
    })
  })

  test("POST /:workshopId/cancel maps live cancellation to 202", async () => {
    const { app, runtime } = buildApp({
      start: (workshopId) => Effect.succeed({ _tag: "Started", workshopId }),
      cancel: (workshopId) => Effect.succeed({ _tag: "Cancelling", workshopId }),
      progressStream: () => Stream.empty,
    })
    runtimes.push(runtime as ManagedRuntime.ManagedRuntime<unknown, never>)

    const res = await app.handle(
      new Request("http://localhost/api/download/abc/cancel", { method: "POST" })
    )

    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ ok: true, workshopId: "abc", status: "cancelling" })
  })

  test("POST /:workshopId/cancel maps zombie cancellation to 202", async () => {
    const { app, runtime } = buildApp({
      start: (workshopId) => Effect.succeed({ _tag: "Started", workshopId }),
      cancel: (workshopId) => Effect.succeed({ _tag: "CancelledZombie", workshopId }),
      progressStream: () => Stream.empty,
    })
    runtimes.push(runtime as ManagedRuntime.ManagedRuntime<unknown, never>)

    const res = await app.handle(
      new Request("http://localhost/api/download/abc/cancel", { method: "POST" })
    )

    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ ok: true, workshopId: "abc", status: "cancelled" })
  })

  test("POST /:workshopId/cancel maps NotFound to 404", async () => {
    const { app, runtime } = buildApp({
      start: (workshopId) => Effect.succeed({ _tag: "Started", workshopId }),
      cancel: (workshopId) =>
        Effect.succeed({
          _tag: "NotFound",
          workshopId,
          message: "No active download for this workshop id",
        }),
      progressStream: () => Stream.empty,
    })
    runtimes.push(runtime as ManagedRuntime.ManagedRuntime<unknown, never>)

    const res = await app.handle(
      new Request("http://localhost/api/download/abc/cancel", { method: "POST" })
    )

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      ok: false,
      error: "No active download for this workshop id",
    })
  })

  test("WebSocket progress route forwards intake stream events", async () => {
    const pubsub = await Effect.runPromise(PubSub.unbounded<DownloadProgressEvent>())
    const { app, runtime } = buildApp({
      start: (workshopId) => Effect.succeed({ _tag: "Started", workshopId }),
      cancel: (workshopId) =>
        Effect.succeed({
          _tag: "NotFound",
          workshopId,
          message: "No active download for this workshop id",
        }),
      progressStream: (workshopId) =>
        Stream.fromPubSub(pubsub).pipe(Stream.filter((event) => event.workshopId === workshopId)),
    })
    runtimes.push(runtime as ManagedRuntime.ManagedRuntime<unknown, never>)

    const server = app.listen({ hostname: "127.0.0.1", port: 0 })
    servers.push(server)
    const port = app.server?.port
    if (!port) throw new Error("Elysia did not expose the test server port")

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/download/progress/abc`)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true })
      ws.addEventListener("error", () => reject(new Error("websocket failed to open")), {
        once: true,
      })
    })
    await sleep(25)

    const message = new Promise<string>((resolve) => {
      ws.addEventListener(
        "message",
        (event) => {
          resolve(String(event.data))
        },
        { once: true }
      )
    })

    await Effect.runPromise(
      pubsub.publish({ workshopId: "abc", stage: "complete", message: "Library updated" })
    )

    expect(JSON.parse(await withTimeout(message, 1_000))).toEqual({
      workshopId: "abc",
      stage: "complete",
      message: "Library updated",
    })

    await new Promise<void>((resolve) => {
      ws.addEventListener("close", () => resolve(), { once: true })
      ws.close()
      setTimeout(resolve, 100)
    })
  })
})
