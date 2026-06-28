import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Database } from "bun:sqlite"
import { DbError, LibraryNotFoundError, type DownloadTask, type LibraryItem } from "@pwe/shared"
import { Config, type RuntimeConfig } from "./Config.js"
import { Db, type DbImpl } from "./Db.js"
import {
  DownloadProcessRegistry,
  type DownloadProcessRegistryImpl,
} from "./DownloadProcessRegistry.js"
import {
  DownloadTasks,
  DownloadTasksLive,
  mergeDownloadTaskRow,
  reconcileFinishedTaskState,
} from "./DownloadTasks.js"
import { decideSourcePathRepair, hasSuspectSourceMetadata } from "./Library.js"
import { Library, type LibraryImpl } from "./Library.js"
import { Logger, type LoggerImpl } from "./Logger.js"
import { Storage, type StorageImpl } from "./Storage.js"

const baseTask = (patch: Partial<DownloadTask> = {}): DownloadTask => ({
  workshop_id: "123",
  title: "Test",
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

let openDbs: Database[] = []
let runtimes: Array<ManagedRuntime.ManagedRuntime<unknown, never>> = []

const DOWNLOAD_TASKS_DDL = `
  CREATE TABLE IF NOT EXISTS download_tasks (
    workshop_id TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    preview_url TEXT NOT NULL DEFAULT '',
    content_rating TEXT,
    rating_sex  TEXT,
    adult_hint  INTEGER NOT NULL DEFAULT 0,
    stage       TEXT NOT NULL,
    message     TEXT NOT NULL DEFAULT '',
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    percent     REAL,
    bytes_done  INTEGER,
    bytes_total INTEGER
  );
`

const makeDbLayer = () => {
  const sqlite = new Database(":memory:")
  openDbs.push(sqlite)
  sqlite.exec(DOWNLOAD_TASKS_DDL)

  const tryDb = <T>(operation: string, fn: () => T): Effect.Effect<T, DbError> =>
    Effect.try({ try: fn, catch: (cause) => new DbError({ operation, cause }) })

  const impl: DbImpl = {
    query: <T>(sql: string, params: unknown[] = []) =>
      tryDb("query", () => sqlite.query(sql).all(...(params as any[])) as T[]),
    queryOne: <T>(sql: string, params: unknown[] = []) =>
      tryDb("queryOne", () => (sqlite.query(sql).get(...(params as any[])) as T) ?? null),
    exec: (sql: string, params: unknown[] = []) =>
      tryDb("exec", () => {
        sqlite.prepare(sql).run(...(params as any[]))
      }),
    transaction: <A, E, R>(fn: () => Effect.Effect<A, E, R>) =>
      fn() as Effect.Effect<A, E | DbError, R>,
  }

  return { db: sqlite, layer: Layer.succeed(Db, impl) }
}

const makeLoggerLayer = () => {
  const lines: string[] = []
  const impl: LoggerImpl = {
    info: (message) => Effect.sync(() => void lines.push(`INFO ${message}`)),
    warn: (message) => Effect.sync(() => void lines.push(`WARN ${message}`)),
    error: (message) => Effect.sync(() => void lines.push(`ERROR ${message}`)),
    debug: () => Effect.void,
  }
  return { layer: Layer.succeed(Logger, impl), lines }
}

const makeConfigLayer = () => {
  const impl: RuntimeConfig = {
    steam: { username: "u", web_api_key: "k", steamcmd_path: "/usr/local/bin/steamcmd" },
    paths: { data_root: "/tmp", source_dir: "source", optimized_dir: "optimized" },
    storage: { root: null },
    screen: { width: 1920, height: 1080, default_display_mode: "fill" },
    mpv: { binary_path: "mpv", ipc_socket: "/tmp/x.sock", hwdec: "auto", gpu_api: "opengl" },
    transcode: { target_codec: "hevc", target_quality: 23, heartbeat_timeout_ms: 60_000 },
    server: { host: "0.0.0.0", port: 8080 },
  }
  return Layer.succeed(Config, impl)
}

const makeStorageLayer = () => {
  const impl: StorageImpl = {
    status: () =>
      Effect.succeed({
        available: false,
        data_root: "/tmp",
        default_root: "/tmp",
        using_default: true,
        last_error: "Directory is unavailable.",
      }),
    mediaRoot: () => Effect.succeed("/tmp"),
    mediaRootOrNull: () => Effect.succeed(null),
    saveRoot: () =>
      Effect.succeed({
        available: true,
        data_root: "/tmp",
        default_root: "/tmp",
        using_default: true,
        last_error: null,
      }),
  }
  return Layer.succeed(Storage, impl)
}

const makeLibraryLayer = () => {
  const impl: LibraryImpl = {
    list: () => Effect.succeed([]),
    get: (workshopId) => Effect.fail(new LibraryNotFoundError({ workshopId })),
    insert: () => Effect.void,
    update: () => Effect.void,
    remove: () => Effect.void,
    playablePath: (row: LibraryItem) => Effect.succeed(row.source_path),
  }
  return Layer.succeed(Library, impl)
}

const makeProcessRegistryLayer = () => {
  const stops: string[] = []
  const impl: DownloadProcessRegistryImpl = {
    register: () => Effect.void,
    unregister: () => Effect.void,
    stop: (workshopId) =>
      Effect.sync(() => {
        stops.push(workshopId)
        return {
          _tag: "NotFound",
          workshopId,
        } as const
      }),
    sweep: () => Effect.void,
  }
  return { layer: Layer.succeed(DownloadProcessRegistry, impl), stops }
}

afterEach(async () => {
  for (const runtime of runtimes) await runtime.dispose()
  runtimes = []
  for (const db of openDbs) db.close()
  openDbs = []
})

describe("mergeDownloadTaskRow", () => {
  test("ignores late progress updates after terminal error", () => {
    const task = baseTask({
      stage: "error",
      message: "Download did not finalize",
      finished_at: 10,
    })

    const merged = mergeDownloadTaskRow(task, {
      stage: "downloading",
      message: "Connecting…",
      percent: 12,
    })

    expect(merged).toEqual(task)
  })

  test("ignores late finalizing updates after terminal success", () => {
    const task = baseTask({
      stage: "complete",
      message: "Library updated",
      finished_at: 10,
    })

    const merged = mergeDownloadTaskRow(task, {
      stage: "finalizing",
      message: "Validating files…",
    })

    expect(merged).toEqual(task)
  })

  test("allows a fresh retry to reset finished_at", () => {
    const task = baseTask({
      stage: "error",
      message: "Download did not finalize",
      finished_at: 10,
    })

    const merged = mergeDownloadTaskRow(task, {
      stage: "starting",
      message: "Queued",
      started_at: 20,
      finished_at: null,
    })

    expect(merged.stage).toBe("starting")
    expect(merged.message).toBe("Queued")
    expect(merged.started_at).toBe(20)
    expect(merged.finished_at).toBeNull()
  })
})

describe("DownloadTasksLive startup reconcile", () => {
  test("marks unfinished tasks interrupted even after registry sweep removed process evidence", async () => {
    const db = makeDbLayer()
    const logger = makeLoggerLayer()
    const registry = makeProcessRegistryLayer()
    db.db
      .prepare(
        `INSERT INTO download_tasks (
          workshop_id, title, preview_url, adult_hint, stage, message, started_at, finished_at
        ) VALUES (?, ?, '', 0, ?, ?, ?, NULL)`
      )
      .run("123", "Task 123", "downloading", "Connecting...", 10)

    const runtime = ManagedRuntime.make(
      DownloadTasksLive.pipe(
        Layer.provideMerge(db.layer),
        Layer.provideMerge(logger.layer),
        Layer.provideMerge(makeLibraryLayer()),
        Layer.provideMerge(makeConfigLayer()),
        Layer.provideMerge(makeStorageLayer()),
        Layer.provideMerge(registry.layer)
      )
    )
    runtimes.push(runtime as ManagedRuntime.ManagedRuntime<unknown, never>)

    const task = await runtime.runPromise(
      Effect.gen(function* () {
        const tasks = yield* DownloadTasks
        return yield* tasks.get("123")
      })
    )

    expect(task?.stage).toBe("error")
    expect(task?.message).toBe("Interrupted by restart")
    expect(task?.finished_at).not.toBeNull()
    expect(registry.stops).toEqual(["123"])
    expect(logger.lines).toContain("INFO Reconciled 1 interrupted download task(s)")
    expect(logger.lines).toContain(
      "WARN Skipping orphan source cleanup because mounted storage is disconnected"
    )
  })
})

describe("reconcile helpers", () => {
  test("marks inconsistent finished task complete when library row exists", () => {
    expect(reconcileFinishedTaskState(true)).toEqual({
      stage: "complete",
      message: "Library updated",
    })
  })

  test("marks inconsistent finished task error when library row is missing", () => {
    expect(reconcileFinishedTaskState(false)).toEqual({
      stage: "error",
      message: "Download did not finalize",
    })
  })

  test("flags placeholder library metadata as suspect", () => {
    expect(hasSuspectSourceMetadata("unknown", "0x0")).toBe(true)
    expect(hasSuspectSourceMetadata("h264", "0x0")).toBe(true)
    expect(hasSuspectSourceMetadata("unknown", "1920x1080")).toBe(true)
    expect(hasSuspectSourceMetadata("h264", "1920x1080")).toBe(false)
  })
})

describe("decideSourcePathRepair", () => {
  const DOWNLOADS = "source/42/steamapps/workshop/downloads/431960/42/video.mp4"
  const CONTENT = "source/42/steamapps/workshop/content/431960/42/video.mp4"

  test("leaves row untouched when current path exists", () => {
    expect(decideSourcePathRepair(CONTENT, (rel) => rel === CONTENT)).toBeNull()
  })

  test("repairs downloads/ → content/ when content/ exists", () => {
    expect(decideSourcePathRepair(DOWNLOADS, (rel) => rel === CONTENT)).toBe(CONTENT)
  })

  test("repairs content/ → downloads/ when downloads/ exists", () => {
    expect(decideSourcePathRepair(CONTENT, (rel) => rel === DOWNLOADS)).toBe(DOWNLOADS)
  })

  test("leaves row untouched when neither side exists", () => {
    expect(decideSourcePathRepair(DOWNLOADS, () => false)).toBeNull()
  })

  test("leaves row untouched when path has no swap pair", () => {
    expect(decideSourcePathRepair("source/42/other/video.mp4", () => true)).toBeNull()
  })
})
