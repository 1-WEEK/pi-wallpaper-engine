import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import type { PlayMode } from "@pwe/shared"
import { DbError, DisplayError, MpvIpcError } from "@pwe/shared"
import { Logger } from "./Logger.js"
import { PlayerPower } from "./PlayerPower.js"
import { Rotation } from "./Rotation.js"
import { Playback, PlaybackLive } from "./Playback.js"

interface FakeFailures {
  readonly armFails?: boolean
  readonly displayOffFails?: boolean
  readonly stopForIdleFails?: boolean
}

// Recording fakes: every dependency call appends to `events`, so the ordering
// invariants of playback orchestration are asserted on one literal array.
const makeRuntime = (failures: FakeFailures = {}) => {
  const events: string[] = []
  const warnings: string[] = []

  const playerPowerLayer = Layer.succeed(PlayerPower, {
    play: (workshopId: string) =>
      Effect.sync(() => {
        events.push(`playerPower.play:${workshopId}`)
        return { ok: true as const, path: "/media/source/123/video.mp4" }
      }),
    stopForIdle: () =>
      Effect.gen(function* () {
        events.push("playerPower.stopForIdle")
        if (failures.stopForIdleFails) {
          return yield* Effect.fail(new MpvIpcError({ reason: "socket gone" }))
        }
        return { ok: true as const }
      }),
    displayOff: () =>
      Effect.gen(function* () {
        events.push("playerPower.displayOff")
        if (failures.displayOffFails) {
          return yield* Effect.fail(
            new DisplayError({ kind: "NotConfigured", message: "no off_command" })
          )
        }
        return { ok: true as const, state: "off" as const }
      }),
    displayOn: () =>
      Effect.sync(() => {
        events.push("playerPower.displayOn")
        return { ok: true as const, state: "on" as const, restored: false }
      }),
  })

  const rotationLayer = Layer.succeed(Rotation, {
    arm: (fromWorkshopId: string) =>
      Effect.gen(function* () {
        events.push(`rotation.arm:${fromWorkshopId}`)
        if (failures.armFails) {
          return yield* Effect.fail(new DbError({ operation: "arm", cause: "boom" }))
        }
      }),
    next: () => Effect.sync(() => events.push("rotation.next")),
    prev: () => Effect.sync(() => events.push("rotation.prev")),
    setMode: (mode: PlayMode) => Effect.sync(() => events.push(`rotation.setMode:${mode}`)),
    setInterval: (sec: number) => Effect.sync(() => events.push(`rotation.setInterval:${sec}`)),
    disarm: () => Effect.sync(() => events.push("rotation.disarm")),
  })

  const loggerLayer = Layer.succeed(Logger, {
    info: () => Effect.void,
    warn: (msg: string) =>
      Effect.sync(() => {
        warnings.push(msg)
      }),
    error: () => Effect.void,
    debug: () => Effect.void,
  })

  const envLayer = Layer.mergeAll(playerPowerLayer, rotationLayer, loggerLayer)

  return {
    events,
    warnings,
    runtime: ManagedRuntime.make(PlaybackLive.pipe(Layer.provide(envLayer))),
  }
}

describe("PlaybackLive", () => {
  test("play runs playerPower.play first, then arms rotation with the workshop id", async () => {
    const { events, runtime } = makeRuntime()
    try {
      const result = await runtime.runPromise(Effect.flatMap(Playback, (p) => p.play("123")))
      expect(result).toEqual({ ok: true, path: "/media/source/123/video.mp4" })
      expect(events).toEqual(["playerPower.play:123", "rotation.arm:123"])
    } finally {
      await runtime.dispose()
    }
  })

  test("play still succeeds when arming rotation fails", async () => {
    const { events, runtime } = makeRuntime({ armFails: true })
    try {
      const result = await runtime.runPromise(Effect.flatMap(Playback, (p) => p.play("123")))
      expect(result).toEqual({ ok: true, path: "/media/source/123/video.mp4" })
      expect(events).toEqual(["playerPower.play:123", "rotation.arm:123"])
    } finally {
      await runtime.dispose()
    }
  })

  test("stop disarms rotation strictly before playerPower.stopForIdle", async () => {
    const { events, runtime } = makeRuntime()
    try {
      const result = await runtime.runPromise(Effect.flatMap(Playback, (p) => p.stop()))
      expect(result).toEqual({ ok: true })
      expect(events).toEqual(["rotation.disarm", "playerPower.stopForIdle"])
    } finally {
      await runtime.dispose()
    }
  })

  test("displayOff disarms rotation strictly before playerPower.displayOff", async () => {
    const { events, runtime } = makeRuntime()
    try {
      const result = await runtime.runPromise(Effect.flatMap(Playback, (p) => p.displayOff()))
      expect(result).toEqual({ ok: true, state: "off" })
      expect(events).toEqual(["rotation.disarm", "playerPower.displayOff"])
    } finally {
      await runtime.dispose()
    }
  })

  test("displayOn delegates to playerPower and never arms rotation (ADR 0009 preserved behavior)", async () => {
    const { events, runtime } = makeRuntime()
    try {
      const result = await runtime.runPromise(Effect.flatMap(Playback, (p) => p.displayOn()))
      expect(result).toEqual({ ok: true, state: "on", restored: false })
      expect(events).toEqual(["playerPower.displayOn"])
    } finally {
      await runtime.dispose()
    }
  })

  test("next, prev, setMode and setRotationInterval delegate to rotation with their arguments", async () => {
    const { events, runtime } = makeRuntime()
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const playback = yield* Playback
          yield* playback.next()
          yield* playback.prev()
          yield* playback.setMode("shuffle")
          yield* playback.setRotationInterval(45)
        })
      )
      expect(events).toEqual([
        "rotation.next",
        "rotation.prev",
        "rotation.setMode:shuffle",
        "rotation.setInterval:45",
      ])
    } finally {
      await runtime.dispose()
    }
  })

  test("sleep arms the countdown, sleepStatus agrees, and sleep(0) cancels", async () => {
    const { runtime } = makeRuntime()
    try {
      const armed = await runtime.runPromise(Effect.flatMap(Playback, (p) => p.sleep(5)))
      expect(armed.active).toBe(true)
      // deadline should be roughly 5 minutes from now (± a small tolerance)
      const remaining = armed.deadline! - Date.now()
      expect(remaining).toBeGreaterThan(4.9 * 60_000)
      expect(remaining).toBeLessThan(5.1 * 60_000)

      const status = await runtime.runPromise(Effect.flatMap(Playback, (p) => p.sleepStatus()))
      expect(status).toEqual(armed)

      const cancelled = await runtime.runPromise(Effect.flatMap(Playback, (p) => p.sleep(0)))
      expect(cancelled).toEqual({ active: false, deadline: null })

      const after = await runtime.runPromise(Effect.flatMap(Playback, (p) => p.sleepStatus()))
      expect(after).toEqual({ active: false, deadline: null })
    } finally {
      await runtime.dispose()
    }
  })

  test("sleep elapse disarms rotation before turning the display off", async () => {
    const { events, runtime } = makeRuntime()
    try {
      // Use a fractional minute to get a ~50 ms timeout
      const shortMs = 50
      await runtime.runPromise(Effect.flatMap(Playback, (p) => p.sleep(shortMs / 60_000)))

      // Wait for the native timer to fire
      await new Promise<void>((r) => setTimeout(r, shortMs + 150))

      // Flush the Effect fiber queue to ensure the forked elapse completes
      await runtime.runPromise(Effect.sleep("10 millis"))

      expect(events).toEqual(["rotation.disarm", "playerPower.displayOff"])
      const status = await runtime.runPromise(Effect.flatMap(Playback, (p) => p.sleepStatus()))
      expect(status).toEqual({ active: false, deadline: null })
    } finally {
      await runtime.dispose()
    }
  })

  test("sleep elapse falls back to stopForIdle when displayOff fails", async () => {
    const { events, runtime } = makeRuntime({ displayOffFails: true })
    try {
      const shortMs = 50
      await runtime.runPromise(Effect.flatMap(Playback, (p) => p.sleep(shortMs / 60_000)))
      await new Promise<void>((r) => setTimeout(r, shortMs + 150))
      await runtime.runPromise(Effect.sleep("10 millis"))

      expect(events).toEqual([
        "rotation.disarm",
        "playerPower.displayOff",
        "playerPower.stopForIdle",
      ])
    } finally {
      await runtime.dispose()
    }
  })

  test("sleep elapse failure only warns and never crashes playback orchestration", async () => {
    const { events, warnings, runtime } = makeRuntime({
      displayOffFails: true,
      stopForIdleFails: true,
    })
    try {
      const shortMs = 50
      await runtime.runPromise(Effect.flatMap(Playback, (p) => p.sleep(shortMs / 60_000)))
      await new Promise<void>((r) => setTimeout(r, shortMs + 150))
      await runtime.runPromise(Effect.sleep("10 millis"))

      expect(events).toEqual([
        "rotation.disarm",
        "playerPower.displayOff",
        "playerPower.stopForIdle",
      ])
      expect(warnings.length).toBe(1)
      expect(warnings[0]).toContain("Sleep timer action failed")

      // The service keeps answering after the failed elapse.
      const status = await runtime.runPromise(Effect.flatMap(Playback, (p) => p.sleepStatus()))
      expect(status).toEqual({ active: false, deadline: null })
    } finally {
      await runtime.dispose()
    }
  })
})
