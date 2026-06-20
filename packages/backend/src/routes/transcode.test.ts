import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Database } from "bun:sqlite"
import { Elysia } from "elysia"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DbError, type LibraryItem } from "@pwe/shared"
import { Config, type RuntimeConfig } from "../services/Config.js"
import { Db, type DbImpl } from "../services/Db.js"
import { Library, type LibraryImpl } from "../services/Library.js"
import { Logger, type LoggerImpl } from "../services/Logger.js"
import { Migrate, type MigrateImpl } from "../services/Migrate.js"
import { Storage, type StorageImpl } from "../services/Storage.js"
import { TranscodeQueue, TranscodeQueueLive } from "../services/TranscodeQueue.js"
import { transcodeRoutes } from "./transcode.js"

const ENV = "PWE_WORKER_API_KEY"
const originalEnv = process.env[ENV]
const TEST_KEY = "test-secret-key-1234"

beforeAll(() => {
  process.env[ENV] = TEST_KEY
})

afterAll(() => {
  if (originalEnv === undefined) delete process.env[ENV]
  else process.env[ENV] = originalEnv
})

const DDL = `
  CREATE TABLE IF NOT EXISTS transcode_jobs (
    id              TEXT PRIMARY KEY,
    workshop_id     TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    worker          TEXT,
    claimed_at      INTEGER,
    last_heartbeat  INTEGER,
    progress        INTEGER NOT NULL DEFAULT 0,
    error           TEXT,
    created_at      INTEGER NOT NULL,
    completed_at    INTEGER
  );
`

let openDbs: Database[] = []
let tempDirs: string[] = []

const baseLibraryRow: LibraryItem = {
  workshop_id: "abc",
  title: "Test",
  author: "",
  preview_url: "",
  content_rating: null,
  rating_sex: null,
  source_path: "source/abc/wallpaper.mp4",
  source_resolution: "3840x2160",
  source_codec: "h264",
  source_size: 5_000_000,
  downloaded_at: 1_700_000_000_000,
  transcode_status: "pending",
  transcode_progress: 0,
  transcode_error: null,
  transcoded_path: null,
  transcoded_resolution: null,
  transcoded_codec: null,
  transcoded_size: null,
  display_mode: "fill",
  last_played_at: null,
}

const makeStack = (opts: { migrationRunning?: boolean } = {}) => {
  const sqlite = new Database(":memory:")
  openDbs.push(sqlite)
  sqlite.exec(DDL)
  const mediaRoot = mkdtempSync(join(tmpdir(), "pwe-transcode-routes-"))
  tempDirs.push(mediaRoot)
  const sourceAbs = join(mediaRoot, "source/abc/wallpaper.mp4")
  mkdirSync(dirname(sourceAbs), { recursive: true })
  writeFileSync(sourceAbs, "source-bytes")

  const tryDb =
    <T>(operation: string, fn: () => T): Effect.Effect<T, DbError> =>
      Effect.try({ try: fn, catch: (cause) => new DbError({ operation, cause }) })

  const dbImpl: DbImpl = {
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

  let row: LibraryItem = { ...baseLibraryRow }
  const libImpl: LibraryImpl = {
    list: () => Effect.succeed([row]),
    get: () => Effect.succeed(row),
    insert: () => Effect.void,
    update: (_id, patch) =>
      Effect.sync(() => {
        row = { ...row, ...patch } as LibraryItem
      }),
    remove: () => Effect.void,
    playablePath: () => Effect.succeed(row.transcoded_path ?? row.source_path),
  }

  const logImpl: LoggerImpl = {
    info: () => Effect.void,
    warn: () => Effect.void,
    error: () => Effect.void,
    debug: () => Effect.void,
  }

  const configImpl: RuntimeConfig = {
    steam: { username: "u", web_api_key: "k", steamcmd_path: "/x" },
    paths: { data_root: mediaRoot, source_dir: "source", optimized_dir: "optimized" },
    storage: { root: null },
    screen: { width: 1200, height: 1080, default_display_mode: "fill" },
    mpv: { binary_path: "mpv", ipc_socket: "/tmp/x.sock", hwdec: "auto", gpu_api: "opengl" },
    transcode: { target_codec: "hevc", target_quality: 23, heartbeat_timeout_ms: 60_000 },
    server: { host: "0.0.0.0", port: 8080 },
  }

  const storageImpl: StorageImpl = {
    status: () =>
      Effect.succeed({
        available: true,
        data_root: mediaRoot,
        default_root: mediaRoot,
        using_default: true,
        last_error: null,
      }),
    mediaRoot: () => Effect.succeed(mediaRoot),
    mediaRootOrNull: () => Effect.succeed(mediaRoot),
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

  // The route handler also yields shared services directly. `provideMerge`
  // keeps them visible in the runtime's context
  // instead of being fully consumed by TranscodeQueueLive.
  const layer = TranscodeQueueLive.pipe(
    Layer.provideMerge(Layer.succeed(Library, libImpl)),
    Layer.provideMerge(Layer.succeed(Logger, logImpl)),
    Layer.provideMerge(Layer.succeed(Storage, storageImpl)),
    Layer.provideMerge(Layer.succeed(Migrate, migrateImpl)),
    Layer.provideMerge(Layer.succeed(Db, dbImpl)),
    Layer.provideMerge(Layer.succeed(Config, configImpl))
  )

  const runtime = ManagedRuntime.make(layer)
  return { runtime, sqlite, mediaRoot, libRow: () => row }
}

afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs = []
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

describe("transcode routes — full lifecycle", () => {
  let stack: ReturnType<typeof makeStack>
  let app: ReturnType<typeof buildApp>

  const buildApp = () => new Elysia().use(transcodeRoutes(stack.runtime as never))

  beforeEach(() => {
    stack = makeStack()
    app = buildApp()
  })

  const headers = () => ({
    "content-type": "application/json",
    "x-worker-key": TEST_KEY,
  })

  test("/claim returns 204 when no pending jobs", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/transcode/claim", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ worker: "nas-01" }),
      })
    )
    expect(res.status).toBe(204)
  })

  test("/claim returns job when a pending row exists", async () => {
    stack.sqlite
      .prepare(
        `INSERT INTO transcode_jobs (id, workshop_id, status, progress, created_at)
         VALUES ('J1', 'abc', 'pending', 0, ?)`
      )
      .run(Date.now())

    const res = await app.handle(
      new Request("http://localhost/api/transcode/claim", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ worker: "nas-01" }),
      })
    )
    expect(res.status).toBe(200)
    const job = (await res.json()) as {
      id: string
      workshop_id: string
      source_url: string
      artifact_url: string
    }
    expect(job.id).toBe("J1")
    expect(job.workshop_id).toBe("abc")
    expect(job.source_url).toBe("/api/transcode/J1/source")
    expect(job.artifact_url).toBe("/api/transcode/J1/artifact")
  })

  test("/claim returns 204 while storage migration is running", async () => {
    stack = makeStack({ migrationRunning: true })
    app = buildApp()
    stack.sqlite
      .prepare(
        `INSERT INTO transcode_jobs (id, workshop_id, status, progress, created_at)
         VALUES ('J1', 'abc', 'pending', 0, ?)`
      )
      .run(Date.now())

    const res = await app.handle(
      new Request("http://localhost/api/transcode/claim", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ worker: "nas-01" }),
      })
    )
    expect(res.status).toBe(204)
  })

  test("full happy-path cycle: claim → source → heartbeat → progress → artifact", async () => {
    stack.sqlite
      .prepare(
        `INSERT INTO transcode_jobs (id, workshop_id, status, progress, created_at)
         VALUES ('J1', 'abc', 'pending', 0, ?)`
      )
      .run(Date.now())

    // 1. claim
    let res = await app.handle(
      new Request("http://localhost/api/transcode/claim", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ worker: "nas-01" }),
      })
    )
    expect(res.status).toBe(200)

    // 2. source
    res = await app.handle(
      new Request("http://localhost/api/transcode/J1/source", {
        method: "GET",
        headers: { "x-worker-key": TEST_KEY },
      })
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("source-bytes")

    // 3. heartbeat
    res = await app.handle(
      new Request("http://localhost/api/transcode/J1/heartbeat", {
        method: "POST",
        headers: headers(),
        body: "{}",
      })
    )
    expect(res.status).toBe(200)

    // 4. progress
    res = await app.handle(
      new Request("http://localhost/api/transcode/J1/progress", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ progress: 42 }),
      })
    )
    expect(res.status).toBe(200)
    const progRow = stack.sqlite
      .query("SELECT progress FROM transcode_jobs WHERE id = 'J1'")
      .get() as { progress: number }
    expect(progRow.progress).toBe(42)

    // 5. artifact upload completes the job and Pi owns final placement
    res = await app.handle(
      new Request("http://localhost/api/transcode/J1/artifact", {
        method: "PUT",
        headers: {
          "x-worker-key": TEST_KEY,
          "x-transcode-duration-ms": "5000",
        },
        body: "artifact-bytes",
      })
    )
    expect(res.status).toBe(200)

    const finalRow = stack.sqlite
      .query("SELECT status, progress FROM transcode_jobs WHERE id = 'J1'")
      .get() as { status: string; progress: number }
    expect(finalRow.status).toBe("completed")
    expect(finalRow.progress).toBe(100)

    expect(stack.libRow().transcoded_path).toBe("optimized/abc.mp4")
    expect(stack.libRow().transcode_status).toBe("completed")
    expect(stack.libRow().transcoded_size).toBe("artifact-bytes".length)
    const output = join(stack.mediaRoot, "optimized/abc.mp4")
    expect(readFileSync(output, "utf-8")).toBe("artifact-bytes")
    expect(existsSync(`${output}.partial.J1`)).toBe(false)
  })

  test("/heartbeat returns 404 for unknown job", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/transcode/nope/heartbeat", {
        method: "POST",
        headers: headers(),
        body: "{}",
      })
    )
    expect(res.status).toBe(404)
  })

  test("/fail marks job and library failed", async () => {
    stack.sqlite
      .prepare(
        `INSERT INTO transcode_jobs (id, workshop_id, status, progress, created_at)
         VALUES ('J1', 'abc', 'running', 30, ?)`
      )
      .run(Date.now())

    const res = await app.handle(
      new Request("http://localhost/api/transcode/J1/fail", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ error: "ffmpeg exited 1" }),
      })
    )
    expect(res.status).toBe(200)

    const row = stack.sqlite
      .query("SELECT status, error FROM transcode_jobs WHERE id = 'J1'")
      .get() as { status: string; error: string }
    expect(row.status).toBe("failed")
    expect(row.error).toBe("ffmpeg exited 1")
    expect(stack.libRow().transcode_error).toBe("ffmpeg exited 1")
  })

  test("missing X-Worker-Key returns 401", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/transcode/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ worker: "nas-01" }),
      })
    )
    expect(res.status).toBe(401)
  })
})
