import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import {
  DbError,
  FfprobeError,
  LibraryNotFoundError,
  SteamCmdError,
  StorageError,
  WorkshopApiError,
  type DownloadTask,
  type LibraryItem,
  type VideoProbe,
  type WorkshopItem,
} from "@pwe/shared"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Config, type RuntimeConfig } from "./Config.js"
import { Db, type DbImpl } from "./Db.js"
import {
  DownloadIntake,
  makeDownloadIntakeLive,
  type DownloadIntakeImpl,
} from "./DownloadIntake.js"
import { DownloadTasks, type DownloadTasksImpl } from "./DownloadTasks.js"
import { Library, type LibraryImpl } from "./Library.js"
import { Logger, type LoggerImpl } from "./Logger.js"
import { Migrate, type MigrateImpl } from "./Migrate.js"
import { Storage, type StorageImpl } from "./Storage.js"
import { SteamCmd, type DownloadResult, type SteamCmdImpl } from "./SteamCmd.js"
import { SteamWorkshop, type SteamWorkshopImpl } from "./SteamWorkshop.js"
import { TranscodeQueue, type TranscodeQueueImpl } from "./TranscodeQueue.js"
import type { TranscodeDecision } from "../transcode/decide.js"

const WE_APPID = "431960"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async <T>(probe: () => T | null | undefined | false): Promise<T> => {
  const deadline = Date.now() + 1_500
  while (Date.now() < deadline) {
    const value = probe()
    if (value) return value
    await sleep(10)
  }
  throw new Error("Timed out waiting for condition")
}

const baseTask = (workshopId: string, patch: Partial<DownloadTask> = {}): DownloadTask => ({
  workshop_id: workshopId,
  title: workshopId,
  preview_url: "",
  content_rating: null,
  rating_sex: null,
  adult_hint: 0,
  stage: "starting",
  message: "",
  started_at: Date.now(),
  finished_at: null,
  percent: null,
  bytes_done: null,
  bytes_total: null,
  ...patch,
})

const makeConfig = (mediaRoot: string): RuntimeConfig => ({
  steam: { username: "u", web_api_key: "k", steamcmd_path: "/usr/local/bin/steamcmd" },
  paths: { data_root: mediaRoot, source_dir: "source", optimized_dir: "optimized" },
  storage: { root: null },
  screen: { width: 1920, height: 1080, default_display_mode: "fill" },
  mpv: { binary_path: "mpv", ipc_socket: "/tmp/x.sock", hwdec: "auto", gpu_api: "opengl" },
  transcode: { target_codec: "hevc", target_quality: 23, heartbeat_timeout_ms: 60_000 },
  server: { host: "0.0.0.0", port: 8080 },
})

const makeVideoProbe = (patch: Partial<VideoProbe> = {}): VideoProbe => ({
  width: 1920,
  height: 1080,
  codec: "h264",
  duration_seconds: 12,
  size_bytes: 1_234,
  ...patch,
})

const makeWorkshopItem = (workshopId: string, patch: Partial<WorkshopItem> = {}): WorkshopItem => ({
  publishedfileid: workshopId,
  title: "Metadata Title",
  preview_url: "https://example.test/preview.jpg",
  creator: "Author",
  ...patch,
})

const createWallpaper = (
  mediaRoot: string,
  workshopId: string,
  opts: { type?: string; file?: string } = {}
) => {
  const file = opts.file ?? "wallpaper.mp4"
  const itemDir = join(
    mediaRoot,
    "source",
    workshopId,
    "steamapps",
    "workshop",
    "content",
    WE_APPID,
    workshopId
  )
  mkdirSync(itemDir, { recursive: true })
  writeFileSync(
    join(itemDir, "project.json"),
    JSON.stringify({ type: opts.type ?? "video", file, title: "Project Title" })
  )
  writeFileSync(join(itemDir, file), "video-bytes")
  return itemDir
}

const makeTasks = () => {
  const rows = new Map<string, DownloadTask>()
  const patches: Array<{ workshopId: string; patch: Partial<Omit<DownloadTask, "workshop_id">> }> =
    []

  const impl: DownloadTasksImpl = {
    list: () => Effect.sync(() => [...rows.values()]),
    get: (workshopId) => Effect.sync(() => rows.get(workshopId) ?? null),
    upsert: (workshopId, patch) =>
      Effect.sync(() => {
        patches.push({ workshopId, patch })
        const current = rows.get(workshopId) ?? baseTask(workshopId)
        rows.set(workshopId, { ...current, ...patch })
      }),
    dismiss: (workshopId) =>
      Effect.sync(() => {
        rows.delete(workshopId)
      }),
  }

  return { impl, rows, patches }
}

const makeLibrary = () => {
  const rows = new Map<string, LibraryItem>()
  const impl: LibraryImpl = {
    list: () => Effect.sync(() => [...rows.values()]),
    get: (workshopId) =>
      Effect.gen(function* () {
        const row = rows.get(workshopId)
        if (!row) return yield* Effect.fail(new LibraryNotFoundError({ workshopId }))
        return row
      }),
    insert: (row) =>
      Effect.sync(() => {
        rows.set(row.workshop_id, row)
      }),
    update: (workshopId, patch) =>
      Effect.sync(() => {
        const current = rows.get(workshopId)
        if (current) rows.set(workshopId, { ...current, ...patch } as LibraryItem)
      }),
    remove: () => Effect.void,
    playablePath: (row) => Effect.succeed(row.source_path),
  }

  return { impl, rows }
}

const makeTranscodeQueue = () => {
  const enqueues: Array<{
    workshopId: string
    decision: TranscodeDecision
    sourceRel: string
  }> = []
  const impl: TranscodeQueueImpl = {
    enqueue: (workshopId, decision, sourceRel) =>
      Effect.sync(() => {
        enqueues.push({ workshopId, decision, sourceRel })
      }),
    claim: () => Effect.succeed(null),
    heartbeat: () => Effect.succeed(false),
    progress: () => Effect.void,
    uploading: () => Effect.succeed(false),
    complete: () => Effect.void,
    fail: () => Effect.void,
  }
  return { impl, enqueues }
}

const makeDb = (): DbImpl => ({
  query: () => Effect.succeed([]),
  queryOne: () => Effect.succeed(null),
  exec: () => Effect.void,
  transaction: <A, E, R>(fn: () => Effect.Effect<A, E, R>) =>
    fn() as Effect.Effect<A, E | DbError, R>,
})

const makeLogger = (): LoggerImpl => ({
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
  debug: () => Effect.void,
})

let runtimes: Array<ManagedRuntime.ManagedRuntime<unknown, never>> = []
let tempDirs: string[] = []

afterEach(async () => {
  for (const runtime of runtimes) await runtime.dispose()
  runtimes = []
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

const makeHarness = (
  opts: {
    download?: SteamCmdImpl["download"]
    probeVideo?: (filePath: string) => Effect.Effect<VideoProbe, FfprobeError>
    migrationRunning?: boolean
    storageAvailable?: boolean
    workshopItem?: WorkshopItem
    workshopGetItem?: SteamWorkshopImpl["getItem"]
  } = {}
) => {
  const mediaRoot = mkdtempSync(join(tmpdir(), "pwe-intake-"))
  tempDirs.push(mediaRoot)

  const tasks = makeTasks()
  const library = makeLibrary()
  const transcode = makeTranscodeQueue()

  const storageImpl: StorageImpl = {
    status: () =>
      Effect.succeed({
        available: opts.storageAvailable ?? true,
        data_root: mediaRoot,
        default_root: mediaRoot,
        using_default: true,
        last_error: null,
      }),
    mediaRoot: () =>
      opts.storageAvailable === false
        ? Effect.fail(
            new StorageError({
              kind: "Disconnected",
              message: "Current media root is unavailable.",
            })
          )
        : Effect.succeed(mediaRoot),
    mediaRootOrNull: () =>
      Effect.succeed(opts.storageAvailable === false ? null : mediaRoot),
    saveRoot: () =>
      Effect.succeed({
        available: true,
        data_root: mediaRoot,
        default_root: mediaRoot,
        using_default: true,
        last_error: null,
      }),
  }

  const migrateImpl: MigrateImpl = {
    start: () =>
      Effect.succeed({ state: "running", moved_bytes: 0, total_bytes: 0, error: null }),
    status: () => Effect.succeed(null),
    cancel: () => Effect.succeed(null),
    isRunning: () => Effect.succeed(Boolean(opts.migrationRunning)),
  }

  const steamImpl: SteamCmdImpl = {
    download:
      opts.download ??
      ((workshopId) =>
        Effect.sync(() => ({
          workshopId,
          localPath: createWallpaper(mediaRoot, workshopId),
          sizeBytes: 1_234,
        }))),
    progressStream: () => Stream.empty,
  }

  const workshopImpl: SteamWorkshopImpl = {
    search: () => Effect.succeed({ total: 0, items: [] }),
    getItem:
      opts.workshopGetItem ??
      ((workshopId) => Effect.succeed(opts.workshopItem ?? makeWorkshopItem(workshopId))),
  }

  const layer = makeDownloadIntakeLive({
    probeVideo: opts.probeVideo ?? (() => Effect.succeed(makeVideoProbe())),
  }).pipe(
    Layer.provideMerge(Layer.succeed(Config, makeConfig(mediaRoot))),
    Layer.provideMerge(Layer.succeed(Db, makeDb())),
    Layer.provideMerge(Layer.succeed(SteamWorkshop, workshopImpl)),
    Layer.provideMerge(Layer.succeed(SteamCmd, steamImpl)),
    Layer.provideMerge(Layer.succeed(Library, library.impl)),
    Layer.provideMerge(Layer.succeed(TranscodeQueue, transcode.impl)),
    Layer.provideMerge(Layer.succeed(Logger, makeLogger())),
    Layer.provideMerge(Layer.succeed(DownloadTasks, tasks.impl)),
    Layer.provideMerge(Layer.succeed(Storage, storageImpl)),
    Layer.provideMerge(Layer.succeed(Migrate, migrateImpl))
  )

  const runtime = ManagedRuntime.make(layer)
  runtimes.push(runtime as ManagedRuntime.ManagedRuntime<unknown, never>)

  const intake = (): Promise<DownloadIntakeImpl> =>
    runtime.runPromise(
      Effect.gen(function* () {
        return yield* DownloadIntake
      })
    )

  return { runtime, intake, mediaRoot, tasks, library, transcode }
}

const start = async (harness: ReturnType<typeof makeHarness>, workshopId: string) =>
  (await harness.intake()).start(workshopId).pipe((effect) => harness.runtime.runPromise(effect))

describe("DownloadIntake.start", () => {
  test("starts asynchronously and finalizes a video wallpaper into the library", async () => {
    const harness = makeHarness()

    const result = await start(harness, "abc")

    expect(result).toEqual({ _tag: "Started", workshopId: "abc" })
    const task = await waitFor(() => {
      const row = harness.tasks.rows.get("abc")
      return row?.stage === "complete" ? row : null
    })

    expect(task.message).toBe("Library updated")
    const row = harness.library.rows.get("abc")
    expect(row?.title).toBe("Metadata Title")
    expect(row?.author).toBe("Author")
    expect(row?.source_path).toBe(
      "source/abc/steamapps/workshop/content/431960/abc/wallpaper.mp4"
    )
    expect(row?.source_resolution).toBe("1920x1080")
    expect(harness.transcode.enqueues).toHaveLength(1)
    expect(harness.transcode.enqueues[0]?.sourceRel).toBe(row?.source_path)
  })

  test("returns already-running for a duplicate live intake", async () => {
    let starts = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const harness = makeHarness({
      download: (workshopId) =>
        Effect.promise(async () => {
          starts += 1
          await gate
          return {
            workshopId,
            localPath: createWallpaper(harness.mediaRoot, workshopId),
            sizeBytes: 1_234,
          } satisfies DownloadResult
        }),
    })

    const first = await start(harness, "dup")
    const second = await start(harness, "dup")
    release()

    expect(first).toEqual({ _tag: "Started", workshopId: "dup" })
    expect(second).toEqual({ _tag: "AlreadyRunning", workshopId: "dup", stage: "starting" })
    expect(starts).toBe(1)
    await waitFor(() => harness.tasks.rows.get("dup")?.stage === "complete")
  })

  test("blocks new downloads while storage migration is running", async () => {
    let starts = 0
    const harness = makeHarness({
      migrationRunning: true,
      download: (workshopId) =>
        Effect.sync(() => {
          starts += 1
          return { workshopId, localPath: "", sizeBytes: 0 }
        }),
    })

    const result = await start(harness, "blocked")

    expect(result._tag).toBe("MigrationRunning")
    expect(starts).toBe(0)
  })

  test("blocks new downloads when the media root is unavailable", async () => {
    const harness = makeHarness({ storageAvailable: false })

    const result = await start(harness, "offline")

    expect(result).toEqual({
      _tag: "StorageUnavailable",
      workshopId: "offline",
      message: "Current media root is unavailable.",
    })
  })

  test("turns a non-video wallpaper into a terminal task and cleans source leftovers", async () => {
    const harness = makeHarness({
      download: (workshopId) =>
        Effect.sync(() => ({
          workshopId,
          localPath: createWallpaper(harness.mediaRoot, workshopId, { type: "scene" }),
          sizeBytes: 100,
        })),
    })

    const result = await start(harness, "scene")

    expect(result).toEqual({ _tag: "Started", workshopId: "scene" })
    const task = await waitFor(() => {
      const row = harness.tasks.rows.get("scene")
      return row?.stage === "error" ? row : null
    })

    expect(task.message).toContain('type "scene"')
    expect(harness.library.rows.has("scene")).toBe(false)
    expect(existsSync(join(harness.mediaRoot, "source", "scene"))).toBe(false)
  })

  test("turns unreadable media into a terminal task and cleans source leftovers", async () => {
    const harness = makeHarness({
      probeVideo: (filePath) =>
        Effect.fail(new FfprobeError({ path: filePath, reason: "No video stream found" })),
    })

    const result = await start(harness, "bad-media")

    expect(result).toEqual({ _tag: "Started", workshopId: "bad-media" })
    const task = await waitFor(() => {
      const row = harness.tasks.rows.get("bad-media")
      return row?.stage === "error" ? row : null
    })

    expect(task.message).toContain("Downloaded files are incomplete or unreadable")
    expect(harness.library.rows.has("bad-media")).toBe(false)
    expect(existsSync(join(harness.mediaRoot, "source", "bad-media"))).toBe(false)
  })

  test("uses metadata fallback when the Workshop API lookup fails", async () => {
    const harness = makeHarness({
      workshopGetItem: () => Effect.fail(new WorkshopApiError({ status: 500, message: "down" })),
    })

    const result = await start(harness, "fallback")

    expect(result).toEqual({ _tag: "Started", workshopId: "fallback" })
    await waitFor(() => harness.tasks.rows.get("fallback")?.stage === "complete")
    expect(harness.library.rows.get("fallback")?.title).toBe("fallback")
  })
})
