import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime, Ref, Stream } from "effect"
import { Mpv, type MpvImpl, type PlayerStatus, shouldConvergeToIdle, shouldReassertFullscreen } from "./Mpv.js"
import type { DisplayMode } from "@pwe/shared"

// ── Mock factory ──────────────────────────────────────────────

interface MockMpvMemento {
  readonly impl: MpvImpl
  readonly statusRef: Ref.Ref<PlayerStatus>
  readonly sentCommands: Ref.Ref<unknown[][]>
}

const makeMockMpv = Effect.sync((): MockMpvMemento => {
  const statusRef = Ref.makeUnsafe<PlayerStatus>({
    playing: false,
    current_workshop_id: null,
    path: null,
    display_mode: "fill",
  })

  const sentCommands = Ref.makeUnsafe<unknown[][]>([])

  const send = (cmd: unknown[]) => Ref.update(sentCommands, (cmds) => [...cmds, cmd])

  const impl: MpvImpl = {
    play: (workshopId, path) =>
      Effect.gen(function* () {
        yield* send(["loadfile", path, "replace"])
        yield* send(["set_property", "pause", false])
        yield* Ref.update(statusRef, (s) => ({
          ...s,
          playing: true,
          current_workshop_id: workshopId,
          path,
        }))
      }),

    pause: () =>
      Effect.gen(function* () {
        yield* send(["set_property", "pause", true])
        yield* Ref.update(statusRef, (s) => ({ ...s, playing: false }))
      }),

    resume: () =>
      Effect.gen(function* () {
        yield* send(["set_property", "pause", false])
        yield* Ref.update(statusRef, (s) => ({ ...s, playing: true }))
      }),

    stop: () =>
      Effect.gen(function* () {
        yield* send(["stop"])
        yield* Ref.update(statusRef, (s) => ({
          ...s,
          playing: false,
          current_workshop_id: null,
          path: null,
        }))
      }),

    setDisplayMode: (mode) =>
      Effect.gen(function* () {
        switch (mode) {
          case "fill":
            yield* send(["set_property", "keepaspect", true])
            yield* send(["set_property", "panscan", 1.0])
            break
          case "fit":
            yield* send(["set_property", "keepaspect", true])
            yield* send(["set_property", "panscan", 0.0])
            break
          case "stretch":
            yield* send(["set_property", "keepaspect", false])
            yield* send(["set_property", "panscan", 0.0])
            break
        }
        yield* Ref.update(statusRef, (s) => ({ ...s, display_mode: mode }))
      }),

    status: () => Ref.get(statusRef),

    // The mock has no IPC socket, so no end-of-file events; consumers that
    // subscribe get a stream that never emits.
    ended: () => Stream.empty,
  }

  return { impl, statusRef, sentCommands }
})

// ── Tests ─────────────────────────────────────────────────────

describe("Mpv (mock IPC)", () => {
  // ---- state management ----------------------------------------

  test("play() sets playing, workshop id, and path", async () => {
    const memento = await Effect.runPromise(makeMockMpv)
    const { impl, statusRef } = memento
    const runtime = ManagedRuntime.make(Layer.succeed(Mpv, impl))
    try {
      await runtime.runPromise(Effect.flatMap(Mpv, (m) => m.play("ws-1", "/vids/forest.mp4")))
      const s = Effect.runSync(Ref.get(statusRef))
      expect(s.playing).toBe(true)
      expect(s.current_workshop_id).toBe("ws-1")
      expect(s.path).toBe("/vids/forest.mp4")
    } finally {
      await runtime.dispose()
    }
  })

  test("pause() sets playing to false", async () => {
    const memento = await Effect.runPromise(makeMockMpv)
    const { impl, statusRef } = memento
    const runtime = ManagedRuntime.make(Layer.succeed(Mpv, impl))
    try {
      await runtime.runPromise(Effect.flatMap(Mpv, (m) => m.play("ws-1", "/vids/forest.mp4")))
      await runtime.runPromise(Effect.flatMap(Mpv, (m) => m.pause()))
      const s = Effect.runSync(Ref.get(statusRef))
      expect(s.playing).toBe(false)
      expect(s.current_workshop_id).toBe("ws-1")
      expect(s.path).toBe("/vids/forest.mp4")
    } finally {
      await runtime.dispose()
    }
  })

  test("resume() restores playing to true after pause", async () => {
    const memento = await Effect.runPromise(makeMockMpv)
    const { impl, statusRef } = memento
    const runtime = ManagedRuntime.make(Layer.succeed(Mpv, impl))
    try {
      await runtime.runPromise(Effect.flatMap(Mpv, (m) => m.play("ws-1", "/vids/forest.mp4")))
      await runtime.runPromise(Effect.flatMap(Mpv, (m) => m.pause()))
      await runtime.runPromise(Effect.flatMap(Mpv, (m) => m.resume()))
      const s = Effect.runSync(Ref.get(statusRef))
      expect(s.playing).toBe(true)
      expect(s.current_workshop_id).toBe("ws-1")
    } finally {
      await runtime.dispose()
    }
  })

  test("stop() resets to idle state", async () => {
    const memento = await Effect.runPromise(makeMockMpv)
    const { impl, statusRef } = memento
    const runtime = ManagedRuntime.make(Layer.succeed(Mpv, impl))
    try {
      await runtime.runPromise(Effect.flatMap(Mpv, (m) => m.play("ws-1", "/vids/forest.mp4")))
      await runtime.runPromise(Effect.flatMap(Mpv, (m) => m.stop()))
      const s = Effect.runSync(Ref.get(statusRef))
      expect(s.playing).toBe(false)
      expect(s.current_workshop_id).toBeNull()
      expect(s.path).toBeNull()
      expect(s.display_mode).toBe("fill")
    } finally {
      await runtime.dispose()
    }
  })

  test("setDisplayMode transitions through all three modes", async () => {
    const memento = await Effect.runPromise(makeMockMpv)
    const { impl, statusRef } = memento
    const runtime = ManagedRuntime.make(Layer.succeed(Mpv, impl))
    try {
      const modes: DisplayMode[] = ["fill", "fit", "stretch"]
      for (const mode of modes) {
        await runtime.runPromise(Effect.flatMap(Mpv, (m) => m.setDisplayMode(mode)))
        const s = Effect.runSync(Ref.get(statusRef))
        expect(s.display_mode).toBe(mode)
      }
    } finally {
      await runtime.dispose()
    }
  })

  test("status() returns current state", async () => {
    const memento = await Effect.runPromise(makeMockMpv)
    const { impl } = memento
    const runtime = ManagedRuntime.make(Layer.succeed(Mpv, impl))
    try {
      const initial = await runtime.runPromise(Effect.flatMap(Mpv, (m) => m.status()))
      expect(initial).toMatchObject({
        playing: false,
        current_workshop_id: null,
        path: null,
        display_mode: "fill",
      })

      await runtime.runPromise(Effect.flatMap(Mpv, (m) => m.play("ws-1", "/vids/forest.mp4")))
      const afterPlay = await runtime.runPromise(Effect.flatMap(Mpv, (m) => m.status()))
      expect(afterPlay.playing).toBe(true)
      expect(afterPlay.current_workshop_id).toBe("ws-1")
    } finally {
      await runtime.dispose()
    }
  })

  // ---- command building (IPC payload verification) ------------

  test("play sends loadfile + set_property pause=false", async () => {
    const memento = await Effect.runPromise(makeMockMpv)
    const { impl, sentCommands } = memento
    const runtime = ManagedRuntime.make(Layer.succeed(Mpv, impl))
    try {
      await runtime.runPromise(Effect.flatMap(Mpv, (m) => m.play("ws-1", "/vids/forest.mp4")))
      const cmds = Effect.runSync(Ref.get(sentCommands))
      expect(cmds).toEqual([
        ["loadfile", "/vids/forest.mp4", "replace"],
        ["set_property", "pause", false],
      ])
    } finally {
      await runtime.dispose()
    }
  })

  test("pause sends set_property pause=true", async () => {
    const memento = await Effect.runPromise(makeMockMpv)
    const { impl, sentCommands } = memento
    const runtime = ManagedRuntime.make(Layer.succeed(Mpv, impl))
    try {
      await runtime.runPromise(Effect.flatMap(Mpv, (m) => m.pause()))
      const cmds = Effect.runSync(Ref.get(sentCommands))
      expect(cmds).toEqual([["set_property", "pause", true]])
    } finally {
      await runtime.dispose()
    }
  })

  test("resume sends set_property pause=false", async () => {
    const memento = await Effect.runPromise(makeMockMpv)
    const { impl, sentCommands } = memento
    const runtime = ManagedRuntime.make(Layer.succeed(Mpv, impl))
    try {
      await runtime.runPromise(Effect.flatMap(Mpv, (m) => m.resume()))
      const cmds = Effect.runSync(Ref.get(sentCommands))
      expect(cmds).toEqual([["set_property", "pause", false]])
    } finally {
      await runtime.dispose()
    }
  })

  test("stop sends stop command", async () => {
    const memento = await Effect.runPromise(makeMockMpv)
    const { impl, sentCommands } = memento
    const runtime = ManagedRuntime.make(Layer.succeed(Mpv, impl))
    try {
      await runtime.runPromise(Effect.flatMap(Mpv, (m) => m.stop()))
      const cmds = Effect.runSync(Ref.get(sentCommands))
      expect(cmds).toEqual([["stop"]])
    } finally {
      await runtime.dispose()
    }
  })

  describe("setDisplayMode command sequences", () => {
    test("fill sends keepaspect=true panscan=1.0", async () => {
      const memento = await Effect.runPromise(makeMockMpv)
      const { impl, sentCommands } = memento
      const runtime = ManagedRuntime.make(Layer.succeed(Mpv, impl))
      try {
        await runtime.runPromise(Effect.flatMap(Mpv, (m) => m.setDisplayMode("fill")))
        const cmds = Effect.runSync(Ref.get(sentCommands))
        expect(cmds).toEqual([
          ["set_property", "keepaspect", true],
          ["set_property", "panscan", 1.0],
        ])
      } finally {
        await runtime.dispose()
      }
    })

    test("fit sends keepaspect=true panscan=0.0", async () => {
      const memento = await Effect.runPromise(makeMockMpv)
      const { impl, sentCommands } = memento
      const runtime = ManagedRuntime.make(Layer.succeed(Mpv, impl))
      try {
        await runtime.runPromise(Effect.flatMap(Mpv, (m) => m.setDisplayMode("fit")))
        const cmds = Effect.runSync(Ref.get(sentCommands))
        expect(cmds).toEqual([
          ["set_property", "keepaspect", true],
          ["set_property", "panscan", 0.0],
        ])
      } finally {
        await runtime.dispose()
      }
    })

    test("stretch sends keepaspect=false panscan=0.0", async () => {
      const memento = await Effect.runPromise(makeMockMpv)
      const { impl, sentCommands } = memento
      const runtime = ManagedRuntime.make(Layer.succeed(Mpv, impl))
      try {
        await runtime.runPromise(Effect.flatMap(Mpv, (m) => m.setDisplayMode("stretch")))
        const cmds = Effect.runSync(Ref.get(sentCommands))
        expect(cmds).toEqual([
          ["set_property", "keepaspect", false],
          ["set_property", "panscan", 0.0],
        ])
      } finally {
        await runtime.dispose()
      }
    })
  })
})

// The compositor can strip fullscreen at runtime (observed on labwc after a
// display power cycle: mpv keeps running windowed with a titlebar). The
// backend observes the fullscreen property and must re-assert it whenever
// mpv reports it flipped to false — and only then.
describe("shouldReassertFullscreen", () => {
  test("true for a property-change event reporting fullscreen=false", () => {
    expect(
      shouldReassertFullscreen({ event: "property-change", id: 1, name: "fullscreen", data: false })
    ).toBe(true)
  })

  test("false when fullscreen is (re)gained", () => {
    expect(
      shouldReassertFullscreen({ event: "property-change", id: 1, name: "fullscreen", data: true })
    ).toBe(false)
  })

  test("false for property-change events on other properties", () => {
    expect(
      shouldReassertFullscreen({ event: "property-change", id: 2, name: "pause", data: false })
    ).toBe(false)
  })

  test("false for command replies and other events", () => {
    expect(shouldReassertFullscreen({ error: "success", request_id: 3, data: null })).toBe(false)
    expect(shouldReassertFullscreen({ event: "idle" })).toBe(false)
    expect(shouldReassertFullscreen(null)).toBe(false)
    expect(shouldReassertFullscreen("property-change")).toBe(false)
  })
})

// A wallpaper's file can stop without this backend asking: the share holding it
// went away, the file was deleted, a decode failed. mpv reports that as
// `end-file`, and the player has to converge to idle instead of reporting a
// wallpaper that is not on screen any more.
describe("shouldConvergeToIdle", () => {
  test("true for the reasons that mean the file stopped on its own", () => {
    expect(shouldConvergeToIdle({ event: "end-file", reason: "eof" })).toBe(true)
    expect(shouldConvergeToIdle({ event: "end-file", reason: "error" })).toBe(true)
    expect(shouldConvergeToIdle({ event: "end-file", reason: "unknown" })).toBe(true)
  })

  test("false for the reasons this backend caused", () => {
    // `stop` and `quit` are ours; `stop()` already converged the status ref and
    // treating them as a lost file would re-enter the recovery path on every
    // ordinary stop.
    expect(shouldConvergeToIdle({ event: "end-file", reason: "stop" })).toBe(false)
    expect(shouldConvergeToIdle({ event: "end-file", reason: "quit" })).toBe(false)
  })

  test("true for an end with no reason field", () => {
    // mpv versions have shipped `end-file` without `reason`; an unknown end is
    // still an end, and the consumer probes the media root before acting.
    expect(shouldConvergeToIdle({ event: "end-file" })).toBe(true)
    expect(shouldConvergeToIdle({ event: "end-file", reason: "redirect" })).toBe(true)
  })

  test("false for other events, command replies and non-objects", () => {
    expect(shouldConvergeToIdle({ event: "idle" })).toBe(false)
    expect(shouldConvergeToIdle({ error: "success", request_id: 3 })).toBe(false)
    expect(shouldConvergeToIdle({ event: "property-change", name: "fullscreen", data: false })).toBe(
      false
    )
    expect(shouldConvergeToIdle(null)).toBe(false)
    expect(shouldConvergeToIdle("end-file")).toBe(false)
  })
})
