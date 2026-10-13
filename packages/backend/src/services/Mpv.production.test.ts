import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime, TestClock, TestContext } from "effect"
import exampleConfig from "../../../../config.example.json"
import { Config, type RuntimeConfig } from "./Config.js"
import { Logger } from "./Logger.js"
import { makeMpvLive, Mpv, type MpvSocket, type MpvSocketHandlers } from "./Mpv.js"

const makeFixture = async () => {
  let handlers!: MpvSocketHandlers
  let respond = true
  let writeError = false
  let partialWrite = false
  const requests: { request_id: number; command: unknown[] }[] = []
  let onWrite: (() => void) | undefined
  const reply = (id: number, error = "success") =>
    handlers.data(socket, Buffer.from(JSON.stringify({ request_id: id, error }) + "\n"))
  const socket: MpvSocket = {
    write(payload) {
      if (writeError) throw new Error("write failed")
      if (partialWrite) return 1
      const request = JSON.parse(payload)
      requests.push(request)
      onWrite?.()
      if (respond) reply(request.request_id)
      return Buffer.byteLength(payload)
    },
    end() {},
  }
  const runtime = ManagedRuntime.make(
    makeMpvLive({
      spawn: () => ({ pid: 123, kill() {}, exited: Promise.resolve(0) }),
      connect: async (_path, callbacks) => { handlers = callbacks; return socket },
      removeSocket() {},
    }).pipe(
      Layer.provide(Layer.succeed(Config, exampleConfig as RuntimeConfig)),
      Layer.provide(Layer.succeed(Logger, {
        info: () => Effect.void, warn: () => Effect.void,
        error: () => Effect.void, debug: () => Effect.void,
      })),
      Layer.provideMerge(TestContext.TestContext),
    )
  )
  const mpv = await runtime.runPromise(Mpv)
  return {
    runtime, mpv, requests, reply,
    setRespond(value: boolean) { respond = value },
    setWriteError(value: boolean) { writeError = value },
    setPartialWrite(value: boolean) { partialWrite = value },
    nextWrite() { return new Promise<void>((resolve) => { onWrite = () => { onWrite = undefined; resolve() } }) },
    disconnect() { handlers.close(socket) },
    socketError() { handlers.error(socket, new Error("peer failed")) },
  }
}

const failureReason = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isSuccess(exit)) throw new Error("expected failed request")
  const error = Cause.failureOption(exit.cause)
  if (error._tag === "None") throw new Error(Cause.pretty(exit.cause))
  return (error.value as { _tag: string; reason: string })
}

test("socket disconnect fails outstanding playback promptly and rejects later commands", async () => {
  const f = await makeFixture()
  try {
    f.setRespond(false)
    const written = f.nextWrite()
    const result = f.runtime.runPromiseExit(f.mpv.pause())
    await written
    f.disconnect()
    await f.runtime.runPromise(TestClock.adjust(1))
    const timeout = f.runtime.runPromise(TestClock.adjust("5 seconds"))
    const error = failureReason(await result)
    await timeout
    expect(error._tag).toBe("MpvIpcError")
    expect(error.reason).toContain("closed")
    f.setRespond(true)
    const count = f.requests.length
    expect(failureReason(await f.runtime.runPromiseExit(f.mpv.resume())).reason).toContain("closed")
    expect(f.requests.length).toBe(count)
  } finally {
    await f.runtime.dispose()
  }
})

test("a partial socket write fails immediately and prevents sending into the truncated stream", async () => {
  const f = await makeFixture()
  try {
    f.setRespond(false)
    f.setPartialWrite(true)
    const result = f.runtime.runPromiseExit(f.mpv.pause())
    await f.runtime.runPromise(TestClock.adjust("5 seconds"))
    expect(failureReason(await result).reason).toContain("Incomplete")
    f.setPartialWrite(false)
    expect(failureReason(await f.runtime.runPromiseExit(f.mpv.resume())).reason).toContain("Incomplete")
  } finally { await f.runtime.dispose() }
})

test("timeouts discard late responses and leave subsequent healthy playback intact", async () => {
  const f = await makeFixture()
  try {
    f.setRespond(false)
    const written = f.nextWrite()
    const result = f.runtime.runPromiseExit(f.mpv.pause())
    await written
    const oldId = f.requests.at(-1)!.request_id
    await f.runtime.runPromise(TestClock.adjust("5 seconds"))
    expect(failureReason(await result).reason).toContain("timed out")
    const nextWritten = f.nextWrite()
    const next = f.runtime.runPromise(f.mpv.play("healthy", "/healthy.mp4"))
    await nextWritten
    f.reply(oldId, "command failed")
    f.setRespond(true)
    f.reply(f.requests.at(-1)!.request_id)
    await next
    expect(await f.runtime.runPromise(f.mpv.status())).toMatchObject({
      playing: true, current_workshop_id: "healthy",
    })
    await f.runtime.runPromise(TestClock.adjust("5 seconds"))
    expect((await f.runtime.runPromise(f.mpv.status())).playing).toBe(true)
  } finally { await f.runtime.dispose() }
})

test("cancellation before dispatch never sends a stale command", async () => {
  const f = await makeFixture()
  try {
    const count = f.requests.length
    await f.runtime.runPromise(Effect.gen(function* () {
      const fiber = yield* Effect.fork(f.mpv.play("cancelled", "/cancelled.mp4"))
      yield* Fiber.interrupt(fiber)
    }))
    await f.runtime.runPromise(f.mpv.play("healthy", "/healthy.mp4"))
    expect(f.requests.slice(count).some((r) => r.command.includes("/cancelled.mp4"))).toBe(false)
    expect((await f.runtime.runPromise(f.mpv.status())).current_workshop_id).toBe("healthy")
  } finally { await f.runtime.dispose() }
})

test("service shutdown settles in-flight calls and rejects calls through a retained service", async () => {
  const f = await makeFixture()
  try {
    f.setRespond(false)
    const written = f.nextWrite()
    const result = Effect.runPromiseExit(f.mpv.pause())
    await written
    await f.runtime.dispose()
    expect(failureReason(await result).reason).toContain("service closed")
    expect(failureReason(await Effect.runPromiseExit(f.mpv.resume())).reason).toContain("service closed")
  } finally { await f.runtime.dispose() }
})

test("cancelled dispatched calls cannot interfere with later playback", async () => {
  const f = await makeFixture()
  try {
    f.setRespond(false)
    const written = f.nextWrite()
    const cancelled = f.runtime.runFork(f.mpv.pause())
    await written
    const oldId = f.requests.at(-1)!.request_id
    await Effect.runPromise(Fiber.interrupt(cancelled))
    f.reply(oldId)
    f.setRespond(true)
    await f.runtime.runPromise(f.mpv.play("healthy", "/healthy.mp4"))
    await f.runtime.runPromise(TestClock.adjust("5 seconds"))
    expect((await f.runtime.runPromise(f.mpv.status())).current_workshop_id).toBe("healthy")
  } finally { await f.runtime.dispose() }
})

test("write failures leave healthy requests usable without accepting stale replies", async () => {
  const f = await makeFixture()
  try {
    for (let i = 0; i < 3; i++) {
      f.setWriteError(true)
      expect(failureReason(await f.runtime.runPromiseExit(f.mpv.pause())).reason).toContain("Failed to write")
      f.setWriteError(false)
      f.setRespond(false)
      const written = f.nextWrite()
      const healthy = f.runtime.runPromise(f.mpv.play("healthy", "/healthy.mp4"))
      await written
      const id = f.requests.at(-1)!.request_id
      f.reply(id - 1, "command failed")
      f.setRespond(true)
      f.reply(id)
      await healthy
      expect((await f.runtime.runPromise(f.mpv.status())).current_workshop_id).toBe("healthy")
    }
  } finally { await f.runtime.dispose() }
})

test("mpv error responses fail just their caller and later commands still succeed", async () => {
  const f = await makeFixture()
  try {
    f.setRespond(false)
    const written = f.nextWrite()
    const result = f.runtime.runPromiseExit(f.mpv.play("missing", "/missing.mp4"))
    await written
    f.reply(f.requests.at(-1)!.request_id, "loading failed")
    expect(failureReason(await result).reason).toBe("mpv error: loading failed")
    expect((await f.runtime.runPromise(f.mpv.status())).current_workshop_id).toBeNull()
    f.setRespond(true)
    await f.runtime.runPromise(f.mpv.play("healthy", "/healthy.mp4"))
    expect((await f.runtime.runPromise(f.mpv.status())).current_workshop_id).toBe("healthy")
  } finally { await f.runtime.dispose() }
})

test("socket errors settle all concurrent calls before their command deadlines", async () => {
  const f = await makeFixture()
  try {
    f.setRespond(false)
    const firstWritten = f.nextWrite()
    const first = f.runtime.runPromiseExit(f.mpv.pause())
    await firstWritten
    const secondWritten = f.nextWrite()
    const second = f.runtime.runPromiseExit(f.mpv.stop())
    await secondWritten
    f.socketError()
    expect(failureReason(await first).reason).toContain("peer failed")
    expect(failureReason(await second).reason).toContain("peer failed")
    f.reply(f.requests.at(-1)!.request_id)
    expect(failureReason(await f.runtime.runPromiseExit(f.mpv.resume())).reason).toContain("peer failed")
  } finally { await f.runtime.dispose() }
})
