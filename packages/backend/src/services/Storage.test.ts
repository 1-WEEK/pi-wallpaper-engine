import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  describeAccessFailure,
  friendlyStorageError,
  isPathInsideRoot,
  normalizeCustomRootPath,
  probeMediaRoot,
  Storage,
  StorageLive,
} from "./Storage.js"
import { StorageError } from "@pwe/shared"
import { Config, type RuntimeConfig } from "./Config.js"

const openDirs: string[] = []

const tempRoot = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "pwe-storage-"))
  openDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (openDirs.length > 0) {
    const dir = openDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

const makeStorageRuntime = (configPath: string, root: string) => {
  const config: RuntimeConfig = {
    steam: { username: "u", web_api_key: "k", steamcmd_path: "/x" },
    paths: { data_root: join(tmpdir(), "pwe-unused-default"), source_dir: "source", optimized_dir: "optimized" },
    storage: { root },
    screen: { width: 1200, height: 1080, default_display_mode: "fill" },
    mpv: { binary_path: "mpv", ipc_socket: "/tmp/x.sock", hwdec: "auto", gpu_api: "opengl" },
    transcode: { target_codec: "hevc", target_quality: 23, heartbeat_timeout_ms: 60_000 },
    server: { host: "0.0.0.0", port: 8080 },
  }

  return ManagedRuntime.make(StorageLive(configPath).pipe(Layer.provide(Layer.succeed(Config, config))))
}

describe("normalizeCustomRootPath", () => {
  test("accepts ordinary absolute paths", async () => {
    await expect(Effect.runPromise(normalizeCustomRootPath("Root", "/mnt/media"))).resolves.toBe(
      "/mnt/media"
    )
    await expect(
      Effect.runPromise(normalizeCustomRootPath("Root", " /media/usb/pi-wallpaper-engine "))
    ).resolves.toBe("/media/usb/pi-wallpaper-engine")
  })

  test("rejects empty, relative, and control-character paths", async () => {
    await expect(Effect.runPromise(normalizeCustomRootPath("Root", ""))).rejects.toThrow(
      "absolute directory path"
    )
    await expect(Effect.runPromise(normalizeCustomRootPath("Root", "media/usb"))).rejects.toThrow(
      "absolute directory path"
    )
    await expect(
      Effect.runPromise(normalizeCustomRootPath("Root", "/media/usb\nother"))
    ).rejects.toThrow("absolute directory path")
  })
})

describe("isPathInsideRoot", () => {
  test("matches files inside the selected root", () => {
    expect(isPathInsideRoot("/mnt/pwe/share/video.mp4", "/mnt/pwe/share")).toBe(true)
    expect(isPathInsideRoot("/mnt/pwe/share/subdir/video.mp4", "/mnt/pwe/share")).toBe(true)
  })

  test("does not confuse sibling prefixes with descendants", () => {
    expect(isPathInsideRoot("/mnt/pwe/share-2/video.mp4", "/mnt/pwe/share")).toBe(false)
  })

  test("rejects paths outside the selected root", () => {
    expect(isPathInsideRoot("/mnt/other/video.mp4", "/mnt/pwe/share")).toBe(false)
  })
})

describe("friendlyStorageError", () => {
  test("returns user-facing messages", () => {
    expect(
      friendlyStorageError(new StorageError({ kind: "Busy", message: "busy" }))
    ).toContain("Stop playback")
    expect(
      friendlyStorageError(new StorageError({ kind: "Disconnected", message: "down" }))
    ).toContain("unavailable")
  })
})

describe("describeAccessFailure", () => {
  test("names the causing path and says whether the directory is missing", () => {
    const missing = describeAccessFailure("/mnt/share", { code: "ENOENT" }, false)
    expect(missing).toContain("/mnt/share")
    expect(missing).toContain("does not exist")
    expect(missing).toContain("ENOENT")

    const unusable = describeAccessFailure("/mnt/share", { code: "EACCES" }, true)
    expect(unusable).toContain("/mnt/share")
    expect(unusable).toContain("not readable and writable")
    expect(unusable).toContain("EACCES")
  })

  test("still produces a message for a cause with no code and for a non-object", () => {
    expect(describeAccessFailure("/mnt/share", new Error("permission denied"), true)).toContain(
      "permission denied"
    )
    expect(describeAccessFailure("/mnt/share", "boom", false)).toContain("boom")
  })
})

describe("probeMediaRoot", () => {
  test("reports a readable directory as available with no reason", async () => {
    const root = await tempRoot()
    await expect(Effect.runPromise(probeMediaRoot(root))).resolves.toEqual({
      root,
      available: true,
      reason: null,
    })
  })

  test("reports a missing directory as unavailable and names it", async () => {
    const root = join(tmpdir(), "pwe-definitely-absent")
    const probe = await Effect.runPromise(probeMediaRoot(root))
    expect(probe.available).toBe(false)
    expect(probe.root).toBe(root)
    expect(probe.reason).toContain(root)
  })

  test("never fails: unavailable is a result, not an error", async () => {
    // The recovery path depends on this: callers have to *converge* on a
    // verdict, so an unreachable root must not abort the effect.
    await expect(Effect.runPromise(probeMediaRoot("/proc/1/mem/absent"))).resolves.toMatchObject({
      available: false,
    })
  })
})

// The media root comes and goes while the backend runs (ticket 01 of
// `.scratch/playback-mount-resilience`). `status()` and `mediaRoot()` are the
// seam everything else reads, so the outage and its recovery must be visible
// through them without any cached state surviving the transition.
describe("Storage across a media-root outage", () => {
  test("status reports the outage, names the path, and clears it on recovery", async () => {
    const parent = await tempRoot()
    const root = join(parent, "media")
    const configPath = join(parent, "config.json")
    const runtime = makeStorageRuntime(configPath, root)

    try {
      // Mounted.
      await mkdir(root, { recursive: true })
      const before = await runtime.runPromise(Effect.flatMap(Storage, (s) => s.status()))
      expect(before.available).toBe(true)
      expect(before.last_error).toBeNull()
      expect(before.data_root).toBe(root)

      // The mount goes away.
      await rm(root, { recursive: true, force: true })

      const during = await runtime.runPromise(Effect.flatMap(Storage, (s) => s.status()))
      expect(during.available).toBe(false)
      expect(during.last_error).toContain(root)
      expect(during.data_root).toBe(root)

      // A second read while still down must agree, not drift.
      await expect(
        runtime.runPromise(Effect.flatMap(Storage, (s) => s.status()))
      ).resolves.toEqual(during)

      // The mount comes back on the same path: the failure must not outlive it.
      await mkdir(root, { recursive: true })

      const after = await runtime.runPromise(Effect.flatMap(Storage, (s) => s.status()))
      expect(after.available).toBe(true)
      expect(after.last_error).toBeNull()
    } finally {
      await runtime.dispose()
    }
  })

  test("mediaRoot fails while the root is gone and answers again once it returns", async () => {
    const parent = await tempRoot()
    const root = join(parent, "media")
    const configPath = join(parent, "config.json")
    const runtime = makeStorageRuntime(configPath, root)

    try {
      // Not mounted yet: the failing behaviour is what PlayerPower's startup
      // restore hits, and what the recovery loop retries later.
      await expect(
        runtime.runPromise(Effect.flatMap(Storage, (s) => s.mediaRoot()))
      ).rejects.toThrow(`Media root is not accessible at ${root}`)

      await expect(
        runtime.runPromise(Effect.flatMap(Storage, (s) => s.mediaRootOrNull()))
      ).resolves.toBeNull()

      // The mount arrives.
      await mkdir(root, { recursive: true })

      await expect(
        runtime.runPromise(Effect.flatMap(Storage, (s) => s.mediaRoot()))
      ).resolves.toBe(root)

      const after = await runtime.runPromise(Effect.flatMap(Storage, (s) => s.status()))
      expect(after.available).toBe(true)
      expect(after.last_error).toBeNull()
    } finally {
      await runtime.dispose()
    }
  })
})
