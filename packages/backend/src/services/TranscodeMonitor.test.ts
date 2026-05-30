import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Database } from "bun:sqlite"
import { DbError, type LibraryItem } from "@pwe/shared"
import { Config, type RuntimeConfig } from "./Config.js"
import { Db, type DbImpl } from "./Db.js"
import { Library, type LibraryImpl } from "./Library.js"
import { Logger, type LoggerImpl } from "./Logger.js"
import { TranscodeMonitor, TranscodeMonitorBareLayer } from "./TranscodeMonitor.js"

let openDbs: Database[] = []

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

const makeDbLayer = () => {
  const sqlite = new Database(":memory:")
  openDbs.push(sqlite)
  sqlite.exec(DDL)

  const tryDb =
    <T>(operation: string, fn: () => T): Effect.Effect<T, DbError> =>
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

const makeLibraryStub = () => {
  const updates: Array<{ id: string; patch: Partial<LibraryItem> }> = []
  const impl: LibraryImpl = {
    list: () => Effect.succeed([]),
    get: () => Effect.die("Library.get unused in monitor tests"),
    insert: () => Effect.void,
    update: (id, patch) =>
      Effect.sync(() => {
        updates.push({ id, patch })
      }),
    remove: () => Effect.void,
    playablePath: () => Effect.succeed("unused"),
  }
  return { layer: Layer.succeed(Library, impl), updates }
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

const makeConfigLayer = (heartbeatTimeoutMs: number) => {
  const impl: RuntimeConfig = {
    steam: { username: "u", web_api_key: "k", steamcmd_path: "/x" },
    paths: { data_root: "/tmp", source_dir: "source", optimized_dir: "optimized" },
    storage: { root: null },
    screen: { width: 1200, height: 1080, default_display_mode: "fill" },
    mpv: { binary_path: "mpv", ipc_socket: "/tmp/x.sock", hwdec: "auto", gpu_api: "opengl" },
    transcode: { target_codec: "hevc", target_quality: 23, heartbeat_timeout_ms: heartbeatTimeoutMs },
    server: { host: "0.0.0.0", port: 8080 },
  }
  return Layer.succeed(Config, impl)
}

afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs = []
})

describe("TranscodeMonitor.sweep", () => {
  let runtime: ManagedRuntime.ManagedRuntime<TranscodeMonitor, never>
  let dbHandle: Database
  let library: ReturnType<typeof makeLibraryStub>
  let logger: ReturnType<typeof makeLoggerStub>

  beforeEach(() => {
    const dbStub = makeDbLayer()
    dbHandle = dbStub.db
    library = makeLibraryStub()
    logger = makeLoggerStub()
    const stack = TranscodeMonitorBareLayer.pipe(
      Layer.provide(library.layer),
      Layer.provide(logger.layer),
      Layer.provide(dbStub.layer),
      Layer.provide(makeConfigLayer(60_000))
    )
    runtime = ManagedRuntime.make(stack)
  })

  test("resets stale claimed/running jobs to pending and mirrors to library", async () => {
    const now = Date.now()
    const longAgo = now - 120_000 // older than the 60s heartbeat timeout

    dbHandle
      .prepare(
        `INSERT INTO transcode_jobs (id, workshop_id, status, worker, claimed_at, last_heartbeat, progress, created_at)
         VALUES ('JOLD1', 'abc', 'running', 'nas-01', ?, ?, 40, ?)`
      )
      .run(longAgo, longAgo, longAgo)
    dbHandle
      .prepare(
        `INSERT INTO transcode_jobs (id, workshop_id, status, worker, claimed_at, last_heartbeat, progress, created_at)
         VALUES ('JFRESH', 'def', 'running', 'nas-01', ?, ?, 90, ?)`
      )
      .run(now, now, now)

    const recovered = await runtime.runPromise(
      Effect.gen(function* () {
        const m = yield* TranscodeMonitor
        return yield* m.sweep()
      })
    )

    expect(recovered).toBe(1)

    const stale = dbHandle
      .query("SELECT status, worker, claimed_at, last_heartbeat FROM transcode_jobs WHERE id = 'JOLD1'")
      .get() as { status: string; worker: string | null; claimed_at: number | null; last_heartbeat: number | null }
    expect(stale.status).toBe("pending")
    expect(stale.worker).toBeNull()
    expect(stale.claimed_at).toBeNull()
    expect(stale.last_heartbeat).toBeNull()

    const fresh = dbHandle
      .query("SELECT status FROM transcode_jobs WHERE id = 'JFRESH'")
      .get() as { status: string }
    expect(fresh.status).toBe("running")

    expect(library.updates).toHaveLength(1)
    expect(library.updates[0]?.id).toBe("abc")
    expect(library.updates[0]?.patch.transcode_status).toBe("pending")
  })

  test("ignores completed/failed/skipped rows", async () => {
    const longAgo = Date.now() - 120_000
    dbHandle
      .prepare(
        `INSERT INTO transcode_jobs (id, workshop_id, status, last_heartbeat, created_at, completed_at)
         VALUES ('JC', 'a', 'completed', ?, ?, ?)`
      )
      .run(longAgo, longAgo, longAgo)
    dbHandle
      .prepare(
        `INSERT INTO transcode_jobs (id, workshop_id, status, last_heartbeat, created_at)
         VALUES ('JF', 'b', 'failed', ?, ?)`
      )
      .run(longAgo, longAgo)
    dbHandle
      .prepare(
        `INSERT INTO transcode_jobs (id, workshop_id, status, last_heartbeat, created_at)
         VALUES ('JP', 'c', 'pending', NULL, ?)`
      )
      .run(longAgo)

    const recovered = await runtime.runPromise(
      Effect.gen(function* () {
        const m = yield* TranscodeMonitor
        return yield* m.sweep()
      })
    )
    expect(recovered).toBe(0)
    expect(library.updates).toHaveLength(0)
  })

  test("treats claimed jobs with NULL last_heartbeat as stale", async () => {
    // A claim writes last_heartbeat at the moment of claim, so a NULL here
    // means the row has been monkey-patched or the worker died before any
    // heartbeat. Either way, kick it back to pending.
    const longAgo = Date.now() - 120_000
    dbHandle
      .prepare(
        `INSERT INTO transcode_jobs (id, workshop_id, status, claimed_at, last_heartbeat, created_at)
         VALUES ('JNULL', 'z', 'claimed', ?, NULL, ?)`
      )
      .run(longAgo, longAgo)

    const recovered = await runtime.runPromise(
      Effect.gen(function* () {
        const m = yield* TranscodeMonitor
        return yield* m.sweep()
      })
    )
    expect(recovered).toBe(1)
  })
})
