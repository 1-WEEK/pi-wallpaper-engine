import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime, Queue, Stream } from "effect"
import type { LibraryItem } from "@pwe/shared"
import { MpvIpcError } from "@pwe/shared"
import { Display, type DisplayStatus } from "./Display.js"
import { Library } from "./Library.js"
import { Logger } from "./Logger.js"
import { MediaRootWatch, type MediaRootStatus } from "./MediaRootWatch.js"
import { Mpv } from "./Mpv.js"
import { PlayerPower, PlayerPowerLive } from "./PlayerPower.js"
import { PlayerState, type RestoreReason } from "./PlayerState.js"
import { Storage } from "./Storage.js"

const item: LibraryItem = {
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

interface Save {
  readonly workshop_id: string
  readonly reason: RestoreReason
}

/**
 * The media-root recovery paths (ticket 01) are driven through a controllable
 * watch, because the condition under test *is* "the root answered again". The
 * real watch's cadence is its own suite's business; what matters here is the
 * decision made from each verdict.
 *
 * The display status defaults to `off` on purpose: with a probed `on` the
 * service also runs its startup restore at construction, which would restore
 * (or consume) the held wallpaper before any test could publish a probe.
 */
const makeHarness = (options: {
  readonly displayStatus?: DisplayStatus
  readonly saved?: Save | null
  readonly storageAvailable?: boolean
  readonly failPlays?: number
}) => {
  const events: string[] = []
  let stored: Save | null = options.saved ?? null
  let playsToFail = options.failPlays ?? 0

  const displayLayer = Layer.succeed(Display, {
    on: () => Effect.sync(() => events.push("display.on")),
    off: () => Effect.sync(() => events.push("display.off")),
    status: () => Effect.succeed(options.displayStatus ?? { state: "off", source: "probed" }),
  })

  const libraryLayer = Layer.succeed(Library, {
    list: () => Effect.succeed([item]),
    get: () => Effect.succeed(item),
    insert: () => Effect.void,
    update: () => Effect.void,
    remove: () => Effect.void,
    playablePath: () => Effect.succeed("/media/source/123/video.mp4"),
  })

  const mpvEnded = Effect.runSync(Queue.unbounded<void>())
  // A Queue, not a PubSub: these tests publish before the service's fibers
  // have necessarily subscribed, and a PubSub drops what nobody is listening
  // for. The queue buffers, so "the root answered" is not a race.
  const probes = Effect.runSync(Queue.unbounded<MediaRootStatus>())

  const mpvLayer = Layer.succeed(Mpv, {
    play: () =>
      playsToFail > 0
        ? Effect.sync(() => {
            playsToFail -= 1
            events.push("mpv.play:failed")
          }).pipe(Effect.andThen(Effect.fail(new MpvIpcError({ reason: "no such file" }))))
        : Effect.sync(() => events.push("mpv.play")),
    pause: () => Effect.void,
    resume: () => Effect.void,
    stop: () => Effect.sync(() => events.push("mpv.stop")),
    setDisplayMode: () => Effect.void,
    status: () =>
      Effect.succeed({
        playing: false,
        current_workshop_id: stored?.workshop_id ?? null,
        path: null,
        display_mode: "fill" as const,
      }),
    ended: () => Stream.fromQueue(mpvEnded),
  })

  const playerStateLayer = Layer.succeed(PlayerState, {
    getRestore: () => Effect.sync(() => (stored === null ? null : { ...stored, updated_at: 0 })),
    setRestore: (workshopId, reason) =>
      Effect.sync(() => {
        events.push(`playerState.setRestore:${reason}`)
        stored = { workshop_id: workshopId, reason }
      }),
    clearRestore: () =>
      Effect.sync(() => {
        events.push("playerState.clearRestore")
        stored = null
      }),
  })

  const storageLayer = Layer.succeed(Storage, {
    status: () =>
      Effect.succeed({
        available: options.storageAvailable ?? true,
        data_root: "/media",
        default_root: "/media",
        using_default: true,
        last_error: options.storageAvailable === false ? "Media root is gone." : null,
      }),
    mediaRoot: () => Effect.succeed("/media"),
    mediaRootOrNull: () => Effect.succeed("/media"),
    saveRoot: () => Effect.die("unused in this test"),
  })

  const probeNowCalls: number[] = []
  const watchLayer = Layer.succeed(MediaRootWatch, {
    availableProbes: () => Stream.fromQueue(probes),
    probeNow: () =>
      Effect.sync(() => {
        probeNowCalls.push(Date.now())
      }),
  })

  const loggerLayer = Layer.succeed(Logger, {
    info: () => Effect.void,
    warn: () => Effect.void,
    error: () => Effect.void,
    debug: () => Effect.void,
  })

  const envLayer = Layer.mergeAll(
    displayLayer,
    libraryLayer,
    loggerLayer,
    mpvLayer,
    playerStateLayer,
    storageLayer,
    watchLayer
  )

  const runtime = ManagedRuntime.make(PlayerPowerLive.pipe(Layer.provide(envLayer)))

  return {
    events,
    runtime,
    /** One reachable probe of the media root, exactly as the watch emits it. */
    rootCameBack: () =>
      Queue.offer(probes, { available: true, root: "/media", reason: null }).pipe(
        Effect.andThen(Effect.sleep("50 millis"))
      ),
    /** One self-arranged file end, exactly as mpv reports it. */
    fileEnded: () => Queue.offer(mpvEnded, undefined).pipe(Effect.andThen(Effect.sleep("50 millis"))),
    probeNowCalls,
    saved: () => stored,
  }
}

describe("PlayerPower media-root recovery", () => {
  test("a late mount finishes the restore and reports the wallpaper as recovered", async () => {
    const harness = makeHarness({ saved: { workshop_id: "123", reason: "media_lost" } })
    try {
      const recovered: string[] = []
      await harness.runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const playerPower = yield* PlayerPower
            yield* Effect.forkScoped(
              playerPower.recovered().pipe(
                Stream.mapEffect((id) => Effect.sync(() => recovered.push(id))),
                Stream.runDrain
              )
            )

            // Give the forked subscriber a turn to register before the probe
            // that makes the service publish.
            yield* Effect.sleep("20 millis")
            yield* harness.rootCameBack()
          })
        )
      )

      expect(harness.events).toContain("mpv.play")
      expect(harness.events).toContain("playerState.clearRestore")
      expect(recovered).toEqual(["123"])
    } finally {
      await harness.runtime.dispose()
    }
  })

  test("does not announce a startup restore as a recovery, so rotation stays disarmed (ADR 0009)", async () => {
    // ADR 0009: a startup restore loops the single wallpaper and does not arm
    // rotation. Resuming it via the media-root watch must not change that —
    // Playback arms rotation off this signal, so the signal has to stay silent.
    const harness = makeHarness({ saved: { workshop_id: "123", reason: "startup" } })
    try {
      const recovered: string[] = []
      await harness.runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const playerPower = yield* PlayerPower
            yield* Effect.forkScoped(
              playerPower.recovered().pipe(
                Stream.mapEffect((id) => Effect.sync(() => recovered.push(id))),
                Stream.runDrain
              )
            )

            yield* Effect.sleep("20 millis")
            yield* harness.rootCameBack()
          })
        )
      )

      // The wallpaper does come back...
      expect(harness.events).toContain("mpv.play")
      // ...but not as a rotation-arming recovery.
      expect(recovered).toEqual([])
    } finally {
      await harness.runtime.dispose()
    }
  })

  test("retries on the next reachable probe when the restore itself failed", async () => {
    // The case a transition-only trigger misses: the root never changed, but
    // the restore did not take. The hold must survive, and the next probe must
    // try again.
    const harness = makeHarness({
      saved: { workshop_id: "123", reason: "media_lost" },
      failPlays: 1,
    })
    try {
      await harness.runtime.runPromise(harness.rootCameBack())
      await harness.runtime.runPromise(harness.rootCameBack())

      expect(harness.events.filter((e) => e === "mpv.play:failed")).toHaveLength(1)
      expect(harness.events.filter((e) => e === "mpv.play")).toHaveLength(1)
      expect(harness.saved()).toBeNull()
    } finally {
      await harness.runtime.dispose()
    }
  })

  test("does not override a deliberate display-off hold when the root returns", async () => {
    const harness = makeHarness({ saved: { workshop_id: "123", reason: "display_off" } })
    try {
      await harness.runtime.runPromise(harness.rootCameBack())

      expect(harness.events).not.toContain("mpv.play")
      expect(harness.saved()).toEqual({ workshop_id: "123", reason: "display_off" })
    } finally {
      await harness.runtime.dispose()
    }
  })

  test("holds the wallpaper and wakes the watch when the file stops with the root gone", async () => {
    const harness = makeHarness({
      saved: { workshop_id: "123", reason: "media_lost" },
      storageAvailable: false,
    })
    try {
      await harness.runtime.runPromise(harness.fileEnded())

      expect(harness.saved()).toEqual({ workshop_id: "123", reason: "media_lost" })
      expect(harness.probeNowCalls).toHaveLength(1)
    } finally {
      await harness.runtime.dispose()
    }
  })

  test("leaves a file that stopped with the root reachable alone", async () => {
    // A codec quirk or a genuinely corrupt download stops playback too, and
    // nothing about that means the wallpaper should be dropped on recovery.
    const harness = makeHarness({
      saved: { workshop_id: "123", reason: "manual_stop" },
      storageAvailable: true,
    })
    try {
      await harness.runtime.runPromise(harness.fileEnded())

      expect(harness.events).not.toContain("playerState.setRestore:media_lost")
      expect(harness.saved()).toEqual({ workshop_id: "123", reason: "manual_stop" })
      expect(harness.probeNowCalls).toHaveLength(0)
    } finally {
      await harness.runtime.dispose()
    }
  })
})

describe("PlayerPower startup restore across a missing mount", () => {
  test("keeps the wallpaper for the recovery loop when the mount is not up yet", async () => {
    // Boot with the display already on and the media root not mounted: the
    // startup attempt fails against `library.playablePath`, so the wallpaper
    // has to stay held with a reason the recovery loop retries — that is the
    // nine-day silent-idle failure this ticket exists to remove.
    const harness = makeHarness({
      displayStatus: { state: "on", source: "probed" },
      saved: { workshop_id: "123", reason: "display_off" },
      failPlays: 1,
    })
    try {
      await harness.runtime.runPromise(Effect.sleep("50 millis"))
      expect(harness.events.filter((e) => e === "mpv.play:failed")).toHaveLength(1)
      expect(harness.events).toContain("playerState.setRestore:startup")

      await harness.runtime.runPromise(harness.rootCameBack())
      expect(harness.events).toContain("mpv.play")
    } finally {
      await harness.runtime.dispose()
    }
  })
})
