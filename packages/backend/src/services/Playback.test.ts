import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime, Queue, Stream } from "effect"
import type { PlayMode } from "@pwe/shared"
import { DbError, DisplayError, MpvIpcError } from "@pwe/shared"
import { Logger } from "./Logger.js"
import { PlaybackPrefs } from "./PlaybackPrefs.js"
import { PlayerPower } from "./PlayerPower.js"
import { Rotation } from "./Rotation.js"
import { Playback, PlaybackLive } from "./Playback.js"

interface FakeFailures {
  readonly armFails?: boolean
  readonly displayOffFails?: boolean
  readonly stopForIdleFails?: boolean
  // When set, fake displayOn reports a successful restore of this wallpaper.
  readonly displayOnRestores?: string
}

// Recording fakes: every dependency call appends to `events`, so the ordering
// invariants of playback orchestration are asserted on one literal array.
const makeRuntime = (failures: FakeFailures = {}, playLimitMinutes = 0) => {
  const events: string[] = []
  const warnings: string[] = []
  // Mutable so a test can change the stored policy mid-session the way the
  // Settings row does. Seeded directly (not through setPlayLimit) because a
  // unit test needs a sub-minute deadline: the real store floors to whole
  // minutes, so a test that could not seed a fraction would have to wait a
  // real minute to watch the timer fire.
  const prefsState = { play_limit_minutes: playLimitMinutes }
  // A Queue rather than a PubSub so a test can hand the service a wallpaper
  // recovery without racing the subscription registration.
  const recoveries = Effect.runSync(Queue.unbounded<string>())

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
        return failures.displayOnRestores
          ? {
              ok: true as const,
              state: "on" as const,
              restored: true,
              restored_workshop_id: failures.displayOnRestores,
            }
          : { ok: true as const, state: "on" as const, restored: false }
      }),
    recovered: () => Stream.fromQueue(recoveries),
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

  const prefsLayer = Layer.succeed(PlaybackPrefs, {
    get: () =>
      Effect.succeed({
        play_mode: "single" as const,
        rotation_interval_sec: 600,
        play_limit_minutes: prefsState.play_limit_minutes,
      }),
    setMode: () => Effect.void,
    setInterval: () => Effect.void,
    setPlayLimit: (minutes: number) =>
      Effect.sync(() => {
        prefsState.play_limit_minutes = Math.max(0, Math.floor(minutes))
      }),
  })

  const envLayer = Layer.mergeAll(playerPowerLayer, rotationLayer, loggerLayer, prefsLayer)

  return {
    events,
    warnings,
    setLimit: (minutes: number) => {
      prefsState.play_limit_minutes = minutes
    },
    /** Hand the orchestrator a wallpaper that PlayerPower restored on its own. */
    recovered: (workshopId: string) =>
      Queue.offer(recoveries, workshopId).pipe(Effect.andThen(Effect.sleep("50 millis"))),
    runtime: ManagedRuntime.make(PlaybackLive.pipe(Layer.provide(envLayer))),
  }
}

describe("PlaybackLive", () => {
  test("play runs playerPower.play first, then arms rotation with the workshop id", async () => {
    const { events, runtime, recovered } = makeRuntime()
    try {
      const result = await runtime.runPromise(Effect.flatMap(Playback, (p) => p.play("123")))
      expect(result).toEqual({ ok: true, path: "/media/source/123/video.mp4" })
      expect(events).toEqual(["playerPower.play:123", "rotation.arm:123"])
    } finally {
      await runtime.dispose()
    }
  })

  test("play still succeeds when arming rotation fails", async () => {
    const { events, runtime, recovered } = makeRuntime({ armFails: true })
    try {
      const result = await runtime.runPromise(Effect.flatMap(Playback, (p) => p.play("123")))
      expect(result).toEqual({ ok: true, path: "/media/source/123/video.mp4" })
      expect(events).toEqual(["playerPower.play:123", "rotation.arm:123"])
    } finally {
      await runtime.dispose()
    }
  })

  test("stop disarms rotation strictly before playerPower.stopForIdle", async () => {
    const { events, runtime, recovered } = makeRuntime()
    try {
      const result = await runtime.runPromise(Effect.flatMap(Playback, (p) => p.stop()))
      expect(result).toEqual({ ok: true })
      expect(events).toEqual(["rotation.disarm", "playerPower.stopForIdle"])
    } finally {
      await runtime.dispose()
    }
  })

  test("displayOff disarms rotation strictly before playerPower.displayOff", async () => {
    const { events, runtime, recovered } = makeRuntime()
    try {
      const result = await runtime.runPromise(Effect.flatMap(Playback, (p) => p.displayOff()))
      expect(result).toEqual({ ok: true, state: "off" })
      expect(events).toEqual(["rotation.disarm", "playerPower.displayOff"])
    } finally {
      await runtime.dispose()
    }
  })

  test("displayOn without a restore does not arm rotation", async () => {
    const { events, runtime, recovered } = makeRuntime()
    try {
      const result = await runtime.runPromise(Effect.flatMap(Playback, (p) => p.displayOn()))
      expect(result).toEqual({ ok: true, state: "on", restored: false })
      expect(events).toEqual(["playerPower.displayOn"])
    } finally {
      await runtime.dispose()
    }
  })

  test("displayOn re-arms rotation on the restored wallpaper and strips the internal id (ADR 0009 follow-up, signed off 2026-07-06)", async () => {
    const { events, runtime } = makeRuntime({ displayOnRestores: "456" })
    try {
      const result = await runtime.runPromise(Effect.flatMap(Playback, (p) => p.displayOn()))
      // The internal restored_workshop_id never leaks into the public result.
      expect(result).toEqual({ ok: true, state: "on", restored: true })
      expect(events).toEqual(["playerPower.displayOn", "rotation.arm:456"])
    } finally {
      await runtime.dispose()
    }
  })

  test("displayOn still reports the restore when re-arming rotation fails", async () => {
    const { events, runtime } = makeRuntime({ displayOnRestores: "456", armFails: true })
    try {
      const result = await runtime.runPromise(Effect.flatMap(Playback, (p) => p.displayOn()))
      expect(result).toEqual({ ok: true, state: "on", restored: true })
      expect(events).toEqual(["playerPower.displayOn", "rotation.arm:456"])
    } finally {
      await runtime.dispose()
    }
  })

  test("a wallpaper PlayerPower restored on its own arms rotation too (ticket 01)", async () => {
    // The media root came back and PlayerPower resumed the wallpaper without
    // going through a route. Rotation linkage still belongs to Playback
    // (ADR 0009), so the recovered signal has to arm the sequence — otherwise
    // the device resumes playing one wallpaper and rotates never again.
    const { events, runtime, recovered } = makeRuntime()
    try {
      await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.sleep("30 millis")
            yield* recovered("456")
          })
        )
      )

      expect(events).toEqual(["rotation.arm:456"])
    } finally {
      await runtime.dispose()
    }
  })

  test("a recovered wallpaper still plays when arming rotation fails", async () => {
    const { events, runtime, recovered } = makeRuntime({ armFails: true })
    try {
      await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.sleep("30 millis")
            yield* recovered("456")
          })
        )
      )

      expect(events).toEqual(["rotation.arm:456"])
      // The loop is still alive after the failure: another recovery is served.
      await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* recovered("789")
          })
        )
      )
      expect(events).toEqual(["rotation.arm:456", "rotation.arm:789"])
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

  test("next/prev/pause do not re-arm an armed play limit", async () => {
    const { events, runtime } = makeRuntime({}, 30)
    try {
      const armed = await runtime.runPromise(
        Effect.gen(function* () {
          const playback = yield* Playback
          yield* playback.play("123")
          yield* playback.next()
          yield* playback.prev()
          return yield* playback.playLimitStatus()
        })
      )
      const before = await runtime.runPromise(Effect.flatMap(Playback, (p) => p.playLimitStatus()))
      // The deadline is per session, not per wallpaper: changing wallpaper must
      // not push it out, or the limit would never fire.
      expect(before.deadline).toBe(armed.deadline)
      expect(events).toEqual([
        "playerPower.play:123",
        "rotation.arm:123",
        "rotation.next",
        "rotation.prev",
      ])
    } finally {
      await runtime.dispose()
    }
  })

  test("play arms the limit from the stored policy; setPlayLimit(0) disarms it", async () => {
    const { runtime } = makeRuntime({}, 30)
    try {
      const armed = await runtime.runPromise(
        Effect.gen(function* () {
          const playback = yield* Playback
          yield* playback.play("123")
          return yield* playback.playLimitStatus()
        })
      )
      expect(armed.minutes).toBe(30)
      const remaining = armed.deadline! - Date.now()
      expect(remaining).toBeGreaterThan(29.9 * 60_000)
      expect(remaining).toBeLessThan(30.1 * 60_000)

      const off = await runtime.runPromise(
        Effect.gen(function* () {
          const playback = yield* Playback
          yield* playback.setPlayLimit(0)
          return yield* playback.playLimitStatus()
        })
      )
      // Switching off clears any live deadline so the summary stops reporting one.
      expect(off).toEqual({ minutes: 0, deadline: null })
    } finally {
      await runtime.dispose()
    }
  })

  test("with the policy off, play arms nothing", async () => {
    const { events, runtime } = makeRuntime({}, 0)
    try {
      const status = await runtime.runPromise(
        Effect.gen(function* () {
          const playback = yield* Playback
          yield* playback.play("123")
          return yield* playback.playLimitStatus()
        })
      )
      expect(status).toEqual({ minutes: 0, deadline: null })
      expect(events).toEqual(["playerPower.play:123", "rotation.arm:123"])
    } finally {
      await runtime.dispose()
    }
  })

  test("an explicit stop drops the live deadline so a later play re-arms from zero", async () => {
    const { runtime } = makeRuntime({}, 30)
    try {
      const afterStop = await runtime.runPromise(
        Effect.gen(function* () {
          const playback = yield* Playback
          yield* playback.play("123")
          yield* playback.stop()
          return yield* playback.playLimitStatus()
        })
      )
      expect(afterStop.deadline).toBeNull()
      // The stored policy survives a stop — only the live deadline is dropped.
      expect(afterStop.minutes).toBe(30)
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
    const { events, runtime, recovered } = makeRuntime()
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

  test("the play limit elapsing disarms the sleep timer that loses the race", async () => {
    // Both timers are armed from the same session; the play limit fires first
    // here. The sleep timer must not stay reporting "active" for a session that
    // has already stopped — the summary would contradict itself.
    const { events, runtime } = makeRuntime({}, 50 / 60_000)
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const playback = yield* Playback
          yield* playback.play("123")
          // A sleep timer that would fire far later than the play limit.
          yield* playback.sleep(60)
        })
      )

      // Wait for the native play-limit timer to fire, then flush the fiber.
      await new Promise<void>((r) => setTimeout(r, 200))
      await runtime.runPromise(Effect.sleep("10 millis"))

      const sleep = await runtime.runPromise(Effect.flatMap(Playback, (p) => p.sleepStatus()))
      const limit = await runtime.runPromise(Effect.flatMap(Playback, (p) => p.playLimitStatus()))
      expect(sleep).toEqual({ active: false, deadline: null })
      expect(limit.deadline).toBeNull()
      expect(events).toEqual(["playerPower.play:123", "rotation.arm:123", "rotation.disarm", "playerPower.displayOff"])
    } finally {
      await runtime.dispose()
    }
  })

  test("the sleep timer elapsing clears a live play-limit deadline", async () => {
    // Mirror image: the sleep timer fires first, and the play limit must not be
    // left reporting a deadline for a session that has already stopped.
    const { events, runtime } = makeRuntime({}, 60)
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const playback = yield* Playback
          yield* playback.play("123")
          yield* playback.sleep(50 / 60_000)
        })
      )

      await new Promise<void>((r) => setTimeout(r, 200))
      await runtime.runPromise(Effect.sleep("10 millis"))

      const sleep = await runtime.runPromise(Effect.flatMap(Playback, (p) => p.sleepStatus()))
      const limit = await runtime.runPromise(Effect.flatMap(Playback, (p) => p.playLimitStatus()))
      expect(sleep).toEqual({ active: false, deadline: null })
      expect(limit.deadline).toBeNull()
      expect(events).toEqual(["playerPower.play:123", "rotation.arm:123", "rotation.disarm", "playerPower.displayOff"])
    } finally {
      await runtime.dispose()
    }
  })

  test("the play limit elapse under a degraded display only warns and keeps serving", async () => {
    // Both stop paths are unavailable: the display is unconfigured AND mpv's
    // socket is gone. The timer must swallow that the way the sleep timer does
    // rather than take the process down with it.
    const { events, warnings, runtime } = makeRuntime(
      { displayOffFails: true, stopForIdleFails: true },
      50 / 60_000
    )
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const playback = yield* Playback
          yield* playback.play("123")
        })
      )

      await new Promise<void>((r) => setTimeout(r, 200))
      await runtime.runPromise(Effect.sleep("10 millis"))

      expect(events).toEqual(["playerPower.play:123", "rotation.arm:123", "rotation.disarm", "playerPower.displayOff", "playerPower.stopForIdle"])
      expect(warnings.length).toBe(1)
      expect(warnings[0]).toContain("Play limit action failed")

      // The service keeps answering after the failed elapse, and the deadline
      // is cleared so the summary does not claim a stopped session is armed.
      const status = await runtime.runPromise(Effect.flatMap(Playback, (p) => p.playLimitStatus()))
      expect(status).toEqual({ minutes: 50 / 60_000, deadline: null })
    } finally {
      await runtime.dispose()
    }
  })
})
