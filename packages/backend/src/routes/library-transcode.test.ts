import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { Database } from "bun:sqlite"
import { Elysia } from "elysia"
import { DbError, LibraryNotFoundError, type LibraryItem } from "@pwe/shared"
import { Config, type RuntimeConfig } from "../services/Config.js"
import { Db, type DbImpl } from "../services/Db.js"
import { Library, type LibraryImpl } from "../services/Library.js"
import { Logger, type LoggerImpl } from "../services/Logger.js"
import { TranscodeQueueLive } from "../services/TranscodeQueue.js"
import { TasksLive } from "../services/Tasks.js"
import { Mpv, type MpvImpl } from "../services/Mpv.js"
import { Storage, type StorageImpl } from "../services/Storage.js"
import { libraryRoutes } from "./library.js"

// The manual-retrigger routes gate on the same env switch as the worker
// routes: no key → 503, so the UI can say why nothing will happen.
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
let runtimes: Array<{ dispose: () => Promise<void> }> = []
const ACTIVE_MEDIA_ROOT = "/tmp/pwe-selected-root"

const makeRow = (overrides: Partial<LibraryItem>): LibraryItem => ({
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
  transcode_status: "failed",
  transcode_progress: 0,
  transcode_error: "ffmpeg exited 1",
  transcoded_path: null,
  transcoded_resolution: null,
  transcoded_codec: null,
  transcoded_size: null,
  display_mode: "fill",
  last_played_at: null,
  ...overrides,
})

const makeStack = (
  rowList: LibraryItem[],
  options: {
    readonly failPendingUpdate?: boolean
    readonly playerPath?: string
    readonly playing?: boolean
  } = {}
) => {
  const sqlite = new Database(":memory:")
  openDbs.push(sqlite)
  sqlite.exec(DDL)

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
      Effect.gen(function* () {
        yield* tryDb("begin", () => sqlite.exec("BEGIN"))
        const result = yield* fn().pipe(
          Effect.tapError(() => tryDb("rollback", () => sqlite.exec("ROLLBACK")))
        )
        yield* tryDb("commit", () => sqlite.exec("COMMIT"))
        return result
      }) as Effect.Effect<A, E | DbError, R>,
  }

  const rows = new Map(rowList.map((r) => [r.workshop_id, r]))
  const libImpl: LibraryImpl = {
    list: () => Effect.succeed([...rows.values()]),
    get: (id) => {
      const row = rows.get(id)
      return row
        ? Effect.succeed(row)
        : Effect.fail(new LibraryNotFoundError({ workshopId: id }))
    },
    insert: () => Effect.void,
    update: (id, patch) =>
      options.failPendingUpdate && patch.transcode_status === "pending"
        ? Effect.fail(new DbError({ operation: "library.update", cause: "injected" }))
        : Effect.sync(() => {
            const row = rows.get(id)
            if (row) rows.set(id, { ...row, ...patch } as LibraryItem)
          }),
    remove: () => Effect.void,
    playablePath: (row) => Effect.succeed(row.transcoded_path ?? row.source_path),
  }

  const logImpl: LoggerImpl = {
    info: () => Effect.void,
    warn: () => Effect.void,
    error: () => Effect.void,
    debug: () => Effect.void,
  }

  const configImpl: RuntimeConfig = {
    steam: { username: "u", web_api_key: "k", steamcmd_path: "/x" },
    paths: { data_root: "/tmp/pwe-test", source_dir: "source", optimized_dir: "optimized" },
    storage: { root: null },
    screen: { width: 1920, height: 1080, default_display_mode: "fill" },
    mpv: { binary_path: "mpv", ipc_socket: "/tmp/x.sock", hwdec: "auto", gpu_api: "opengl" },
    transcode: { target_codec: "hevc", target_quality: 23, heartbeat_timeout_ms: 60_000 },
    server: { host: "0.0.0.0", port: 8080 },
  }

  const mpvImpl: MpvImpl = {
    play: () => Effect.void,
    pause: () => Effect.void,
    resume: () => Effect.void,
    stop: () => Effect.void,
    setDisplayMode: () => Effect.void,
    ended: () => Stream.empty,
    status: () => Effect.succeed({
      playing: options.playing ?? false,
      current_workshop_id: options.playerPath ? "abc" : null,
      path: options.playerPath ?? null,
      display_mode: "fill",
    }),
  }
  const storageState = {
    available: true,
    data_root: ACTIVE_MEDIA_ROOT,
    default_root: configImpl.paths.data_root,
    using_default: false,
    last_error: null,
  }
  const storageImpl: StorageImpl = {
    status: () => Effect.succeed(storageState),
    mediaRoot: () => Effect.succeed(ACTIVE_MEDIA_ROOT),
    mediaRootOrNull: () => Effect.succeed(ACTIVE_MEDIA_ROOT),
    saveRoot: () => Effect.succeed(storageState),
  }

  const layer = TranscodeQueueLive.pipe(
    Layer.provideMerge(TasksLive),
    Layer.provideMerge(Layer.succeed(Mpv, mpvImpl)),
    Layer.provideMerge(Layer.succeed(Storage, storageImpl)),
    Layer.provideMerge(Layer.succeed(Library, libImpl)),
    Layer.provideMerge(Layer.succeed(Logger, logImpl)),
    Layer.provideMerge(Layer.succeed(Db, dbImpl)),
    Layer.provideMerge(Layer.succeed(Config, configImpl))
  )

  const runtime = ManagedRuntime.make(layer)
  runtimes.push(runtime)
  const app = new Elysia().use(libraryRoutes(runtime as never))
  return { app, sqlite, libRow: (id: string) => rows.get(id) }
}

afterEach(async () => {
  for (const runtime of runtimes) await runtime.dispose()
  runtimes = []
  for (const db of openDbs) db.close()
  openDbs = []
})

const post = (app: { handle: (request: Request) => Promise<Response> }, path: string) =>
  app.handle(new Request(`http://localhost${path}`, { method: "POST" }))

describe("POST /api/library/:workshopId/transcode", () => {
  test("failed 4K item is re-enqueued as pending", async () => {
    const stack = makeStack([makeRow({ transcode_status: "failed" })])
    const res = await post(stack.app, "/api/library/abc/transcode")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; transcode_status: string }
    expect(body.ok).toBe(true)
    expect(body.transcode_status).toBe("pending")

    const job = stack.sqlite
      .query("SELECT workshop_id, status FROM transcode_jobs")
      .get() as { workshop_id: string; status: string }
    expect(job.workshop_id).toBe("abc")
    expect(job.status).toBe("pending")
    expect(stack.libRow("abc")?.transcode_status).toBe("pending")
    expect(stack.libRow("abc")?.transcode_error).toBeNull()
  })

  test("skipped item whose source needs no transcode stays skipped, no job row", async () => {
    const stack = makeStack([
      makeRow({
        transcode_status: "skipped",
        transcode_error: null,
        source_resolution: "1920x1080",
        source_codec: "h264",
      }),
    ])
    const res = await post(stack.app, "/api/library/abc/transcode")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { transcode_status: string; reason: string }
    expect(body.transcode_status).toBe("skipped")
    expect(body.reason.length).toBeGreaterThan(0)

    const jobs = stack.sqlite.query("SELECT id FROM transcode_jobs").all()
    expect(jobs.length).toBe(0)
    expect(stack.libRow("abc")?.transcode_status).toBe("skipped")
  })

  test("active statuses are rejected with 409", async () => {
    for (const status of ["pending", "claimed", "running", "uploading"] as const) {
      const stack = makeStack([makeRow({ transcode_status: status })])
      const res = await post(stack.app, "/api/library/abc/transcode")
      expect(res.status).toBe(409)
    }
  })

  test("completed item can be re-transcoded, keeping its artifact until the new one lands", async () => {
    // The per-item route accepts a finished item so a wrong optimized file can
    // be replaced without deleting it or hand-editing the database. The old
    // artifact must survive on disk: the worker writes to
    // `<final>.partial.<jobId>` and only renames on success, so a failed
    // re-encode leaves the previous file in place.
    const stack = makeStack([
      makeRow({
        transcode_status: "completed",
        transcoded_path: "optimized/abc.mp4",
      }),
    ])
    const res = await post(stack.app, "/api/library/abc/transcode")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; transcode_status: string }
    expect(body.ok).toBe(true)
    expect(body.transcode_status).toBe("pending")

    const job = stack.sqlite
      .query("SELECT workshop_id, status FROM transcode_jobs")
      .get() as { workshop_id: string; status: string }
    expect(job.workshop_id).toBe("abc")
    expect(job.status).toBe("pending")
    // Path is left alone, so playback keeps working off the old file.
    expect(stack.libRow("abc")?.transcoded_path).toBe("optimized/abc.mp4")
  })

  test("refuses to re-transcode an artifact open in the player, including when paused", async () => {
    for (const playing of [true, false]) {
      const stack = makeStack([
        makeRow({ transcode_status: "completed", transcoded_path: "optimized/abc.mp4" }),
      ], { playerPath: `${ACTIVE_MEDIA_ROOT}/optimized/abc.mp4`, playing })

      const response = await post(stack.app, "/api/library/abc/transcode")

      expect(response.status).toBe(409)
      expect((await response.json()).error).toMatch(/stop playback|switch.*wallpaper/i)
      expect(stack.sqlite.query("SELECT id FROM transcode_jobs").all()).toHaveLength(0)
      expect(stack.libRow("abc")?.transcode_status).toBe("completed")
      expect(stack.libRow("abc")?.transcoded_path).toBe("optimized/abc.mp4")
    }
  })

  test("allows a re-transcode while the same wallpaper's source is playing", async () => {
    const stack = makeStack([
      makeRow({ transcode_status: "completed", transcoded_path: "optimized/abc.mp4" }),
    ], { playerPath: `${ACTIVE_MEDIA_ROOT}/source/abc/wallpaper.mp4`, playing: true })

    const response = await post(stack.app, "/api/library/abc/transcode")

    expect(response.status).toBe(200)
    expect(stack.libRow("abc")?.transcode_status).toBe("pending")
  })

  test("unknown workshop id returns 404", async () => {
    const stack = makeStack([])
    const res = await post(stack.app, "/api/library/nope/transcode")
    expect(res.status).toBe(404)
  })

  test("unparseable source resolution returns 422", async () => {
    const stack = makeStack([makeRow({ source_resolution: "unknown" })])
    const res = await post(stack.app, "/api/library/abc/transcode")
    expect(res.status).toBe(422)
  })

  test("returns 503 when no worker key is configured", async () => {
    delete process.env[ENV]
    try {
      const stack = makeStack([makeRow({})])
      const res = await post(stack.app, "/api/library/abc/transcode")
      expect(res.status).toBe(503)
    } finally {
      process.env[ENV] = TEST_KEY
    }
  })

  test("concurrent retriggers enqueue at most one active job", async () => {
    const stack = makeStack([makeRow({ transcode_status: "failed" })])
    const responses = await Promise.all([
      post(stack.app, "/api/library/abc/transcode"),
      post(stack.app, "/api/library/abc/transcode"),
    ])

    expect(responses.map((res) => res.status).sort()).toEqual([200, 409])
    const jobs = stack.sqlite.query("SELECT id FROM transcode_jobs").all()
    expect(jobs).toHaveLength(1)
  })

  test("rolls back the job when the library transition fails", async () => {
    const stack = makeStack(
      [makeRow({ transcode_status: "failed" })],
      { failPendingUpdate: true }
    )

    const response = await post(stack.app, "/api/library/abc/transcode")

    expect(response.status).toBe(500)
    const jobs = stack.sqlite.query("SELECT id FROM transcode_jobs").all()
    expect(jobs).toHaveLength(0)
  })
})

describe("POST /api/library/transcode/retry-all", () => {
  test("skips an artifact open in the player and continues retrying other items", async () => {
    const stack = makeStack([
      makeRow({ transcode_status: "failed", transcoded_path: "optimized/abc.mp4" }),
      makeRow({ workshop_id: "other", transcode_status: "failed" }),
    ], { playerPath: `${ACTIVE_MEDIA_ROOT}/optimized/abc.mp4`, playing: true })

    const response = await post(stack.app, "/api/library/transcode/retry-all")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, queued: 1, skipped: 1, invalid: 0 })
    expect(stack.libRow("abc")?.transcode_status).toBe("failed")
    expect(stack.libRow("abc")?.transcoded_path).toBe("optimized/abc.mp4")
    expect(stack.libRow("other")?.transcode_status).toBe("pending")
  })

  test("sweeps only failed/skipped rows and reports counts", async () => {
    const stack = makeStack([
      makeRow({ workshop_id: "fourk", transcode_status: "failed" }), // → queued
      makeRow({
        workshop_id: "native",
        transcode_status: "skipped",
        source_resolution: "1920x1080",
        source_codec: "h264",
      }), // → decision skip
      makeRow({ workshop_id: "done", transcode_status: "completed" }), // untouched
      makeRow({ workshop_id: "busy", transcode_status: "running" }), // untouched
      makeRow({
        workshop_id: "weird",
        transcode_status: "skipped",
        source_resolution: "garbage",
      }), // → invalid
    ])

    const res = await post(stack.app, "/api/library/transcode/retry-all")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      queued: number
      skipped: number
      invalid: number
    }
    expect(body).toEqual({ ok: true, queued: 1, skipped: 1, invalid: 1 })

    const jobs = stack.sqlite
      .query("SELECT workshop_id FROM transcode_jobs")
      .all() as Array<{ workshop_id: string }>
    expect(jobs.map((j) => j.workshop_id)).toEqual(["fourk"])
    expect(stack.libRow("fourk")?.transcode_status).toBe("pending")
    expect(stack.libRow("native")?.transcode_status).toBe("skipped")
    expect(stack.libRow("done")?.transcode_status).toBe("completed")
    expect(stack.libRow("busy")?.transcode_status).toBe("running")
  })

  test("returns 503 when no worker key is configured", async () => {
    delete process.env[ENV]
    try {
      const stack = makeStack([])
      const res = await post(stack.app, "/api/library/transcode/retry-all")
      expect(res.status).toBe(503)
    } finally {
      process.env[ENV] = TEST_KEY
    }
  })
})
