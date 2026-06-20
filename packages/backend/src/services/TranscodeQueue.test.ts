import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Database } from "bun:sqlite"
import { DbError, type LibraryItem } from "@pwe/shared"
import { Config, type RuntimeConfig } from "./Config.js"
import { Db, type DbImpl } from "./Db.js"
import { Library, type LibraryImpl } from "./Library.js"
import { Logger, type LoggerImpl } from "./Logger.js"
import { TranscodeQueue, TranscodeQueueLive } from "./TranscodeQueue.js"
import type { TranscodeDecision } from "../transcode/decide.js"

let openDbs: Database[] = []

const TRANSCODE_JOBS_DDL = `
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

const makeDbLayer = () => {
  const sqlite = new Database(":memory:")
  openDbs.push(sqlite)
  sqlite.exec(TRANSCODE_JOBS_DDL)

  const tryDb =
    <T>(operation: string, fn: () => T): Effect.Effect<T, DbError> =>
      Effect.try({
        try: fn,
        catch: (cause) => new DbError({ operation, cause }),
      })

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

const makeLibraryStub = (initial: LibraryItem) => {
  let row: LibraryItem = { ...initial }
  const updates: Partial<LibraryItem>[] = []

  const impl: LibraryImpl = {
    list: () => Effect.succeed([row]),
    get: () => Effect.succeed(row),
    insert: () => Effect.void,
    update: (_id, patch) =>
      Effect.sync(() => {
        updates.push(patch)
        row = { ...row, ...patch } as LibraryItem
      }),
    remove: () => Effect.void,
    playablePath: () => Effect.succeed(row.transcoded_path ?? row.source_path),
  }

  return {
    layer: Layer.succeed(Library, impl),
    updates,
    current: () => row,
  }
}

const makeLoggerStub = () => {
  const lines: string[] = []
  const impl: LoggerImpl = {
    info: (m) => Effect.sync(() => void lines.push(`INFO ${m}`)),
    warn: (m) => Effect.sync(() => void lines.push(`WARN ${m}`)),
    error: (m) => Effect.sync(() => void lines.push(`ERROR ${m}`)),
    debug: () => Effect.void,
  }
  return { layer: Layer.succeed(Logger, impl), lines }
}

const makeConfigLayer = () => {
  const impl: RuntimeConfig = {
    steam: { username: "u", web_api_key: "k", steamcmd_path: "/x" },
    paths: { data_root: "/tmp", source_dir: "source", optimized_dir: "optimized" },
    storage: { root: null },
    screen: { width: 1200, height: 1080, default_display_mode: "fill" },
    mpv: {
      binary_path: "mpv",
      ipc_socket: "/tmp/x.sock",
      hwdec: "auto",
      gpu_api: "opengl",
    },
    transcode: { target_codec: "hevc", target_quality: 23, heartbeat_timeout_ms: 60_000 },
    server: { host: "0.0.0.0", port: 8080 },
  }
  return Layer.succeed(Config, impl)
}

afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs = []
})

describe("TranscodeQueueLive", () => {
  let runtime: ManagedRuntime.ManagedRuntime<TranscodeQueue, never>
  let dbHandle: Database
  let library: ReturnType<typeof makeLibraryStub>
  let logger: ReturnType<typeof makeLoggerStub>

  beforeEach(() => {
    const dbStub = makeDbLayer()
    dbHandle = dbStub.db
    library = makeLibraryStub(baseLibraryRow)
    logger = makeLoggerStub()
    const stack = TranscodeQueueLive.pipe(
      Layer.provide(library.layer),
      Layer.provide(logger.layer),
      Layer.provide(dbStub.layer),
      Layer.provide(makeConfigLayer())
    )
    runtime = ManagedRuntime.make(stack)
  })

  test("enqueue(skip) updates library and inserts no job row", async () => {
    const decision: TranscodeDecision = {
      kind: "skip",
      reason: "test skip",
    }
    await runtime.runPromise(
      Effect.gen(function* () {
        const queue = yield* TranscodeQueue
        yield* queue.enqueue("abc", decision, "source/abc/wallpaper.mp4")
      })
    )

    const rows = dbHandle.query("SELECT * FROM transcode_jobs").all() as Array<{ id: string }>
    expect(rows).toHaveLength(0)
    expect(library.current().transcode_status).toBe("skipped")
  })

  test("enqueue(transcode) inserts pending job and marks library pending", async () => {
    const decision: TranscodeDecision = {
      kind: "transcode",
      target_width: 1200,
      target_height: 1080,
      target_codec: "hevc",
      reason: "4K source",
    }
    await runtime.runPromise(
      Effect.gen(function* () {
        const queue = yield* TranscodeQueue
        yield* queue.enqueue("abc", decision, "source/abc/wallpaper.mp4")
      })
    )

    const rows = dbHandle
      .query("SELECT * FROM transcode_jobs WHERE workshop_id = 'abc'")
      .all() as Array<{ status: string; progress: number }>
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe("pending")
    expect(library.current().transcode_status).toBe("pending")
  })

  test("claim returns the pending job and flips status to claimed", async () => {
    dbHandle
      .prepare(
        `INSERT INTO transcode_jobs (id, workshop_id, status, progress, created_at)
         VALUES (?, ?, 'pending', 0, ?)`
      )
      .run("J1", "abc", Date.now())

    const job = await runtime.runPromise(
      Effect.gen(function* () {
        const queue = yield* TranscodeQueue
        return yield* queue.claim("nas-01")
      })
    )

    expect(job).not.toBeNull()
    expect(job?.id).toBe("J1")
    expect(job?.workshop_id).toBe("abc")
    expect(job?.source_url).toBe("/api/transcode/J1/source")
    expect(job?.artifact_url).toBe("/api/transcode/J1/artifact")
    expect(job?.target_codec).toBe("hevc")

    const row = dbHandle
      .query("SELECT status, worker FROM transcode_jobs WHERE id = 'J1'")
      .get() as { status: string; worker: string }
    expect(row.status).toBe("claimed")
    expect(row.worker).toBe("nas-01")
    expect(library.current().transcode_status).toBe("claimed")
  })

  test("claim returns null when no pending job", async () => {
    const job = await runtime.runPromise(
      Effect.gen(function* () {
        const queue = yield* TranscodeQueue
        return yield* queue.claim("nas-01")
      })
    )
    expect(job).toBeNull()
  })

  test("heartbeat promotes claimed → running on first call", async () => {
    dbHandle
      .prepare(
        `INSERT INTO transcode_jobs (id, workshop_id, status, progress, created_at, last_heartbeat)
         VALUES ('J1', 'abc', 'claimed', 0, ?, ?)`
      )
      .run(Date.now(), Date.now())

    const ok = await runtime.runPromise(
      Effect.gen(function* () {
        const queue = yield* TranscodeQueue
        return yield* queue.heartbeat("J1")
      })
    )

    expect(ok).toBe(true)
    const row = dbHandle
      .query("SELECT status FROM transcode_jobs WHERE id = 'J1'")
      .get() as { status: string }
    expect(row.status).toBe("running")
    expect(library.current().transcode_status).toBe("running")
  })

  test("heartbeat returns false for missing job", async () => {
    const ok = await runtime.runPromise(
      Effect.gen(function* () {
        const queue = yield* TranscodeQueue
        return yield* queue.heartbeat("nope")
      })
    )
    expect(ok).toBe(false)
  })

  test("progress clamps to 0..100 and mirrors to library", async () => {
    dbHandle
      .prepare(
        `INSERT INTO transcode_jobs (id, workshop_id, status, progress, created_at, last_heartbeat)
         VALUES ('J1', 'abc', 'running', 0, ?, ?)`
      )
      .run(Date.now(), Date.now())

    await runtime.runPromise(
      Effect.gen(function* () {
        const queue = yield* TranscodeQueue
        yield* queue.progress("J1", 150) // out-of-range — should clamp to 100
      })
    )

    const row = dbHandle
      .query("SELECT progress FROM transcode_jobs WHERE id = 'J1'")
      .get() as { progress: number }
    expect(row.progress).toBe(100)
    expect(library.current().transcode_progress).toBe(100)
  })

  test("uploading marks job and library uploading", async () => {
    dbHandle
      .prepare(
        `INSERT INTO transcode_jobs (id, workshop_id, status, progress, created_at, last_heartbeat)
         VALUES ('J1', 'abc', 'running', 100, ?, ?)`
      )
      .run(Date.now(), Date.now())

    const ok = await runtime.runPromise(
      Effect.gen(function* () {
        const queue = yield* TranscodeQueue
        return yield* queue.uploading("J1")
      })
    )

    expect(ok).toBe(true)
    const row = dbHandle
      .query("SELECT status FROM transcode_jobs WHERE id = 'J1'")
      .get() as { status: string }
    expect(row.status).toBe("uploading")
    expect(library.current().transcode_status).toBe("uploading")
  })

  test("complete writes optimized metadata and marks library completed", async () => {
    dbHandle
      .prepare(
        `INSERT INTO transcode_jobs (id, workshop_id, status, progress, created_at, last_heartbeat)
         VALUES ('J1', 'abc', 'running', 50, ?, ?)`
      )
      .run(Date.now(), Date.now())

    await runtime.runPromise(
      Effect.gen(function* () {
        const queue = yield* TranscodeQueue
        yield* queue.complete(
          "J1",
          {
            output_relative_path: "optimized/abc.mp4",
            output_size: 1_234_567,
            duration_ms: 4200,
          },
          "1200x1080",
          "hevc"
        )
      })
    )

    const row = dbHandle
      .query("SELECT status, progress FROM transcode_jobs WHERE id = 'J1'")
      .get() as { status: string; progress: number }
    expect(row.status).toBe("completed")
    expect(row.progress).toBe(100)

    const lib = library.current()
    expect(lib.transcode_status).toBe("completed")
    expect(lib.transcoded_path).toBe("optimized/abc.mp4")
    expect(lib.transcoded_size).toBe(1_234_567)
    expect(lib.transcoded_codec).toBe("hevc")
    expect(lib.transcoded_resolution).toBe("1200x1080")
  })

  test("fail writes error to library and marks failed", async () => {
    dbHandle
      .prepare(
        `INSERT INTO transcode_jobs (id, workshop_id, status, progress, created_at, last_heartbeat)
         VALUES ('J1', 'abc', 'running', 50, ?, ?)`
      )
      .run(Date.now(), Date.now())

    await runtime.runPromise(
      Effect.gen(function* () {
        const queue = yield* TranscodeQueue
        yield* queue.fail("J1", "ffmpeg exited 1")
      })
    )

    const row = dbHandle
      .query("SELECT status, error FROM transcode_jobs WHERE id = 'J1'")
      .get() as { status: string; error: string }
    expect(row.status).toBe("failed")
    expect(row.error).toBe("ffmpeg exited 1")

    const lib = library.current()
    expect(lib.transcode_status).toBe("failed")
    expect(lib.transcode_error).toBe("ffmpeg exited 1")
  })
})
