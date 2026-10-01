import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Config, type RuntimeConfig } from "./Config.js"
import { Logger } from "./Logger.js"
import { MediaRootWatch, MediaRootWatchLive, STARTUP_PROBE_DELAY_MS } from "./MediaRootWatch.js"
import { Storage, StorageLive } from "./Storage.js"

const openDirs: string[] = []

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "pwe-watch-"))
  openDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (openDirs.length > 0) {
    const dir = openDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

/**
 * The watch is built on a real `Storage`, because the property under test is
 * partly *which* root it watches: the active root is mutable at runtime, so the
 * watch must read the live one rather than a path captured from config.
 */
const buildRuntime = async (root: string) => {
  const parent = await tempDir()
  const configPath = join(parent, "config.json")
  const config: RuntimeConfig = {
    steam: { username: "u", web_api_key: "k", steamcmd_path: "/x" },
    paths: {
      data_root: join(parent, "default-root"),
      source_dir: "source",
      optimized_dir: "optimized",
    },
    storage: { root },
    screen: { width: 1200, height: 1080, default_display_mode: "fill" },
    mpv: { binary_path: "mpv", ipc_socket: "/tmp/x.sock", hwdec: "auto", gpu_api: "opengl" },
    transcode: { target_codec: "hevc", target_quality: 23, heartbeat_timeout_ms: 60_000 },
    server: { host: "0.0.0.0", port: 8080 },
  }

  // `saveRoot` persists the switch into the config file, so the file has to
  // exist for the runtime root-switch path to work at all.
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8")

  const envLayer = Layer.mergeAll(
    Layer.succeed(Config, config),
    Layer.succeed(Logger, {
      info: () => Effect.void,
      warn: () => Effect.void,
      error: () => Effect.void,
      debug: () => Effect.void,
    })
  )

  return {
    parent,
    runtime: ManagedRuntime.make(
      MediaRootWatchLive.pipe(
        Layer.provideMerge(StorageLive(configPath)),
        Layer.provide(envLayer)
      )
    ),
  }
}

// The watch's first probe is deliberately delayed (see STARTUP_PROBE_DELAY_MS),
// so these tests wait out the real delay rather than poking at internals.
const afterFirstProbe = () => Effect.sleep(STARTUP_PROBE_DELAY_MS + 400)

describe("MediaRootWatch", () => {
  test("republishes every reachable probe, not only the transition into reachable", async () => {
    const root = await tempDir()
    const { runtime } = await buildRuntime(root)

    const seen: string[] = []
    try {
      await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const watch = yield* MediaRootWatch
            yield* Effect.forkScoped(
              watch.availableProbes().pipe(
                Stream.mapEffect((status) => Effect.sync(() => seen.push(status.root))),
                Stream.runDrain
              )
            )

            yield* afterFirstProbe()
            // One more probe with the root *still* reachable. A transition-only
            // signal would stay silent here; the recovery retry depends on it
            // firing, because a retry that failed while the root was up needs
            // another chance without waiting for an outage that is not coming.
            yield* watch.probeNow()
            yield* Effect.sleep("300 millis")
          })
        )
      )
    } finally {
      await runtime.dispose()
    }

    expect(seen).toEqual([root, root])
  })

  test("stays silent while the media root is unreachable", async () => {
    const { runtime } = await buildRuntime(join(tmpdir(), "pwe-does-not-exist"))

    const seen: string[] = []
    try {
      await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const watch = yield* MediaRootWatch
            yield* Effect.forkScoped(
              watch.availableProbes().pipe(
                Stream.mapEffect((status) => Effect.sync(() => seen.push(status.root))),
                Stream.runDrain
              )
            )
            yield* afterFirstProbe()
          })
        )
      )
    } finally {
      await runtime.dispose()
    }

    expect(seen).toEqual([])
  })

  test("probeNow collapses the idle tick instead of waiting it out", async () => {
    const root = await tempDir()
    const { runtime } = await buildRuntime(root)

    const probes: number[] = []
    try {
      await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const watch = yield* MediaRootWatch
            yield* Effect.forkScoped(
              watch.availableProbes().pipe(
                Stream.mapEffect(() => Effect.sync(() => probes.push(Date.now()))),
                Stream.runDrain
              )
            )

            yield* afterFirstProbe()
            const before = Date.now()
            yield* watch.probeNow()
            yield* Effect.sleep("300 millis")
            // Far inside AVAILABLE_TICK, which is a whole minute.
            expect(Date.now() - before).toBeLessThan(5_000)
          })
        )
      )
    } finally {
      await runtime.dispose()
    }

    expect(probes.length).toBe(2)
  })

  test("follows the active root when it is switched at runtime", async () => {
    // The regression this guards: a watch that reads the root from config at
    // construction keeps probing the old path after the root-switch route or a
    // migration changes it, so recovery silently stops working.
    const first = await tempDir()
    const { parent, runtime } = await buildRuntime(first)
    const second = join(parent, "second-root")
    await mkdir(second)

    try {
      const result = await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const watch = yield* MediaRootWatch
            const storage = yield* Storage

            const statuses: Array<{ root: string; available: boolean }> = []
            yield* Effect.forkScoped(
              watch.availableProbes().pipe(
                Stream.mapEffect((status) =>
                  Effect.sync(() => statuses.push({ root: status.root, available: status.available }))
                ),
                Stream.runDrain
              )
            )

            yield* afterFirstProbe()

            // Switch the active root the way the route and Migrate do, then
            // take the first root away: a stale watch would now report the
            // *new* root as available (it is still probing the old path).
            yield* storage.saveRoot(second)
            yield* Effect.promise(() => rm(first, { recursive: true, force: true }))
            yield* watch.probeNow()
            yield* Effect.sleep("300 millis")

            return statuses
          })
        )
      )

      const afterSwitch = result.filter((s) => s.root === second)
      expect(afterSwitch.length).toBeGreaterThan(0)
      expect(afterSwitch.every((s) => s.available)).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })
})
