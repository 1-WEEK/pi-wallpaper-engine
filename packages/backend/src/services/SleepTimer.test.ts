import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Logger } from "./Logger.js"
import { Rotation } from "./Rotation.js"
import { PlayerPower } from "./PlayerPower.js"
import { SleepTimer, SleepTimerLive } from "./SleepTimer.js"

const silentLogger = Layer.succeed(Logger, {
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
  debug: () => Effect.void,
})

// Minimal mocks for dependencies that SleepTimerLive acquires at scope time
// but that won't be exercised unless the timer actually fires.
const inertRotation = Layer.succeed(Rotation, {
  arm: (_fromWorkshopId: string) => Effect.void,
  next: () => Effect.void,
  prev: () => Effect.void,
  setMode: (_mode: import("@pwe/shared").PlayMode) => Effect.void,
  setInterval: (_sec: number) => Effect.void,
  disarm: () => Effect.void,
})

const inertPlayerPower = Layer.succeed(
  PlayerPower,
  {
    displayOff: () => Effect.succeed({ ok: true as const, state: "off" as const }),
    stopForIdle: () => Effect.succeed({ ok: true as const }),
  } as any,
)

const baseLayer = Layer.merge(
  inertRotation,
  Layer.merge(inertPlayerPower, silentLogger),
)

describe("SleepTimerLive", () => {
  test("set(0) cancels without creating a timer", async () => {
    const rt = ManagedRuntime.make(SleepTimerLive.pipe(Layer.provide(baseLayer)))
    try {
      const res = await rt.runPromise(Effect.flatMap(SleepTimer, (t) => t.set(0)))
      expect(res).toEqual({ active: false, deadline: null })

      // Confirm the timer refs were never populated
      const st = await rt.runPromise(Effect.flatMap(SleepTimer, (t) => t.status()))
      expect(st).toEqual({ active: false, deadline: null })
    } finally {
      await rt.dispose()
    }
  })

  test("set(5) arms the timer and returns active state", async () => {
    const rt = ManagedRuntime.make(SleepTimerLive.pipe(Layer.provide(baseLayer)))
    try {
      const res = await rt.runPromise(Effect.flatMap(SleepTimer, (t) => t.set(5)))
      expect(res.active).toBe(true)
      expect(typeof res.deadline).toBe("number")
      // deadline should be roughly 5 minutes from now (± a small tolerance)
      const remaining = res.deadline! - Date.now()
      expect(remaining).toBeGreaterThan(4.9 * 60_000)
      expect(remaining).toBeLessThan(5.1 * 60_000)
    } finally {
      await rt.dispose()
    }
  })

  test("cancel() disarms an active timer", async () => {
    const rt = ManagedRuntime.make(SleepTimerLive.pipe(Layer.provide(baseLayer)))
    try {
      await rt.runPromise(Effect.flatMap(SleepTimer, (t) => t.set(5)))

      const cancelled = await rt.runPromise(Effect.flatMap(SleepTimer, (t) => t.cancel()))
      expect(cancelled).toEqual({ active: false, deadline: null })

      const st = await rt.runPromise(Effect.flatMap(SleepTimer, (t) => t.status()))
      expect(st).toEqual({ active: false, deadline: null })
    } finally {
      await rt.dispose()
    }
  })

  test("status() returns the current state", async () => {
    const rt = ManagedRuntime.make(SleepTimerLive.pipe(Layer.provide(baseLayer)))
    try {
      // Initially inactive
      const initial = await rt.runPromise(Effect.flatMap(SleepTimer, (t) => t.status()))
      expect(initial).toEqual({ active: false, deadline: null })

      // After set
      await rt.runPromise(Effect.flatMap(SleepTimer, (t) => t.set(5)))
      const armed = await rt.runPromise(Effect.flatMap(SleepTimer, (t) => t.status()))
      expect(armed.active).toBe(true)
      expect(typeof armed.deadline).toBe("number")

      // After cancel
      await rt.runPromise(Effect.flatMap(SleepTimer, (t) => t.cancel()))
      const afterCancel = await rt.runPromise(Effect.flatMap(SleepTimer, (t) => t.status()))
      expect(afterCancel).toEqual({ active: false, deadline: null })
    } finally {
      await rt.dispose()
    }
  })

  test("timer elapse calls rotation.disarm() and playerPower.displayOff()", async () => {
    let disarmCalled = false
    let displayOffCalled = false

    const spyRotation = Layer.succeed(Rotation, {
      arm: (_fromWorkshopId: string) => Effect.void,
      next: () => Effect.void,
      prev: () => Effect.void,
      setMode: (_mode: import("@pwe/shared").PlayMode) => Effect.void,
      setInterval: (_sec: number) => Effect.void,
      disarm: () => Effect.sync(() => { disarmCalled = true }),
    })

    const spyPlayerPower = Layer.succeed(
      PlayerPower,
      {
        displayOff: () => Effect.sync(() => { displayOffCalled = true }).pipe(
          Effect.andThen(() => Effect.succeed({ ok: true as const, state: "off" as const })),
        ),
        stopForIdle: () => Effect.succeed({ ok: true as const }),
      } as any,
    )

    const rt = ManagedRuntime.make(
      SleepTimerLive.pipe(
        Layer.provide(Layer.merge(spyRotation, Layer.merge(spyPlayerPower, silentLogger))),
      ),
    )

    try {
      // Use a fractional minute to get a ~50 ms timeout
      const shortMs = 50
      await rt.runPromise(Effect.flatMap(SleepTimer, (t) => t.set(shortMs / 60_000)))

      // Wait for the native timer to fire
      await new Promise<void>((r) => setTimeout(r, shortMs + 150))

      // Flush the Effect fiber queue to ensure forked onElapsed completes
      await rt.runPromise(Effect.sleep("10 millis"))

      expect(disarmCalled).toBe(true)
      expect(displayOffCalled).toBe(true)
    } finally {
      await rt.dispose()
    }
  })
})
