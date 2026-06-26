import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Elysia } from "elysia"
import { Display } from "../services/Display.js"
import { PlayerPower } from "../services/PlayerPower.js"
import { Rotation } from "../services/Rotation.js"
import { displayRoutes } from "./display.js"

describe("displayRoutes", () => {
  test("POST /api/display/off disarms rotation and turns display off", async () => {
    let rotationDisarmed = false
    let displayOffCalled = false

    const displayLayer = Layer.succeed(Display, {
      on: () => Effect.void,
      off: () => Effect.void,
      status: () => Effect.succeed({ state: "on", source: "probed" }),
    })

    const rotationLayer = Layer.succeed(Rotation, {
      arm: () => Effect.void,
      next: () => Effect.void,
      prev: () => Effect.void,
      setMode: () => Effect.void,
      setInterval: () => Effect.void,
      disarm: () =>
        Effect.sync(() => {
          rotationDisarmed = true
        }),
    })

    const playerPowerLayer = Layer.succeed(PlayerPower, {
      play: () => Effect.succeed({ ok: true, path: "" }),
      stopForIdle: () => Effect.succeed({ ok: true }),
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
    })

    const testLayer = Layer.mergeAll(displayLayer, rotationLayer, playerPowerLayer)
    const runtime = ManagedRuntime.make(testLayer)

    const app = new Elysia().use(displayRoutes(runtime as any))

    const response = await app.handle(
      new Request("http://localhost/api/display/off", { method: "POST" })
    )

    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json).toEqual({ ok: true, state: "off" })

    expect(rotationDisarmed).toBe(true)
    expect(displayOffCalled).toBe(true)
  })
})
