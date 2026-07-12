import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import type { DownloadTask, LibraryItem } from "@pwe/shared"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Config, type RuntimeConfig } from "./Config.js"
import { Db, type DbImpl } from "./Db.js"
import { DownloadTasks, type DownloadTasksImpl } from "./DownloadTasks.js"
import { Library, type LibraryImpl } from "./Library.js"
import { Storage, type StorageImpl } from "./Storage.js"
import {
  StorageRootSelection,
  StorageRootSelectionLive,
  type StorageRootSelectionImpl,
} from "./StorageRootSelection.js"

let runtimes: Array<ManagedRuntime.ManagedRuntime<unknown, never>> = []
let tempDirs: string[] = []

afterEach(async () => {
  for (const runtime of runtimes) await runtime.dispose()
  runtimes = []
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

const makeConfig = (defaultRoot: string): RuntimeConfig => ({
  steam: { username: "u", web_api_key: "k", steamcmd_path: "/usr/local/bin/steamcmd" },
  paths: { data_root: defaultRoot, source_dir: "source", optimized_dir: "optimized" },
  storage: { root: null },
  screen: { width: 1920, height: 1080, default_display_mode: "fill" },
  mpv: { binary_path: "mpv", ipc_socket: "/tmp/x.sock", hwdec: "auto", gpu_api: "opengl" },
  transcode: { target_codec: "hevc", target_quality: 23, heartbeat_timeout_ms: 60_000 },
  server: { host: "0.0.0.0", port: 8080 },
})

const makeDownloadTask = (
  workshopId: string,
  patch: Partial<DownloadTask> = {}
): DownloadTask => ({
  workshop_id: workshopId,
  title: workshopId,
  preview_url: "",
  content_rating: null,
  rating_sex: null,
  adult_hint: 0,
  stage: "starting",
  message: "",
  started_at: 1,
  finished_at: null,
  percent: null,
  bytes_done: null,
  bytes_total: null,
  ...patch,
})

const makeLibraryRow = (workshopId: string): LibraryItem => ({
  workshop_id: workshopId,
  title: workshopId,
  author: "",
  preview_url: "",
  content_rating: null,
  rating_sex: null,
  source_path: `source/${workshopId}/wallpaper.mp4`,
  source_resolution: "1920x1080",
  source_codec: "h264",
  source_size: 123,
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
})

const makeHarness = (
  opts: {
    currentRoot?: string
    defaultRoot?: string
    tasks?: ReadonlyArray<DownloadTask>
    libraryRows?: ReadonlyArray<LibraryItem>
    activeTranscodes?: number
  } = {}
) => {
  const rootBase = tempDir("pwe-storage-root-selection-")
  const defaultRoot = opts.defaultRoot ?? join(rootBase, "default-root")
  const currentRoot = opts.currentRoot ?? join(rootBase, "current-root")
  mkdirSync(defaultRoot, { recursive: true })
  mkdirSync(currentRoot, { recursive: true })

  const storageImpl: StorageImpl = {
    status: () =>
      Effect.succeed({
        available: true,
        data_root: currentRoot,
        default_root: defaultRoot,
        using_default: currentRoot === defaultRoot,
        last_error: null,
      }),
    mediaRoot: () => Effect.succeed(currentRoot),
    mediaRootOrNull: () => Effect.succeed(currentRoot),
    saveRoot: () =>
      Effect.succeed({
        available: true,
        data_root: currentRoot,
        default_root: defaultRoot,
        using_default: currentRoot === defaultRoot,
        last_error: null,
      }),
  }

  const tasksImpl: DownloadTasksImpl = {
    list: () => Effect.succeed(opts.tasks ?? []),
    get: () => Effect.succeed(null),
    upsert: () => Effect.void,
    dismiss: () => Effect.void,
  }

  const libraryImpl: LibraryImpl = {
    list: () => Effect.succeed([...(opts.libraryRows ?? [])]),
    get: () => Effect.succeed(makeLibraryRow("unused")),
    insert: () => Effect.void,
    update: () => Effect.void,
    remove: () => Effect.void,
    playablePath: (row) => Effect.succeed(row.source_path),
  }

  const dbImpl: DbImpl = {
    query: () => Effect.succeed([]),
    queryOne: <T>() => Effect.succeed({ n: opts.activeTranscodes ?? 0 } as T),
    exec: () => Effect.void,
    transaction: <A, E, R>(fn: () => Effect.Effect<A, E, R>) => fn(),
  }

  const runtime = ManagedRuntime.make(
    StorageRootSelectionLive.pipe(
      Layer.provideMerge(Layer.succeed(Config, makeConfig(defaultRoot))),
      Layer.provideMerge(Layer.succeed(Storage, storageImpl)),
      Layer.provideMerge(Layer.succeed(DownloadTasks, tasksImpl)),
      Layer.provideMerge(Layer.succeed(Library, libraryImpl)),
      Layer.provideMerge(Layer.succeed(Db, dbImpl))
    )
  )
  runtimes.push(runtime as ManagedRuntime.ManagedRuntime<unknown, never>)

  const selection = (): Promise<StorageRootSelectionImpl> =>
    runtime.runPromise(Effect.gen(function* () {
      return yield* StorageRootSelection
    }))

  return { runtime, selection, currentRoot, defaultRoot, rootBase }
}

describe("StorageRootSelection", () => {
  test("browseDirectories lists validated child directories sorted by name", async () => {
    const harness = makeHarness()
    mkdirSync(join(harness.currentRoot, "zeta"))
    mkdirSync(join(harness.currentRoot, "alpha"))
    writeFileSync(join(harness.currentRoot, "notes.txt"), "ignore")

    const listing = await harness.runtime.runPromise(
      Effect.flatMap(StorageRootSelection, (selection) =>
        selection.browseDirectories(harness.currentRoot)
      )
    )

    expect(listing.path).toBe(harness.currentRoot)
    expect(listing.entries).toEqual([
      { name: "alpha", path: join(harness.currentRoot, "alpha") },
      { name: "zeta", path: join(harness.currentRoot, "zeta") },
    ])
  })

  test("browseDirectories rejects relative and control-character paths", async () => {
    const harness = makeHarness()
    const selection = await harness.selection()

    await expect(
      harness.runtime.runPromise(selection.browseDirectories("relative/path"))
    ).rejects.toThrow("Path must be absolute")
    await expect(
      harness.runtime.runPromise(selection.browseDirectories(`${harness.currentRoot}\nmalicious`))
    ).rejects.toThrow("Path must be absolute")
  })

  test("browseDirectories rejects a symlink that escapes the allowed roots", async () => {
    const harness = makeHarness()
    const outside = tempDir("pwe-storage-root-selection-outside-")
    const escaped = join(harness.rootBase, "escaped")
    symlinkSync(outside, escaped)

    const selection = await harness.selection()

    await expect(
      harness.runtime.runPromise(selection.browseDirectories(escaped))
    ).rejects.toThrow("outside the allowed roots")
  })

  test("createDirectory creates a validated child directory and rejects invalid names", async () => {
    const harness = makeHarness()
    const selection = await harness.selection()

    const created = await harness.runtime.runPromise(
      selection.createDirectory(harness.currentRoot, "  new-folder  ")
    )

    expect(created).toBe(join(harness.currentRoot, "new-folder"))
    expect(existsSync(created)).toBe(true)
    await expect(
      harness.runtime.runPromise(selection.createDirectory(harness.currentRoot, "../escape"))
    ).rejects.toThrow("Directory name is not valid")
  })

  test("validateTarget reports raw directory facts", async () => {
    const harness = makeHarness()
    const target = join(harness.rootBase, "target")
    mkdirSync(join(target, "source"), { recursive: true })
    mkdirSync(join(target, "optimized"), { recursive: true })

    const result = await harness.runtime.runPromise(
      Effect.flatMap(StorageRootSelection, (selection) => selection.validateTarget(target))
    )

    expect(result.path).toBe(target)
    expect(result.hasSource).toBe(true)
    expect(result.hasOptimized).toBe(true)
    expect(result.isEmpty).toBe(false)
    expect(result.freeBytes).toBeGreaterThan(0)
    expect(result.totalBytes).toBeGreaterThan(0)
  })

  test("planSwitch returns noop when the validated target is the current root", async () => {
    const harness = makeHarness()

    const plan = await harness.runtime.runPromise(
      Effect.flatMap(StorageRootSelection, (selection) => selection.planSwitch(harness.currentRoot))
    )

    expect(plan.action).toBe("noop")
    expect(plan.target.path).toBe(harness.currentRoot)
  })

  test("planSwitch returns save when the library is empty and the target changed", async () => {
    const harness = makeHarness()
    const target = join(harness.rootBase, "save-target")
    mkdirSync(target, { recursive: true })

    const plan = await harness.runtime.runPromise(
      Effect.flatMap(StorageRootSelection, (selection) => selection.planSwitch(target))
    )

    expect(plan.action).toBe("save")
    expect(plan.target.path).toBe(target)
  })

  test("planSwitch returns migrate when the library is non-empty and the target changed", async () => {
    const harness = makeHarness({
      libraryRows: [makeLibraryRow("abc")],
    })
    const target = join(harness.rootBase, "migrate-target")
    mkdirSync(target, { recursive: true })

    const plan = await harness.runtime.runPromise(
      Effect.flatMap(StorageRootSelection, (selection) => selection.planSwitch(target))
    )

    expect(plan.action).toBe("migrate")
    expect(plan.target.path).toBe(target)
  })

  test("planSwitch rejects active downloads before switching roots", async () => {
    const harness = makeHarness({
      tasks: [makeDownloadTask("abc", { stage: "downloading", finished_at: null })],
    })
    const target = join(harness.rootBase, "busy-download-target")
    mkdirSync(target, { recursive: true })

    await expect(
      harness.runtime.runPromise(
        Effect.flatMap(StorageRootSelection, (selection) => selection.planSwitch(target))
      )
    ).rejects.toThrow("Downloads are in progress")
  })

  test("planSwitch rejects active transcodes before switching roots", async () => {
    const harness = makeHarness({
      activeTranscodes: 1,
    })
    const target = join(harness.rootBase, "busy-transcode-target")
    mkdirSync(target, { recursive: true })

    await expect(
      harness.runtime.runPromise(
        Effect.flatMap(StorageRootSelection, (selection) => selection.planSwitch(target))
      )
    ).rejects.toThrow("A transcode job is active")
  })
})
