import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Elysia } from "elysia"
import { Display } from "../services/Display.js"
import { Playback } from "../services/Playback.js"
import { displayRoutes } from "./display.js"

describe("displayRoutes", () => {
  // The disarm-before-displayOff ordering itself is locked at the Playback
  // interface (Playback.test.ts); the route contract stays byte-identical.
  test("POST /api/display/off turns display off via playback orchestration", async () => {
    let displayOffCalled = false

    const displayLayer = Layer.succeed(Display, {
      on: () => Effect.void,
      off: () => Effect.void,
      status: () => Effect.succeed({ state: "on", source: "probed" }),
    })

    const playbackLayer = Layer.succeed(Playback, {
      play: () => Effect.succeed({ ok: true as const, path: "" }),
      stop: () => Effect.succeed({ ok: true as const }),
      displayOff: () =>
        Effect.sync(() => {
          displayOffCalled = true
          return { ok: true as const, state: "off" as const }
        }),
      displayOn: () =>
        Effect.succeed({
          ok: true as const,
          state: "on" as const,
          restored: false,
        }),
      next: () => Effect.void,
      prev: () => Effect.void,
      setMode: () => Effect.void,
      setRotationInterval: () => Effect.void,
      sleep: () => Effect.succeed({ active: false, deadline: null }),
      sleepStatus: () => Effect.succeed({ active: false, deadline: null }),
    })

    const testLayer = Layer.mergeAll(displayLayer, playbackLayer)
    const runtime = ManagedRuntime.make(testLayer)

    const app = new Elysia().use(displayRoutes(runtime as any))

    const response = await app.handle(
      new Request("http://localhost/api/display/off", { method: "POST" })
    )

    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json).toEqual({ ok: true, state: "off" })

    expect(displayOffCalled).toBe(true)
  })
})
