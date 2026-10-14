import { expect, test } from "bun:test"
import { TestClock } from "effect/testing"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime } from "effect"
import { Config, type RuntimeConfig } from "./Config.js"
import { Display, DisplayLive } from "./Display.js"
import { Logger } from "./Logger.js"

const gate = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const fixture = async (mode: "ignore-term" | "held-stderr") => {
  const dir = mkdtempSync(join(tmpdir(), "pwe-display-"))
  const path = join(dir, "events.sock")
  const script = join(dir, "command.ts")
  const ready = gate<number>()
  const terminated = gate<void>()
  const closed = gate<void>()
  const descendant = gate<number>()
  const descendantClosed = gate<void>()
  const pids: number[] = []
  const server = Bun.listen<{ buffer: string; descendant?: boolean }>({
    unix: path,
    socket: {
      open(socket) { socket.data = { buffer: "" } },
      data(socket, data) {
        socket.data.buffer += data.toString()
        while (socket.data.buffer.includes("\n")) {
          const at = socket.data.buffer.indexOf("\n")
          const line = socket.data.buffer.slice(0, at)
          socket.data.buffer = socket.data.buffer.slice(at + 1)
          const event = JSON.parse(line)
          if (event.kind === "ready") { pids.push(event.pid); ready.resolve(event.pid) }
          if (event.kind === "term") terminated.resolve()
          if (event.kind === "descendant") { pids.push(event.pid); socket.data.descendant = true; descendant.resolve(event.pid) }
        }
      },
      close(socket) { if (socket.data?.descendant) descendantClosed.resolve(); else closed.resolve() },
    },
  })
  writeFileSync(script, `
const mode = process.argv[3]
const connection = await Bun.connect({ unix: process.argv[2], socket: { data() {}, close() {}, error() {} } })
if (mode === "held-stderr") {
  Bun.spawn([process.execPath, "--eval", \`
    const peer = await Bun.connect({ unix: process.argv[1], socket: { data() {}, close() {}, error() {} } });
    peer.write(JSON.stringify({ kind: "descendant", pid: process.pid }) + String.fromCharCode(10));
    setInterval(() => {}, 1000)
  \`, process.argv[2]], {
    stdout: "ignore", stderr: "inherit", stdin: "ignore", onExit() {},
  })
  connection.write(JSON.stringify({ kind: "ready", pid: process.pid }) + "\\n")
  connection.end()
  process.exit(0)
}
process.on("SIGTERM", () => connection.write(JSON.stringify({ kind: "term" }) + "\\n"))
connection.write(JSON.stringify({ kind: "ready", pid: process.pid }) + "\\n")
setInterval(() => {}, 1000)
`)
  const config = Layer.succeed(Config, {
    display: { on_command: [process.execPath, script, path, mode], off_command: ["sh", "-c", "exit 0"] },
  } as unknown as RuntimeConfig)
  const runtime = ManagedRuntime.make(DisplayLive.pipe(
    Layer.provide(config),
    Layer.provide(Layer.succeed(Logger, {
      info: () => Effect.void, warn: () => Effect.void, error: () => Effect.void, debug: () => Effect.void,
    })),
    Layer.provideMerge(TestClock.layer()),
  ))
  const display = await runtime.runPromise(Display)
  return {
    runtime, display, ready, terminated, closed, descendant, descendantClosed, pids,
    advance: (ms: number) => runtime.runPromise(TestClock.adjust(ms)),
    async dispose() {
      for (const pid of pids) { try { process.kill(pid, "SIGKILL") } catch {} }
      if (pids.length) await within(closed.promise)
      if (pids.length > 1) await within(descendantClosed.promise)
      await runtime.dispose()
      server.stop(true)
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const timeoutError = (exit: Exit.Exit<void, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isSuccess(exit)) throw new Error("expected display timeout")
  const failure = Cause.findErrorOption(exit.cause)
  if (failure._tag === "None") throw new Error(Cause.pretty(exit.cause))
  expect(failure.value).toMatchObject({ _tag: "DisplayError", kind: "Timeout" })
}

// Watchdog diagnoses a missing controlled deadline; it does not advance behavior.
const within = <T>(promise: Promise<T>) => Promise.race([
  promise,
  new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("controlled display deadline did not settle")), 1_000); promise.finally(() => clearTimeout(timer)).catch(() => {}) }),
])

test("display timeout kills a command ignoring TERM and leaves later controls usable", async () => {
  const f = await fixture("ignore-term")
  try {
    const result = f.runtime.runPromiseExit(f.display.on().pipe(Effect.uninterruptible))
    const pid = await within(f.ready.promise)
    await f.advance(5_000)
    await within(f.terminated.promise)
    await f.advance(1_000)
    timeoutError(await within(result))
    await within(f.closed.promise)
    expect(() => process.kill(pid, 0)).toThrow()
    await f.runtime.runPromise(f.display.off())
    expect(await f.runtime.runPromise(f.display.status())).toEqual({ state: "off", source: "cached" })
  } finally { await f.dispose() }
})


test("an exited display command with descendant-held stderr times out without holding later controls", async () => {
  const f = await fixture("held-stderr")
  try {
    const result = f.runtime.runPromiseExit(f.display.on())
    await within(f.ready.promise)
    const descendant = await within(f.descendant.promise)
    await within(f.closed.promise)
    expect(() => process.kill(descendant, 0)).not.toThrow()
    await f.advance(5_000)
    timeoutError(await within(result))
    await f.runtime.runPromise(f.display.off())
    expect(await f.runtime.runPromise(f.display.status())).toEqual({ state: "off", source: "cached" })
  } finally { await f.dispose() }
})

test("scope shutdown remains bounded while a power command masks interruption", async () => {
  const f = await fixture("ignore-term")
  try {
    const closedScope = f.runtime.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* Effect.forkScoped(f.display.on().pipe(Effect.uninterruptible, Effect.ignore))
      yield* Effect.promise(() => f.ready.promise)
    })))
    const pid = await within(f.ready.promise)
    // Shutdown waits for owned termination whether cancellation or deadline wins.
    await f.advance(5_000)
    await within(f.terminated.promise)
    await f.advance(1_000)
    await within(closedScope)
    expect(() => process.kill(pid, 0)).toThrow()
    await f.runtime.runPromise(f.display.off())
  } finally { await f.dispose() }
})


test("interrupting a display request waits for its ignored-TERM command to be killed", async () => {
  const f = await fixture("ignore-term")
  try {
    const fiber = f.runtime.runFork(f.display.on())
    const pid = await within(f.ready.promise)
    const interrupted = f.runtime.runPromise(Fiber.interrupt(fiber))
    await within(f.terminated.promise)
    await f.advance(1_000)
    await within(interrupted)
    expect(() => process.kill(pid, 0)).toThrow()
    await f.runtime.runPromise(f.display.off())
  } finally { await f.dispose() }
})
