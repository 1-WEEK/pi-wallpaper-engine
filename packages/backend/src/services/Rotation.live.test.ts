import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { DbError, type LibraryItem } from "@pwe/shared"
import { Library } from "./Library.js"
import { Logger } from "./Logger.js"
import { Mpv } from "./Mpv.js"
import { PlaybackPrefs } from "./PlaybackPrefs.js"
import { Rotation, RotationLive } from "./Rotation.js"

const makeRow = (id: string): LibraryItem =>
  ({
    workshop_id: id,
    title: id,
    display_mode: "fill",
    source_path: `source/${id}.mp4`,
  }) as unknown as LibraryItem

let runtimes: ManagedRuntime.ManagedRuntime<never, never>[] = []

// Build a Rotation harness over an in-memory fake library. `missing` ids fail
// library.get so we can assert the skip-missing behavior.
const buildHarness = (ids: string[], missing: Set<string>) => {
  const played: string[] = []
  let current: string | null = null

  const mpv = Layer.succeed(Mpv, {
    play: (id: string) =>
      Effect.sync(() => {
        played.push(id)
        current = id
      }),
    pause: () => Effect.void,
    resume: () => Effect.void,
    stop: () => Effect.void,
    setDisplayMode: () => Effect.void,
    status: () =>
      Effect.succeed({
        playing: current !== null,
        current_workshop_id: current,
        path: null,
        display_mode: "fill" as const,
      }),
  })

  const library = Layer.succeed(Library, {
    list: () => Effect.succeed(ids.map(makeRow)),
    get: (id: string) =>
      missing.has(id)
        ? Effect.fail(new DbError({ operation: "get", cause: "missing" }))
        : Effect.succeed(makeRow(id)),
    insert: () => Effect.void,
    update: () => Effect.void,
    remove: () => Effect.void,
    playablePath: (row: LibraryItem) => Effect.succeed(`/media/${row.workshop_id}.mp4`),
  })

  const prefs = Layer.succeed(PlaybackPrefs, {
    get: () => Effect.succeed({ play_mode: "sequential" as const, rotation_interval_sec: 600 }),
    setMode: () => Effect.void,
    setInterval: () => Effect.void,
  })

  const logger = Layer.succeed(Logger, {
    info: () => Effect.void,
    warn: () => Effect.void,
    error: () => Effect.void,
    debug: () => Effect.void,
  })

  const runtime = ManagedRuntime.make(
    RotationLive.pipe(Layer.provide(Layer.mergeAll(mpv, library, prefs, logger)))
  )
  runtimes.push(runtime)
  return { played, runtime }
}

afterEach(async () => {
  for (const rt of runtimes) await rt.dispose()
  runtimes = []
})

describe("RotationLive", () => {
  test("next advances sequentially and skips items missing on disk", async () => {
    const { played, runtime } = buildHarness(["a", "b", "c", "d"], new Set(["c"]))

    await runtime.runPromise(
      Effect.gen(function* () {
        const rot = yield* Rotation
        yield* rot.arm("a") // sequential, anchor at "a" (index 0)
        yield* rot.next() // a -> b
        yield* rot.next() // b -> c(missing) -> skip -> d
      })
    )

    expect(played).toEqual(["b", "d"])
  })

  test("prev wraps around to the end of the sequence", async () => {
    const { played, runtime } = buildHarness(["a", "b", "c"], new Set())

    await runtime.runPromise(
      Effect.gen(function* () {
        const rot = yield* Rotation
        yield* rot.arm("a") // anchor index 0
        yield* rot.prev() // wraps to last -> c
      })
    )

    expect(played).toEqual(["c"])
  })
})
