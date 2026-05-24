import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import type { LibraryItem } from "@pwe/shared"
import { Display, type DisplayStatus } from "./Display.js"
import { Library } from "./Library.js"
import { Logger } from "./Logger.js"
import { Mpv } from "./Mpv.js"
import {
  PlayerPower,
  PlayerPowerLive,
  shouldAutoRestoreOnStartup,
  shouldPowerOnBeforePlay,
} from "./PlayerPower.js"
import { PlayerState } from "./PlayerState.js"

const libraryItem: LibraryItem = {
  workshop_id: "123",
  title: "Test Wallpaper",
  author: "",
  preview_url: "",
  content_rating: null,
  rating_sex: null,
  source_path: "source/123/video.mp4",
  source_resolution: "1920x1080",
  source_codec: "h264",
  source_size: 100,
  downloaded_at: 1,
  transcode_status: "skipped",
  transcode_progress: 0,
  transcode_error: null,
  transcoded_path: null,
  transcoded_resolution: null,
  transcoded_codec: null,
  transcoded_size: null,
  display_mode: "fill",
  last_played_at: null,
}

const makeRuntime = (displayStatus: DisplayStatus) => {
  const events: string[] = []

  const displayLayer = Layer.succeed(Display, {
    on: () => Effect.sync(() => events.push("display.on")),
    off: () => Effect.sync(() => events.push("display.off")),
    status: () =>
      Effect.sync(() => {
        events.push("display.status")
        return displayStatus
      }),
  })

  const libraryLayer = Layer.succeed(Library, {
    list: () => Effect.succeed([libraryItem]),
    get: () => Effect.succeed(libraryItem),
    insert: () => Effect.void,
    update: () => Effect.sync(() => events.push("library.update")),
    remove: () => Effect.void,
    playablePath: () => Effect.succeed("/media/source/123/video.mp4"),
  })

  const loggerLayer = Layer.succeed(Logger, {
    info: () => Effect.void,
    warn: () => Effect.void,
    error: () => Effect.void,
    debug: () => Effect.void,
  })

  const mpvLayer = Layer.succeed(Mpv, {
    play: () => Effect.sync(() => events.push("mpv.play")),
    pause: () => Effect.void,
    resume: () => Effect.void,
    stop: () => Effect.void,
    setDisplayMode: () => Effect.sync(() => events.push("mpv.setDisplayMode")),
    status: () =>
      Effect.succeed({
        playing: false,
        current_workshop_id: null,
        path: null,
        display_mode: "fill" as const,
      }),
  })

  const playerStateLayer = Layer.succeed(PlayerState, {
    getRestore: () => Effect.succeed(null),
    setRestore: () => Effect.void,
    clearRestore: () => Effect.sync(() => events.push("playerState.clearRestore")),
  })

  const envLayer = Layer.mergeAll(
    displayLayer,
    libraryLayer,
    loggerLayer,
    mpvLayer,
    playerStateLayer
  )

  return {
    events,
    runtime: ManagedRuntime.make(PlayerPowerLive.pipe(Layer.provide(envLayer))),
  }
}

describe("shouldAutoRestoreOnStartup", () => {
  test("requires a probed display-on state", () => {
    expect(shouldAutoRestoreOnStartup({ state: "on", source: "probed" })).toBe(true)
  })

  test("does not restore from cached or unknown display state", () => {
    expect(shouldAutoRestoreOnStartup({ state: "on", source: "cached" })).toBe(false)
    expect(shouldAutoRestoreOnStartup({ state: "unknown", source: "default" })).toBe(false)
    expect(shouldAutoRestoreOnStartup({ state: "off", source: "probed" })).toBe(false)
  })
})

describe("shouldPowerOnBeforePlay", () => {
  test("powers on before explicit play when the display is known off", () => {
    expect(shouldPowerOnBeforePlay({ state: "off", source: "probed" })).toBe(true)
    expect(shouldPowerOnBeforePlay({ state: "off", source: "cached" })).toBe(true)
  })

  test("does not power on when display state is on or unknown", () => {
    expect(shouldPowerOnBeforePlay({ state: "on", source: "probed" })).toBe(false)
    expect(shouldPowerOnBeforePlay({ state: "unknown", source: "default" })).toBe(false)
  })
})

describe("PlayerPower.play", () => {
  test("turns the display on before playing when the display was off", async () => {
    const { events, runtime } = makeRuntime({ state: "off", source: "cached" })

    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const playerPower = yield* PlayerPower
          yield* playerPower.play("123")
        })
      )
    } finally {
      await runtime.dispose()
    }

    expect(events).toContain("display.on")
    expect(events.indexOf("display.on")).toBeLessThan(events.indexOf("mpv.play"))
  })

  test("does not require display power when display state is unknown", async () => {
    const { events, runtime } = makeRuntime({ state: "unknown", source: "default" })

    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const playerPower = yield* PlayerPower
          yield* playerPower.play("123")
        })
      )
    } finally {
      await runtime.dispose()
    }

    expect(events).not.toContain("display.on")
    expect(events).toContain("mpv.play")
  })
})
