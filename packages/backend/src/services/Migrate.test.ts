import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Database } from "bun:sqlite"
import { DbError, MigrateError } from "@pwe/shared"
import { Config, type RuntimeConfig } from "./Config.js"
import { Db, type DbImpl } from "./Db.js"
import { Logger, type LoggerImpl } from "./Logger.js"
import { Migrate, MigrateLive } from "./Migrate.js"
import { Mpv, type MpvImpl } from "./Mpv.js"
import { Storage, type StorageImpl } from "./Storage.js"

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

const configLayer = () => {
  const config: RuntimeConfig = {
    steam: { username: "u", web_api_key: "k", steamcmd_path: "/x" },
    paths: { data_root: "/from", source_dir: "source", optimized_dir: "optimized" },
    storage: { root: null },
    screen: { width: 1200, height: 1080, default_display_mode: "fill" },
    mpv: { binary_path: "mpv", ipc_socket: "/tmp/x.sock", hwdec: "auto", gpu_api: "opengl" },
    transcode: { target_codec: "hevc", target_quality: 23, heartbeat_timeout_ms: 60_000 },
    server: { host: "0.0.0.0", port: 8080 },
  }
  return Layer.succeed(Config, config)
}

const loggerLayer = () => {
  const logger: LoggerImpl = {
    info: () => Effect.void,
    warn: () => Effect.void,
    error: () => Effect.void,
    debug: () => Effect.void,
  }
  return Layer.succeed(Logger, logger)
}

const mpvLayer = () => {
  const mpv: MpvImpl = {
    play: () => Effect.void,
    pause: () => Effect.void,
    resume: () => Effect.void,
    stop: () => Effect.void,
    setDisplayMode: () => Effect.void,
    status: () =>
      Effect.succeed({
        playing: false,
        current_workshop_id: null,
        path: null,
        display_mode: "fill",
      }),
  }
  return Layer.succeed(Mpv, mpv)
}

const storageLayer = () => {
  const storage: StorageImpl = {
    status: () =>
      Effect.succeed({
        available: true,
        data_root: "/from",
        default_root: "/from",
        using_default: true,
        last_error: null,
      }),
    mediaRoot: () => Effect.succeed("/from"),
    mediaRootOrNull: () => Effect.succeed("/from"),
    saveRoot: () =>
      Effect.succeed({
        available: true,
        data_root: "/to",
        default_root: "/from",
        using_default: false,
        last_error: null,
      }),
  }
  return Layer.succeed(Storage, storage)
}

afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs = []
})

describe("MigrateLive", () => {
  test("blocks migration while a transcode job is active", async () => {
    const db = makeDbLayer()
    db.db
      .prepare(
        `INSERT INTO transcode_jobs (id, workshop_id, status, progress, created_at)
         VALUES ('J1', 'abc', 'claimed', 0, ?)`
      )
      .run(Date.now())

    const layer = MigrateLive.pipe(
      Layer.provide(configLayer()),
      Layer.provide(db.layer),
      Layer.provide(loggerLayer()),
      Layer.provide(mpvLayer()),
      Layer.provide(storageLayer())
    )
    const runtime = ManagedRuntime.make(layer)

    const { result, status } = await runtime.runPromise(
      Effect.gen(function* () {
        const migrate = yield* Migrate
        const result = yield* Effect.either(migrate.start("/to"))
        const status = yield* migrate.status()
        return { result, status }
      })
    )
    await runtime.dispose()

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(MigrateError)
      expect(result.left.kind).toBe("Busy")
    }
    expect(status).toBeNull()
  })
})
