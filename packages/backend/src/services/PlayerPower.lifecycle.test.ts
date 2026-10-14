import { expect, test } from "bun:test"
import { TestClock } from "effect/testing"
import { Database } from "bun:sqlite"
import { Cause, Clock, Effect, Exit, Fiber, Layer, ManagedRuntime, Queue, Stream } from "effect"
import { DbError, DisplayError, LibraryNotFoundError, StorageError, type LibraryItem, type PlayMode } from "@pwe/shared"
import exampleConfig from "../../../../config.example.json"
import { Config, type RuntimeConfig } from "./Config.js"
import { Db, type DbImpl } from "./Db.js"
import { Display, type DisplayStatus } from "./Display.js"
import { Library } from "./Library.js"
import { Logger } from "./Logger.js"
import { makeMpvLive, Mpv } from "./Mpv.js"
import { Playback, PlaybackLive } from "./Playback.js"
import { PlaybackPrefsLive } from "./PlaybackPrefs.js"
import { PlayerPower, PlayerPowerLive } from "./PlayerPower.js"
import { PlayerState, PlayerStateLive, type PlayerStateImpl, type RestoreState } from "./PlayerState.js"
import { RotationLive } from "./Rotation.js"
import { Storage } from "./Storage.js"
import { MediaRootWatch } from "./MediaRootWatch.js"

const gate = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

const fixture = async (options: {
  saved?: string; savedReason?: RestoreState["reason"]; displayStatus?: DisplayStatus; holdProbe?: boolean; mode?: PlayMode; available?: boolean
} = {}) => {
  const sqlite = new Database(":memory:")
  sqlite.exec(`CREATE TABLE player_state (id TEXT PRIMARY KEY, restore_workshop_id TEXT,
    restore_reason TEXT, updated_at INTEGER)`)
  if (options.saved) sqlite.prepare("INSERT INTO player_state VALUES ('singleton', ?, ?, 1)").run(options.saved, options.savedReason ?? "manual_stop")
  sqlite.exec(`CREATE TABLE playback_prefs (id TEXT PRIMARY KEY, play_mode TEXT, rotation_interval_sec INTEGER,
    play_limit_minutes INTEGER, play_limit_once INTEGER, updated_at INTEGER)`)
  sqlite.prepare("INSERT INTO playback_prefs VALUES ('singleton', ?, 600, 0, 0, 1)").run(options.mode ?? "single")
  const probes = Effect.runSync(Queue.unbounded<{ available: boolean; root: string; reason: string | null }>())
  let available = options.available ?? true
  const tryDb = <A>(operation: string, fn: () => A) => Effect.try({
    try: fn, catch: cause => new DbError({ operation, cause }),
  })
  const db: DbImpl = {
    query: <A>(sql: string, params: unknown[] = []) => tryDb("query", () => sqlite.query(sql).all(...params as any[]) as A[]),
    queryOne: <A>(sql: string, params: unknown[] = []) => tryDb("queryOne", () => sqlite.query(sql).get(...params as any[]) as A | null),
    exec: (sql, params = []) => tryDb("exec", () => { sqlite.prepare(sql).run(...params as any[]) }),
    transaction: fn => fn(),
  }
  const events: string[] = []
  const offObservations: { alive: boolean; saved: RestoreState | null }[] = []
  const savedAtKill: (RestoreState | null)[] = []
  const processes: { alive: boolean; commands: unknown[][]; exit: ReturnType<typeof gate<number>> }[] = []
  let state: PlayerStateImpl
  let offFailure: DisplayError | undefined
  let killFails = false
  let loadFails = false
  let missing = false
  let ids = ["a", "b"]
  let blockedPath: ReturnType<typeof gate<void>> | undefined
  let waitingPath: ReturnType<typeof gate<void>> | undefined
  let pathReached = gate<void>()
  let blockedOff: ReturnType<typeof gate<void>> | undefined
  let offReached = gate<void>()
  let displayStatus: DisplayStatus = options.displayStatus ?? { state: "unknown", source: "default" }
  const probing = gate<void>()
  const probe = options.holdProbe ? gate<DisplayStatus>() : undefined
  let firstProbe = true
  const row = (id: string) => ({ ...exampleRow, workshop_id: id, source_path: `/media/${id}.mp4` })
  const runtime = ManagedRuntime.make(PlaybackLive.pipe(
    Layer.provideMerge(RotationLive),
    Layer.provideMerge(PlaybackPrefsLive),
    Layer.provideMerge(PlayerPowerLive),
    Layer.provideMerge(makeMpvLive({
      spawn: () => {
        const p = { alive: true, commands: [] as unknown[][], exit: gate<number>() }
        processes.push(p)
        events.push("spawn")
        return {
          pid: processes.length, exited: p.exit.promise,
          kill() {
            events.push("kill")
            savedAtKill.push(Effect.runSync(state.getRestore()))
            if (killFails) throw new Error("kill refused")
            p.alive = false
            p.exit.resolve(0)
          },
        }
      },
      connect: async (_path, handlers) => {
        const p = processes.at(-1)!
        const socket = {
          write(payload: string) {
            const msg = JSON.parse(payload)
            p.commands.push(msg.command)
            const error = loadFails && msg.command[0] === "loadfile" ? "load failed" : "success"
            handlers.data(socket, Buffer.from(JSON.stringify({ request_id: msg.request_id, error }) + "\n"))
            return Buffer.byteLength(payload)
          },
          end() { events.push("socket.end") },
        }
        return socket
      },
      removeSocket() { events.push("socket.remove") },
    })),
    Layer.provideMerge(PlayerStateLive),
    Layer.provideMerge(Layer.succeed(Db, db)),
    Layer.provideMerge(Layer.succeed(Library, {
      list: () => Effect.sync(() => ids.map(row)),
      get: id => missing
        ? Effect.fail(new LibraryNotFoundError({ workshopId: id })) : Effect.succeed(row(id)),
      playablePath: item => Effect.gen(function* () {
        const blocked = blockedPath
        if (blocked) {
          blockedPath = undefined
          pathReached.resolve()
          yield* Effect.promise(() => blocked.promise)
        }
        if (!available) return yield* Effect.fail(new StorageError({ kind: "Disconnected", message: "/media is unavailable" }))
        return item.source_path
      }),
      update: () => Effect.void,
      insert: () => Effect.void, remove: () => Effect.void,
    })),
    Layer.provideMerge(Layer.succeed(Storage, {
      status: () => Effect.succeed({ available, data_root: "/media", default_root: "/media", using_default: true,
        last_error: available ? null : "/media is unavailable" }),
      mediaRoot: () => Effect.succeed("/media"), mediaRootOrNull: () => Effect.succeed(available ? "/media" : null),
      saveRoot: () => Effect.die("unused"),
    })),
    Layer.provideMerge(Layer.succeed(MediaRootWatch, {
      availableProbes: () => Stream.fromQueue(probes), probeNow: () => Effect.void,
    })),
    Layer.provideMerge(Layer.succeed(Display, {
      on: () => Effect.sync(() => { events.push("display.on"); displayStatus = { state: "on", source: "cached" } }),
      off: () => Effect.tryPromise({ try: async () => {
        offReached.resolve()
        if (blockedOff) await blockedOff.promise
        events.push("display.off")
        offObservations.push({ alive: processes.some(p => p.alive), saved: Effect.runSync(state.getRestore()) })
        if (offFailure) throw offFailure
        displayStatus = { state: "off", source: "cached" }
      }, catch: cause => cause instanceof DisplayError ? cause : new DisplayError({ kind: "SpawnFailed", message: String(cause) }) }),
      status: () => Effect.suspend(() => {
        if (firstProbe) {
          firstProbe = false
          probing.resolve()
          if (probe) return Effect.promise(() => probe.promise)
        }
        return Effect.succeed(displayStatus)
      }),
    })),
    Layer.provideMerge(Layer.succeed(Config, exampleConfig as RuntimeConfig)),
    Layer.provideMerge(Layer.succeed(Logger, {
      info: () => Effect.void, warn: () => Effect.void, error: () => Effect.void, debug: () => Effect.void,
    })),
    Layer.provideMerge(TestClock.layer()),
  ))
  state = await runtime.runPromise(PlayerState)
  const mpv = await runtime.runPromise(Mpv)
  const playback = await runtime.runPromise(Playback)
  await probing.promise
  return {
    runtime, mpv, playback, state, processes, events, offObservations, savedAtKill,
    advance: (ms: number) => runtime.runPromise(TestClock.adjust(ms)),
    setAvailable(value: boolean) { available = value },
    rootCameBack: () => runtime.runPromise(Queue.offer(probes, { available: true, root: "/media", reason: null })),
    restore: () => runtime.runPromise(state.getRestore()),
    status: () => runtime.runPromise(mpv.status()),
    displayStatus: () => displayStatus,
    failOff(error?: DisplayError) { offFailure = error },
    failKill(value: boolean) { killFails = value },
    failLoad(value: boolean) { loadFails = value },
    setMissing(value: boolean) { missing = value },
    allowProbe(status: DisplayStatus) { probe?.resolve(status) },
    setLibrary(idsNext: string[]) { ids = idsNext },
    holdPath() { blockedPath = gate<void>(); waitingPath = blockedPath; pathReached = gate<void>(); return pathReached.promise },
    allowPath() { waitingPath?.resolve(); waitingPath = undefined },
    holdOff() { blockedOff = gate<void>(); offReached = gate<void>(); return offReached.promise },
    allowOff() { blockedOff?.resolve(); blockedOff = undefined },
    async dispose() { killFails = false; blockedOff?.resolve(); waitingPath?.resolve(); probe?.resolve({ state: "unknown", source: "default" }); await runtime.dispose(); sqlite.close() },
  }
}

const exampleRow: LibraryItem = {
  workshop_id: "a", title: "Wallpaper", author: "", preview_url: "", content_rating: null,
  rating_sex: null, source_path: "/media/a.mp4", source_resolution: "1920x1080", source_codec: "h264",
  source_size: 100, downloaded_at: 1, transcode_status: "skipped", transcode_progress: 0,
  transcode_error: null, transcoded_path: null, transcoded_resolution: null, transcoded_codec: null,
  transcoded_size: null, display_mode: "stretch", last_played_at: null,
}

test("display-off saves paused media before release and powers off only after child exit", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.playback.play("a"))
    await f.runtime.runPromise(f.mpv.pause())
    const result = await f.runtime.runPromise(f.playback.displayOff())
    expect(result).toEqual({ ok: true, state: "off" })
    expect(f.offObservations).toMatchObject([{ alive: false, saved: { workshop_id: "a", reason: "display_off" } }])
    expect(f.savedAtKill).toMatchObject([{ workshop_id: "a", reason: "display_off" }])
    expect((await f.status()).path).toBeNull()
  } finally { await f.dispose() }
})

test("display-command failure keeps saved intent and leaves the released player absent", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.playback.play("a"))
    f.failOff(new DisplayError({ kind: "NonZeroExit", message: "off failed", exitCode: 1 }))
    const result = await f.runtime.runPromise(f.playback.displayOff().pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure._tag).toBe("DisplayError")
    expect(f.processes[0]!.alive).toBe(false)
    expect(f.displayStatus().state).toBe("unknown")
    expect(await f.restore()).toMatchObject({ workshop_id: "a" })
    expect(f.processes).toHaveLength(1)
  } finally { await f.dispose() }
})

test("unresolved child ownership prevents display-off and allows a saved-intent retry", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.playback.play("a"))
    f.failKill(true)
    expect(Exit.isFailure(await f.runtime.runPromiseExit(f.playback.displayOff()))).toBe(true)
    expect(f.offObservations).toHaveLength(0)
    expect(await f.status()).toMatchObject({ current_workshop_id: "a" })
    expect(await f.restore()).toMatchObject({ workshop_id: "a" })
    f.failKill(false)
    expect(await f.runtime.runPromise(f.playback.displayOff())).toEqual({ ok: true, state: "off" })
    expect(f.processes[0]!.alive).toBe(false)
  } finally { await f.dispose() }
})

test("display-on creates fresh playback from the beginning, restores item mode and clears intent", async () => {
  const f = await fixture({ mode: "sequential" })
  try {
    await f.runtime.runPromise(f.playback.play("a"))
    await f.runtime.runPromise(f.playback.displayOff())
    f.setLibrary(["a", "c"])
    expect(await f.runtime.runPromise(f.playback.displayOn())).toEqual({ ok: true, state: "on", restored: true })
    expect(f.processes).toHaveLength(2)
    expect(f.processes[1]!.commands).toContainEqual(["loadfile", "/media/a.mp4", "replace"])
    expect(await f.status()).toMatchObject({ playing: true, current_workshop_id: "a", display_mode: "stretch" })
    expect(await f.restore()).toBeNull()
    await f.runtime.runPromise(f.playback.next())
    expect((await f.status()).current_workshop_id).toBe("c")
  } finally { await f.dispose() }
})

test("missing restore media clears intent but a failed load keeps it for retry", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.playback.play("a"))
    await f.runtime.runPromise(f.playback.displayOff())
    f.failLoad(true)
    expect(await f.runtime.runPromise(f.playback.displayOn())).toEqual({
      ok: true, state: "on", restored: false, restore_error: "Restore failed; saved state kept.",
    })
    expect(await f.restore()).toMatchObject({ workshop_id: "a" })
    expect(f.processes[1]!.alive).toBe(false)
    f.failLoad(false)
    f.setMissing(true)
    expect(await f.runtime.runPromise(f.playback.displayOn())).toEqual({ ok: true, state: "on", restored: false })
    expect(await f.restore()).toBeNull()
  } finally { await f.dispose() }
})

test("manual stop preserves restore intent and powers off at its 30-second deadline", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.playback.play("a"))
    await f.runtime.runPromise(f.playback.stop())
    expect(await f.restore()).toMatchObject({ workshop_id: "a", reason: "manual_stop" })
    await f.advance(29_999)
    expect(f.offObservations).toHaveLength(0)
    expect(f.processes[0]!.alive).toBe(true)
    await f.advance(1)
    expect(f.offObservations).toMatchObject([{ alive: false, saved: { workshop_id: "a", reason: "manual_stop" } }])
  } finally { await f.dispose() }
})

test("a later display-off waits for an earlier play intent and releases its wallpaper", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.playback.play("a"))
    const pathReached = f.holdPath()
    const playing = f.runtime.runFork(f.playback.play("b"))
    await pathReached
    const poweringOff = f.runtime.runFork(f.playback.displayOff())
    await f.runtime.runPromise(Effect.yieldNow)
    f.allowPath()
    expect(Exit.isSuccess(await Effect.runPromise(Fiber.await(playing)))).toBe(true)
    expect(Exit.isSuccess(await Effect.runPromise(Fiber.await(poweringOff)))).toBe(true)
    expect(await f.status()).toMatchObject({ path: null })
    expect(await f.restore()).toMatchObject({ workshop_id: "b", reason: "display_off" })
    expect(f.offObservations).toMatchObject([{ alive: false, saved: { workshop_id: "b" } }])
  } finally { await f.dispose() }
})

test("one-shot play limit uses the service clock and releases immediately on expiry", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.playback.play("a"))
    const now = await f.runtime.runPromise(Clock.currentTimeMillis)
    await f.runtime.runPromise(f.playback.setPlayLimit(1, true))
    expect(await f.runtime.runPromise(f.playback.playLimitStatus())).toEqual({ minutes: 1, deadline: now + 60_000, once: true })
    await f.advance(59_999)
    expect(f.offObservations).toHaveLength(0)
    await f.advance(1)
    expect(f.offObservations).toMatchObject([{ alive: false, saved: { workshop_id: "a" } }])
    expect(await f.runtime.runPromise(f.playback.playLimitStatus())).toEqual({ minutes: 0, deadline: null, once: true })
  } finally { await f.dispose() }
})

test("startup restore honors probed display-on and leaves rotation unarmed", async () => {
  const f = await fixture({ saved: "a", displayStatus: { state: "on", source: "probed" }, mode: "sequential" })
  try {
    await f.advance(0)
    expect(await f.status()).toMatchObject({ current_workshop_id: "a", display_mode: "stretch" })
    expect(await f.restore()).toBeNull()
    f.setLibrary(["a", "c"])
    await f.runtime.runPromise(f.playback.next())
    expect((await f.status()).current_workshop_id).toBe("c")
  } finally { await f.dispose() }
})

test("new play waits for an already-started external auto-off command to settle", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.playback.play("a"))
    await f.runtime.runPromise(f.playback.stop())
    const offReached = f.holdOff()
    await f.advance(30_000)
    await offReached
    const replay = f.runtime.runFork(f.playback.play("b"))
    await f.runtime.runPromise(Effect.yieldNow)
    expect((await f.status()).path).toBeNull()
    expect(f.processes).toHaveLength(1)
    f.allowOff()
    expect(Exit.isSuccess(await Effect.runPromise(Fiber.await(replay)))).toBe(true)
    expect(await f.status()).toMatchObject({ current_workshop_id: "b", playing: true })
    expect(f.displayStatus().state).toBe("on")
    expect(f.events.indexOf("display.off")).toBeLessThan(f.events.lastIndexOf("display.on"))
  } finally { await f.dispose() }
})

test("a repeated idle stop clears restoration and cancels display auto-off", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.playback.play("a"))
    await f.runtime.runPromise(f.playback.stop())
    await f.advance(20_000)
    await f.runtime.runPromise(f.playback.stop())
    expect(await f.restore()).toBeNull()
    await f.advance(60_000)
    expect(f.offObservations).toHaveLength(0)
    expect(f.processes[0]!.alive).toBe(false)
  } finally { await f.dispose() }
})

test("display-off during stop grace preserves manual restore intent and quick replay cancels auto-off", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.playback.play("a"))
    await f.runtime.runPromise(f.playback.stop())
    await f.advance(10_000)
    await f.runtime.runPromise(f.playback.play("b"))
    await f.advance(20_000)
    expect(f.processes).toHaveLength(1)
    expect(f.processes[0]!.alive).toBe(true)
    expect(f.offObservations).toHaveLength(0)
    await f.runtime.runPromise(f.playback.stop())
    await f.runtime.runPromise(f.playback.displayOff())
    expect(await f.restore()).toMatchObject({ workshop_id: "b", reason: "manual_stop" })
    await f.advance(30_000)
    expect(f.offObservations).toHaveLength(1)
  } finally { await f.dispose() }
})

test("play-limit display failures retain the idle-stop fallback without recreating a released player", async () => {
  for (const kind of ["NotConfigured", "NonZeroExit"] as const) {
    const f = await fixture()
    try {
      await f.runtime.runPromise(f.playback.play("a"))
      f.failOff(new DisplayError({ kind, message: "off failed" }))
      await f.runtime.runPromise(f.playback.setPlayLimit(1, true))
      await f.advance(60_000)
      expect(f.processes[0]!.alive).toBe(false)
      expect(f.processes).toHaveLength(1)
      // The historical fallback is an already-idle manual stop, which clears restore intent.
      expect(await f.restore()).toBeNull()
      expect(await f.runtime.runPromise(f.playback.playLimitStatus())).toEqual({ minutes: 0, deadline: null, once: true })
    } finally { await f.dispose() }
  }
})

test("play-limit cancellation and backend shutdown leave no deferred display-off", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.playback.play("a"))
    await f.runtime.runPromise(f.playback.setPlayLimit(1, true))
    await f.runtime.runPromise(f.playback.setPlayLimit(0, true))
    expect(await f.runtime.runPromise(f.playback.playLimitStatus())).toEqual({ minutes: 0, deadline: null, once: true })
    await f.advance(60_000)
    expect(f.processes[0]!.alive).toBe(true)
    expect(f.offObservations).toHaveLength(0)
    await f.runtime.runPromise(f.playback.setPlayLimit(1, true))
    await f.runtime.dispose()
    expect(f.processes[0]!.alive).toBe(false)
    expect(f.offObservations).toHaveLength(0)
  } finally { await f.dispose() }
})

test("pause and cached startup display state do not arm power-saving behavior", async () => {
  const f = await fixture({ saved: "a", displayStatus: { state: "on", source: "cached" } })
  try {
    await f.advance(0)
    expect(f.processes).toHaveLength(0)
    expect(await f.restore()).toMatchObject({ workshop_id: "a" })
    await f.runtime.runPromise(f.playback.play("a"))
    await f.runtime.runPromise(f.mpv.pause())
    await f.advance(90_000)
    expect(await f.status()).toMatchObject({ playing: false, current_workshop_id: "a" })
    expect(f.processes[0]!.alive).toBe(true)
    expect(f.offObservations).toHaveLength(0)
  } finally { await f.dispose() }
})

test("plays queued behind an external auto-off keep their request order", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.playback.play("a"))
    await f.runtime.runPromise(f.playback.stop())
    const offReached = f.holdOff()
    await f.advance(30_000)
    await offReached
    const first = f.runtime.runFork(f.playback.play("b"))
    const second = f.runtime.runFork(f.playback.play("c"))
    await f.runtime.runPromise(Effect.yieldNow)
    f.allowOff()
    expect(Exit.isSuccess(await Effect.runPromise(Fiber.await(first)))).toBe(true)
    expect(Exit.isSuccess(await Effect.runPromise(Fiber.await(second)))).toBe(true)
    expect((await f.status()).current_workshop_id).toBe("c")
  } finally { await f.dispose() }
})

test("an explicit play cannot be overwritten by a startup restore already resolving media", async () => {
  const f = await fixture({ saved: "a", holdProbe: true })
  try {
    const reached = f.holdPath()
    f.allowProbe({ state: "on", source: "probed" })
    await reached
    const play = f.runtime.runFork(f.playback.play("b"))
    await f.runtime.runPromise(Effect.yieldNow)
    f.allowPath()
    expect(Exit.isSuccess(await Effect.runPromise(Fiber.await(play)))).toBe(true)
    expect(await f.status()).toMatchObject({ current_workshop_id: "b", playing: true })
    expect(await f.restore()).toBeNull()
  } finally { await f.dispose() }
})

test("cancelling an explicit display-off still waits for its external command before a new play", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.playback.play("a"))
    const offReached = f.holdOff()
    const off = f.runtime.runFork(f.playback.displayOff())
    await offReached
    const interrupting = Effect.runPromise(Fiber.interrupt(off))
    const replay = f.runtime.runFork(f.playback.play("b"))
    await f.runtime.runPromise(Effect.yieldNow)
    expect(f.processes).toHaveLength(1)
    f.allowOff()
    await interrupting
    const interrupted = await Effect.runPromise(Fiber.await(off))
    expect(Exit.isFailure(interrupted) && Cause.hasInterrupts(interrupted.cause)).toBe(true)
    expect(Exit.isSuccess(await Effect.runPromise(Fiber.await(replay)))).toBe(true)
    expect(f.displayStatus().state).toBe("on")
    expect((await f.status()).current_workshop_id).toBe("b")
  } finally { await f.dispose() }
})

test("display-off cannot be overwritten by a media-root restore already resolving its file", async () => {
  const f = await fixture({ saved: "a", savedReason: "media_lost", available: false })
  try {
    f.setAvailable(true)
    const reached = f.holdPath()
    await f.rootCameBack()
    await reached
    const off = f.runtime.runFork(f.playback.displayOff())
    await f.runtime.runPromise(Effect.yieldNow)
    f.allowPath()
    await Effect.runPromise(Fiber.join(off))
    await f.advance(0)
    expect(await f.status()).toMatchObject({ path: null, playing: false })
    expect(await f.restore()).toMatchObject({ workshop_id: "a", reason: "display_off" })
    expect(f.displayStatus().state).toBe("off")
    expect(f.processes.every(process => !process.alive)).toBe(true)
  } finally { await f.dispose() }
})

test("an old play-limit deadline cannot shut down a new play already resolving its media", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.playback.play("a"))
    await f.runtime.runPromise(f.playback.setPlayLimit(1, false))
    await f.advance(59_000)
    const reached = f.holdPath()
    const playing = f.runtime.runFork(f.playback.play("b"))
    await reached
    await f.advance(1_000)
    f.allowPath()
    await Effect.runPromise(Fiber.join(playing))
    await f.advance(0)
    expect(await f.status()).toMatchObject({ current_workshop_id: "b", playing: true })
    expect(f.offObservations).toHaveLength(0)
    expect(await f.runtime.runPromise(f.playback.playLimitStatus())).toEqual({
      minutes: 1, deadline: 120_000, once: false,
    })
  } finally { f.allowPath(); await f.dispose() }
})


test("display-off while the media root is absent converts automatic recovery to a deliberate hold", async () => {
  const f = await fixture({ saved: "a", savedReason: "media_lost", available: false })
  try {
    await f.runtime.runPromise(f.playback.displayOff())
    expect(await f.restore()).toMatchObject({ workshop_id: "a", reason: "display_off" })
    f.setAvailable(true)
    await f.rootCameBack()
    await f.advance(0)
    expect(f.processes).toHaveLength(0)
    expect(f.displayStatus().state).toBe("off")
  } finally { await f.dispose() }
})

test("a recovery overtaken by display-off does not announce a new rotation session", async () => {
  const f = await fixture({ saved: "a", savedReason: "media_lost", available: false })
  const recovered: string[] = []
  const power = await f.runtime.runPromise(PlayerPower)
  const listening = f.runtime.runFork(power.recovered().pipe(Stream.runForEach(id => Effect.sync(() => { recovered.push(id) }))))
  try {
    await f.runtime.runPromise(Effect.yieldNow)
    f.setAvailable(true)
    const reached = f.holdPath()
    await f.rootCameBack()
    await reached
    const off = f.runtime.runFork(f.playback.displayOff())
    await f.runtime.runPromise(Effect.yieldNow)
    f.allowPath()
    await Effect.runPromise(Fiber.join(off))
    await f.advance(0)
    expect(recovered).toEqual([])
  } finally { await Effect.runPromise(Fiber.interrupt(listening)); await f.dispose() }
})
