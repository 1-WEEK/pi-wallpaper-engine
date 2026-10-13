import { expect, test } from "bun:test"
import { Effect, Exit, Fiber, Layer, ManagedRuntime, TestClock, TestContext } from "effect"
import exampleConfig from "../../../../config.example.json"
import { Config, type RuntimeConfig } from "./Config.js"
import { Logger } from "./Logger.js"
import { makeMpvLive, Mpv, type MpvSocketHandlers } from "./Mpv.js"
import { DbError, type LibraryItem } from "@pwe/shared"
import { Library } from "./Library.js"
import { PlaybackPrefs } from "./PlaybackPrefs.js"
import { Rotation, RotationLive } from "./Rotation.js"

const gate = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const fixture = async () => {
  const processes: {
    alive: boolean; commands: unknown[][]; kills: unknown[]; ends: number
    handlers?: MpvSocketHandlers; socket?: { write(payload: string): number; end(): void }
    exit: ReturnType<typeof gate<number>>
  }[] = []
  let pendingConnect: ReturnType<typeof gate<void>> | undefined
  let connecting = gate<void>()
  let killFails = false
  let unpauseFails = false
  let ignoreTerm = false
  let ignoreAllKills = false
  let removeFails = false
  let closeAfterReply = false
  let spawnFails = false
  const errors: string[] = []
  let removed = 0
  let commandGate: ReturnType<typeof gate<void>> | undefined
  let commandSent = gate<void>()
  let waitingCommand: ReturnType<typeof gate<void>> | undefined
  const runtime = ManagedRuntime.make(makeMpvLive({
    spawn: () => {
      if (spawnFails) throw new Error("binary missing")
      const p = { alive: true, commands: [] as unknown[][], kills: [] as unknown[], ends: 0, exit: gate<number>() }
      processes.push(p)
      return {
        pid: processes.length, exited: p.exit.promise,
        kill(signal?: unknown) {
          p.kills.push(signal)
          if (killFails) throw new Error("kill refused")
          if (ignoreAllKills) return
          if (ignoreTerm && signal !== "SIGKILL") return
          p.alive = false
          p.exit.resolve(0)
        },
      }
    },
    connect: async (_path, handlers) => {
      const p = processes.at(-1)!
      p.handlers = handlers
      const socket = {
        write(payload: string) {
          const message = JSON.parse(payload)
          p.commands.push(message.command)
          const error = unpauseFails && message.command[1] === "pause" && message.command[2] === false
            ? "command failed" : "success"
          const reply = () => {
            handlers.data(socket, Buffer.from(JSON.stringify({ request_id: message.request_id, error }) + "\n"))
            if (closeAfterReply) handlers.close(socket)
          }
          if (commandGate) {
            const held = commandGate
            commandGate = undefined
            commandSent.resolve()
            void held.promise.then(reply)
          } else reply()
          return Buffer.byteLength(payload)
        },
        end() { p.ends++ },
      }
      p.socket = socket
      connecting.resolve()
      if (pendingConnect) await pendingConnect.promise
      return socket
    },
    removeSocket() { if (removeFails) throw new Error("unlink refused"); removed++ },
  }).pipe(
    Layer.provide(Layer.succeed(Config, exampleConfig as RuntimeConfig)),
    Layer.provide(Layer.succeed(Logger, {
      info: () => Effect.void, warn: () => Effect.void,
      error: message => Effect.sync(() => { errors.push(message) }), debug: () => Effect.void,
    })),
    Layer.provideMerge(TestContext.TestContext),
  ))
  const mpv = await runtime.runPromise(Mpv)
  return {
    mpv, runtime, processes, errors,
    advance: (ms: number) => runtime.runPromise(TestClock.adjust(ms)),
    holdConnect() { pendingConnect = gate<void>(); connecting = gate<void>(); return connecting.promise },
    allowConnect() { pendingConnect?.resolve(); pendingConnect = undefined },
    holdCommand() {
      commandGate = gate<void>(); waitingCommand = commandGate; commandSent = gate<void>()
      return commandSent.promise
    },
    allowCommand() { waitingCommand?.resolve(); waitingCommand = undefined },
    failKill(value: boolean) { killFails = value },
    failUnpause(value: boolean) { unpauseFails = value },
    ignoreTerm(value: boolean) { ignoreTerm = value },
    ignoreAllKills(value: boolean) { ignoreAllKills = value },
    failRemove(value: boolean) { removeFails = value },
    closeAfterReply(value: boolean) { closeAfterReply = value },
    failSpawn(value: boolean) { spawnFails = value },
    removed: () => removed,
  }
}

test("empty startup and status inspection do not create a player", async () => {
  const f = await fixture()
  try {
    expect(await f.runtime.runPromise(f.mpv.status())).toMatchObject({ playing: false, path: null })
    expect(f.processes).toHaveLength(0)
    await f.runtime.runPromise(f.mpv.play("a", "/a.mp4"))
    expect(f.processes).toHaveLength(1)
    expect((await f.runtime.runPromise(f.mpv.status())).playing).toBe(true)
  } finally { await f.runtime.dispose() }
})

test("explicit release resolves child ownership before a fresh replay", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.mpv.play("a", "/a.mp4"))
    await f.runtime.runPromise(f.mpv.release())
    expect(f.processes[0]!.alive).toBe(false)
    expect((await f.runtime.runPromise(f.mpv.status())).path).toBeNull()
    await f.runtime.runPromise(f.mpv.play("b", "/b.mp4"))
    expect(f.processes).toHaveLength(2)
    expect(f.processes[0]!.ends).toBe(1)
    expect((await f.runtime.runPromise(f.mpv.status())).current_workshop_id).toBe("b")
  } finally { await f.runtime.dispose() }
})

test("stopped playback unloads immediately and exits at the 30 second boundary", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.mpv.play("a", "/a.mp4"))
    await f.runtime.runPromise(f.mpv.stop())
    expect(f.processes[0]!.commands).toContainEqual(["stop"])
    expect((await f.runtime.runPromise(f.mpv.status())).path).toBeNull()
    await f.advance(29_999)
    expect(f.processes[0]!.alive).toBe(true)
    await f.advance(1)
    expect(f.processes[0]!.alive).toBe(false)
  } finally { await f.runtime.dispose() }
})

test("quick replay reuses its process and an old idle deadline cannot stop newer playback", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.mpv.play("a", "/a.mp4"))
    await f.runtime.runPromise(f.mpv.stop())
    await f.advance(20_000)
    await f.runtime.runPromise(f.mpv.play("b", "/b.mp4"))
    await f.advance(10_000)
    expect(f.processes).toHaveLength(1)
    expect(f.processes[0]!.alive).toBe(true)
    expect((await f.runtime.runPromise(f.mpv.status())).current_workshop_id).toBe("b")
  } finally { await f.runtime.dispose() }
})

test("pause keeps loaded media and resume never reloads or recreates it", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.mpv.play("a", "/a.mp4"))
    await f.runtime.runPromise(f.mpv.pause())
    await f.advance(90_000)
    expect(await f.runtime.runPromise(f.mpv.status())).toMatchObject({ playing: false, path: "/a.mp4" })
    expect(f.processes[0]!.alive).toBe(true)
    await f.runtime.runPromise(f.mpv.resume())
    expect(f.processes[0]!.commands.filter(c => c[0] === "loadfile")).toHaveLength(1)
    expect((await f.runtime.runPromise(f.mpv.status())).playing).toBe(true)
  } finally { await f.runtime.dispose() }
})

test("concurrent cold plays wait for one connection and complete whole operations in order", async () => {
  const f = await fixture()
  try {
    const connected = f.holdConnect()
    const first = f.runtime.runFork(f.mpv.play("a", "/a.mp4"))
    await connected
    const second = f.runtime.runFork(f.mpv.play("b", "/b.mp4"))
    f.allowConnect()
    expect(Exit.isSuccess(await Effect.runPromise(Fiber.await(first)))).toBe(true)
    expect(Exit.isSuccess(await Effect.runPromise(Fiber.await(second)))).toBe(true)
    expect(f.processes).toHaveLength(1)
    expect(f.processes[0]!.commands.filter(c => c[0] === "loadfile")).toEqual([
      ["loadfile", "/a.mp4", "replace"], ["loadfile", "/b.mp4", "replace"],
    ])
    expect((await f.runtime.runPromise(f.mpv.status())).current_workshop_id).toBe("b")
  } finally { f.allowConnect(); await f.runtime.dispose() }
})

test("cancelled connection creation releases its child and a late socket cannot affect replay", async () => {
  const f = await fixture()
  try {
    const connected = f.holdConnect()
    const first = f.runtime.runFork(f.mpv.play("a", "/a.mp4"))
    await connected
    await Effect.runPromise(Fiber.interrupt(first))
    expect(f.processes[0]!.alive).toBe(false)
    f.allowConnect()
    await f.runtime.runPromise(f.mpv.play("b", "/b.mp4"))
    expect(f.processes).toHaveLength(2)
    f.processes[0]!.handlers!.close(f.processes[0]!.socket!)
    expect((await f.runtime.runPromise(f.mpv.status())).current_workshop_id).toBe("b")
  } finally { f.allowConnect(); await f.runtime.dispose() }
})

test("a failed play after loadfile releases ambiguous media and allows a healthy retry", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.mpv.play("a", "/a.mp4"))
    f.failUnpause(true)
    expect(Exit.isFailure(await f.runtime.runPromiseExit(f.mpv.play("b", "/b.mp4")))).toBe(true)
    expect(f.processes[0]!.alive).toBe(false)
    expect((await f.runtime.runPromise(f.mpv.status())).path).toBeNull()
    f.failUnpause(false)
    await f.runtime.runPromise(f.mpv.play("c", "/c.mp4"))
    expect(f.processes).toHaveLength(2)
    expect((await f.runtime.runPromise(f.mpv.status())).current_workshop_id).toBe("c")
  } finally { await f.runtime.dispose() }
})

test("unexpected child exit clears playback and the next play reaps the old generation", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.mpv.play("a", "/a.mp4"))
    f.processes[0]!.alive = false
    f.processes[0]!.exit.resolve(1)
    await f.advance(1)
    expect((await f.runtime.runPromise(f.mpv.status())).path).toBeNull()
    await f.runtime.runPromise(f.mpv.play("b", "/b.mp4"))
    expect(f.processes).toHaveLength(2)
    const old = f.processes[0]!
    old.handlers!.data(old.socket!, Buffer.from('{"event":"property-change","name":"fullscreen","data":false}\n'))
    old.handlers!.close(old.socket!)
    expect((await f.runtime.runPromise(f.mpv.status())).current_workshop_id).toBe("b")
    expect(f.processes[1]!.alive).toBe(true)
  } finally { await f.runtime.dispose() }
})

test("saved display mode applies to newly created generations without creating an idle player", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.mpv.setDisplayMode("stretch"))
    expect(f.processes).toHaveLength(0)
    await f.runtime.runPromise(f.mpv.play("a", "/a.mp4"))
    expect(f.processes[0]!.commands).toContainEqual(["set_property", "keepaspect", false])
    await f.runtime.runPromise(f.mpv.release())
    await f.runtime.runPromise(f.mpv.play("b", "/b.mp4"))
    expect(f.processes[1]!.commands).toContainEqual(["set_property", "keepaspect", false])
    expect((await f.runtime.runPromise(f.mpv.status())).display_mode).toBe("stretch")
  } finally { await f.runtime.dispose() }
})

test("resume after stop preserves unloaded idle state and does not cancel its release", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.mpv.play("a", "/a.mp4"))
    await f.runtime.runPromise(f.mpv.stop())
    await f.runtime.runPromise(f.mpv.resume())
    expect((await f.runtime.runPromise(f.mpv.status())).playing).toBe(false)
    await f.advance(30_000)
    expect(f.processes[0]!.alive).toBe(false)
  } finally { await f.runtime.dispose() }
})

test("shutdown interrupts pending connection creation and rejects retained controls", async () => {
  const f = await fixture()
  try {
    const connected = f.holdConnect()
    const playing = f.runtime.runFork(f.mpv.play("a", "/a.mp4"))
    await connected
    await f.runtime.dispose()
    expect(Exit.isFailure(await Effect.runPromise(Fiber.await(playing)))).toBe(true)
    expect(f.processes[0]!.alive).toBe(false)
    expect(Exit.isFailure(await Effect.runPromiseExit(f.mpv.resume()))).toBe(true)
    f.allowConnect()
    expect(Exit.isFailure(await Effect.runPromiseExit(f.mpv.play("b", "/b.mp4")))).toBe(true)
    expect(f.processes).toHaveLength(1)
  } finally { f.allowConnect(); await f.runtime.dispose() }
})

test("release escalates a stubborn child once and waits for its confirmed exit", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.mpv.play("a", "/a.mp4"))
    f.ignoreTerm(true)
    const release = f.runtime.runFork(f.mpv.release())
    await f.advance(2_000)
    expect(Exit.isSuccess(await Effect.runPromise(Fiber.await(release)))).toBe(true)
    expect(f.processes[0]!.kills).toEqual([undefined, "SIGKILL"])
    expect(f.processes[0]!.alive).toBe(false)
  } finally { f.ignoreTerm(false); await f.runtime.dispose() }
})

test("unconfirmed child exit fails within a bounded deadline and retains ownership for retry", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.mpv.play("a", "/a.mp4"))
    const removed = f.removed()
    f.ignoreAllKills(true)
    const release = f.runtime.runFork(f.mpv.release())
    await f.advance(2_000)
    expect(Exit.isFailure(await Effect.runPromise(Fiber.await(release)))).toBe(true)
    expect(f.processes[0]!.alive).toBe(true)
    expect(f.removed()).toBe(removed)
    expect(f.processes[0]!.kills).toHaveLength(2)
    f.ignoreAllKills(false)
    await f.runtime.runPromise(f.mpv.release())
    expect(f.processes[0]!.alive).toBe(false)
    await f.runtime.runPromise(f.mpv.play("b", "/b.mp4"))
    expect(f.processes).toHaveLength(2)
  } finally { f.ignoreAllKills(false); await f.runtime.dispose() }
})

test("socket cleanup failure remains visible and prevents replacement until retry succeeds", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.mpv.play("a", "/a.mp4"))
    f.failRemove(true)
    expect(Exit.isFailure(await f.runtime.runPromiseExit(f.mpv.release()))).toBe(true)
    expect(f.processes[0]!.alive).toBe(false)
    expect((await f.runtime.runPromise(f.mpv.status())).path).toBeNull()
    expect(Exit.isFailure(await f.runtime.runPromiseExit(f.mpv.play("b", "/b.mp4")))).toBe(true)
    expect(f.processes).toHaveLength(1)
    f.failRemove(false)
    await f.runtime.runPromise(f.mpv.play("b", "/b.mp4"))
    expect(f.processes).toHaveLength(2)
  } finally { f.failRemove(false); await f.runtime.dispose() }
})

test("shutdown cleanup failures are reported and a retained release can retry ownership", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.mpv.play("a", "/a.mp4"))
    f.failKill(true)
    await f.runtime.dispose()
    expect(f.processes[0]!.alive).toBe(true)
    expect(f.errors.some(message => message.includes("shutdown cleanup failed"))).toBe(true)
    f.failKill(false)
    await Effect.runPromise(f.mpv.release())
    expect(f.processes[0]!.alive).toBe(false)
  } finally { f.failKill(false); await f.runtime.dispose(); await Effect.runPromise(f.mpv.release()) }
})

test("failed process cleanup keeps loaded status until exit is confirmed", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.mpv.play("a", "/a.mp4"))
    f.failKill(true)
    expect(Exit.isFailure(await f.runtime.runPromiseExit(f.mpv.release()))).toBe(true)
    expect(await f.runtime.runPromise(f.mpv.status())).toMatchObject({ path: "/a.mp4", current_workshop_id: "a" })
    f.failKill(false)
    await f.runtime.runPromise(f.mpv.release())
    expect((await f.runtime.runPromise(f.mpv.status())).path).toBeNull()
  } finally { f.failKill(false); await f.runtime.dispose() }
})

test("cancelled resume releases potentially playing media even without an IPC acknowledgement", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.mpv.play("a", "/a.mp4"))
    await f.runtime.runPromise(f.mpv.pause())
    const sent = f.holdCommand()
    const resume = f.runtime.runFork(f.mpv.resume())
    await sent
    await Effect.runPromise(Fiber.interrupt(resume))
    expect(f.processes[0]!.alive).toBe(false)
    expect((await f.runtime.runPromise(f.mpv.status())).path).toBeNull()
    f.allowCommand()
    await f.runtime.runPromise(f.mpv.play("b", "/b.mp4"))
    expect((await f.runtime.runPromise(f.mpv.status())).current_workshop_id).toBe("b")
  } finally { f.allowCommand(); await f.runtime.dispose() }
})

test("an idle deadline queued behind another control cannot release a queued replay", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.mpv.play("a", "/a.mp4"))
    await f.runtime.runPromise(f.mpv.stop())
    await f.advance(29_000)
    const sent = f.holdCommand()
    const mode = f.runtime.runFork(f.mpv.setDisplayMode("fit"))
    await sent
    const play = f.runtime.runFork(f.mpv.play("b", "/b.mp4"))
    await f.advance(1_000)
    f.allowCommand()
    expect(Exit.isSuccess(await Effect.runPromise(Fiber.await(mode)))).toBe(true)
    expect(Exit.isSuccess(await Effect.runPromise(Fiber.await(play)))).toBe(true)
    expect(f.processes).toHaveLength(1)
    expect(f.processes[0]!.alive).toBe(true)
    expect((await f.runtime.runPromise(f.mpv.status())).current_workshop_id).toBe("b")
  } finally { f.allowCommand(); await f.runtime.dispose() }
})

test("real Rotation next and previous recreate mpv while retaining missing/adult exclusions", async () => {
  const f = await fixture()
  const rows = ["a", "b", "adult", "missing", "d"].map(id => ({
    workshop_id: id, title: id, display_mode: "fit", source_path: `/media/${id}.mp4`,
    content_rating: id === "adult" ? "mature" : null,
  }) as LibraryItem)
  const rotationRuntime = ManagedRuntime.make(RotationLive.pipe(
    Layer.provide(Layer.succeed(Mpv, f.mpv)),
    Layer.provide(Layer.succeed(Library, {
      list: () => Effect.succeed(rows),
      get: id => id === "missing"
        ? Effect.fail(new DbError({ operation: "get", cause: "missing file" }))
        : Effect.succeed(rows.find(row => row.workshop_id === id)!),
      playablePath: row => Effect.succeed(row.source_path),
      insert: () => Effect.void, update: () => Effect.void, remove: () => Effect.void,
    })),
    Layer.provide(Layer.succeed(PlaybackPrefs, {
      get: () => Effect.succeed({ play_mode: "single" as const, rotation_interval_sec: 600 }),
      setMode: () => Effect.void, setInterval: () => Effect.void,
    })),
    Layer.provide(Layer.succeed(Logger, {
      info: () => Effect.void, warn: () => Effect.void, error: () => Effect.void, debug: () => Effect.void,
    })),
  ))
  try {
    const rotation = await rotationRuntime.runPromise(Rotation)
    await f.runtime.runPromise(f.mpv.play("a", "/media/a.mp4"))
    await rotationRuntime.runPromise(rotation.next())
    expect((await f.runtime.runPromise(f.mpv.status())).current_workshop_id).toBe("b")
    await f.runtime.runPromise(f.mpv.stop())
    await f.advance(30_000)
    await rotationRuntime.runPromise(rotation.next())
    expect((await f.runtime.runPromise(f.mpv.status())).current_workshop_id).toBe("d")
    expect(f.processes).toHaveLength(2)
    await f.runtime.runPromise(f.mpv.release())
    await rotationRuntime.runPromise(rotation.prev())
    expect(await f.runtime.runPromise(f.mpv.status())).toMatchObject({ current_workshop_id: "b", display_mode: "fit" })
    expect(f.processes).toHaveLength(3)
  } finally { await rotationRuntime.dispose(); await f.runtime.dispose() }
})

test("cancelling a queued cold play does not send it or release the active creation", async () => {
  const f = await fixture()
  try {
    const connected = f.holdConnect()
    const first = f.runtime.runFork(f.mpv.play("a", "/a.mp4"))
    await connected
    const queued = f.runtime.runFork(f.mpv.play("cancelled", "/cancelled.mp4"))
    await Effect.runPromise(Fiber.interrupt(queued))
    expect(f.processes[0]!.alive).toBe(true)
    f.allowConnect()
    expect(Exit.isSuccess(await Effect.runPromise(Fiber.await(first)))).toBe(true)
    expect(f.processes[0]!.commands.filter(c => c[0] === "loadfile")).toEqual([["loadfile", "/a.mp4", "replace"]])
  } finally { f.allowConnect(); await f.runtime.dispose() }
})

test("connection timeout gives an IPC failure, reaps the child, and permits the next startup", async () => {
  const f = await fixture()
  try {
    const connected = f.holdConnect()
    const playing = f.runtime.runFork(f.mpv.play("a", "/a.mp4"))
    await connected
    await f.advance(6_000)
    const result = await Effect.runPromise(Fiber.await(playing))
    expect(Exit.isFailure(result)).toBe(true)
    expect(f.processes[0]!.alive).toBe(false)
    f.allowConnect()
    await f.runtime.runPromise(f.mpv.play("b", "/b.mp4"))
    expect(f.processes).toHaveLength(2)
    expect((await f.runtime.runPromise(f.mpv.status())).current_workshop_id).toBe("b")
  } finally { f.allowConnect(); await f.runtime.dispose() }
})

test("connection closure immediately after an acknowledgement cannot report a successful resume", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.mpv.play("a", "/a.mp4"))
    await f.runtime.runPromise(f.mpv.pause())
    f.closeAfterReply(true)
    expect(Exit.isFailure(await f.runtime.runPromiseExit(f.mpv.resume()))).toBe(true)
    expect(f.processes[0]!.alive).toBe(false)
    expect((await f.runtime.runPromise(f.mpv.status())).playing).toBe(false)
  } finally { await f.runtime.dispose() }
})

test("unacknowledged load with failed cleanup retains its possible media identity until retry", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.mpv.play("a", "/a.mp4"))
    await f.runtime.runPromise(f.mpv.stop())
    f.failKill(true)
    const sent = f.holdCommand()
    const play = f.runtime.runFork(f.mpv.play("b", "/b.mp4"))
    await sent
    await Effect.runPromise(Fiber.interrupt(play))
    expect(f.processes[0]!.alive).toBe(true)
    expect(await f.runtime.runPromise(f.mpv.status())).toMatchObject({ current_workshop_id: "b", path: "/b.mp4" })
    expect(f.errors.some(message => message.includes("cleanup failed"))).toBe(true)
    f.failKill(false)
    f.allowCommand()
    await f.runtime.runPromise(f.mpv.release())
    expect((await f.runtime.runPromise(f.mpv.status())).path).toBeNull()
  } finally { f.failKill(false); f.allowCommand(); await f.runtime.dispose() }
})

test("lazy spawn errors reach the play caller and a corrected binary can be retried", async () => {
  const f = await fixture()
  try {
    f.failSpawn(true)
    const result = await f.runtime.runPromise(f.mpv.play("a", "/a.mp4").pipe(Effect.either))
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("MpvIpcError")
      expect(result.left.reason).toContain("spawn")
    }
    expect(f.processes).toHaveLength(0)
    f.failSpawn(false)
    await f.runtime.runPromise(f.mpv.play("a", "/a.mp4"))
    expect(f.processes).toHaveLength(1)
  } finally { await f.runtime.dispose() }
})
