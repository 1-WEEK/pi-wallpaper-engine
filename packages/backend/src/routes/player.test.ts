import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { Elysia } from "elysia"
import { Playback, type PlaybackImpl } from "../services/Playback.js"
import { Mpv } from "../services/Mpv.js"
import { PlayerWatch } from "../services/PlayerWatch.js"
import { playerRoutes } from "./player.js"

describe("playerRoutes", () => {
  const mockPlayback: PlaybackImpl = {
    play: () => Effect.succeed({ ok: true as const, path: "/some/path" }),
    stop: () => Effect.succeed({ ok: true as const }),
    displayOff: () => Effect.succeed({ ok: true as const, state: "off" as const }),
    displayOn: () => Effect.succeed({ ok: true as const, state: "on" as const, restored: false }),
    next: () => Effect.void,
    prev: () => Effect.void,
    setMode: () => Effect.void,
    setRotationInterval: () => Effect.void,
    sleep: (minutes: number) => Effect.succeed({ active: minutes > 0, deadline: null }),
    sleepStatus: () => Effect.succeed({ active: false, deadline: null }),
  }

  const mockMpv = {
    pause: () => Effect.void,
    resume: () => Effect.void,
    stop: () => Effect.void,
    setDisplayMode: () => Effect.void,
    status: () => Effect.succeed({ path: "", paused: false }),
  }

  const mockPlayerWatch = {
    current: () => Effect.succeed({ path: null, paused: false, sleep: { active: false, deadline: null } }),
    stream: () => Stream.empty,
  }

  const getApp = (overrides: Partial<PlaybackImpl> = {}) => {
    const playbackLayer = Layer.succeed(Playback, { ...mockPlayback, ...overrides })
    const mpvLayer = Layer.succeed(Mpv, mockMpv as any)
    const playerWatchLayer = Layer.succeed(PlayerWatch, mockPlayerWatch as any)
    const testLayer = Layer.mergeAll(playbackLayer, mpvLayer, playerWatchLayer)
    const runtime = ManagedRuntime.make(testLayer)
    return new Elysia().use(playerRoutes(runtime as any))
  }

  test("POST /api/player/play/:workshopId calls Playback.play", async () => {
    let playCalledWith = ""
    const app = getApp({
      play: (id) =>
        Effect.sync(() => {
          playCalledWith = id
          return { ok: true, path: "/path" }
        }),
    })

    const response = await app.handle(
      new Request("http://localhost/api/player/play/123", { method: "POST" })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, path: "/path" })
    expect(playCalledWith).toBe("123")
  })

  test("POST /api/player/stop calls Playback.stop", async () => {
    let stopCalled = false
    const app = getApp({
      stop: () =>
        Effect.sync(() => {
          stopCalled = true
          return { ok: true }
        }),
    })

    const response = await app.handle(
      new Request("http://localhost/api/player/stop", { method: "POST" })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(stopCalled).toBe(true)
  })

  test("POST /api/player/sleep calls Playback.sleep", async () => {
    let sleepCalledWith = -1
    const app = getApp({
      sleep: (mins) =>
        Effect.sync(() => {
          sleepCalledWith = mins
          return { active: true, deadline: 123_456_789 }
        }),
    })

    const response = await app.handle(
      new Request("http://localhost/api/player/sleep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ minutes: 30 }),
      })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ active: true, deadline: 123_456_789 })
    expect(sleepCalledWith).toBe(30)
  })
})
