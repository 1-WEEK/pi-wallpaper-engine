import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Elysia } from "elysia"
import { LibraryNotFoundError, type LibraryItem } from "@pwe/shared"
import { Config, type RuntimeConfig } from "../services/Config.js"
import { Db, type DbImpl } from "../services/Db.js"
import { Library, type LibraryImpl } from "../services/Library.js"
import { Logger, type LoggerImpl } from "../services/Logger.js"
import { Storage, type StorageImpl } from "../services/Storage.js"
import { TranscodeQueueLive } from "../services/TranscodeQueue.js"
import { TasksLive } from "../services/Tasks.js"
import { libraryRoutes } from "./library.js"

// 64 distinct bytes so range assertions can pin exact slices.
const FILE_BYTES = new Uint8Array(Array.from({ length: 64 }, (_, i) => i))

let tempRoots: string[] = []

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
  tempRoots = []
})

const makeRow = (overrides: Partial<LibraryItem> = {}): LibraryItem => ({
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
  transcode_status: "completed",
  transcode_progress: 100,
  transcode_error: null,
  transcoded_path: "optimized/abc.mp4",
  transcoded_resolution: "1920x1080",
  transcoded_codec: "hevc",
  transcoded_size: 64,
  display_mode: "fill",
  last_played_at: null,
  ...overrides,
})

const makeStack = (rowList: LibraryItem[]) => {
  const mediaRoot = mkdtempSync(join(tmpdir(), "pwe-stream-"))
  tempRoots.push(mediaRoot)
  mkdirSync(join(mediaRoot, "optimized"), { recursive: true })
  writeFileSync(join(mediaRoot, "optimized", "abc.mp4"), FILE_BYTES)

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
    update: () => Effect.void,
    remove: () => Effect.void,
    playablePath: (row) => Effect.succeed(join(mediaRoot, row.transcoded_path ?? row.source_path)),
  }

  // The stream route only touches mediaRoot; status/saveRoot are never hit.
  const storageImpl = {
    mediaRoot: () => Effect.succeed(mediaRoot),
    mediaRootOrNull: () => Effect.succeed(mediaRoot),
  } as unknown as StorageImpl

  const logImpl: LoggerImpl = {
    info: () => Effect.void,
    warn: () => Effect.void,
    error: () => Effect.void,
    debug: () => Effect.void,
  }

  const dbImpl: DbImpl = {
    query: () => Effect.succeed([]),
    queryOne: () => Effect.succeed(null),
    exec: () => Effect.void,
    transaction: (fn) => fn(),
  } as DbImpl

  const configImpl: RuntimeConfig = {
    steam: { username: "u", web_api_key: "k", steamcmd_path: "/x" },
    paths: { data_root: mediaRoot, source_dir: "source", optimized_dir: "optimized" },
    storage: { root: null },
    screen: { width: 1920, height: 1080, default_display_mode: "fill" },
    mpv: { binary_path: "mpv", ipc_socket: "/tmp/x.sock", hwdec: "auto", gpu_api: "opengl" },
    transcode: { target_codec: "hevc", target_quality: 23, heartbeat_timeout_ms: 60_000 },
    server: { host: "0.0.0.0", port: 8080 },
  }

  const layer = TranscodeQueueLive.pipe(
    Layer.provideMerge(TasksLive),
    Layer.provideMerge(Layer.succeed(Library, libImpl)),
    Layer.provideMerge(Layer.succeed(Storage, storageImpl)),
    Layer.provideMerge(Layer.succeed(Logger, logImpl)),
    Layer.provideMerge(Layer.succeed(Db, dbImpl)),
    Layer.provideMerge(Layer.succeed(Config, configImpl))
  )

  const runtime = ManagedRuntime.make(layer)
  const app = new Elysia().use(libraryRoutes(runtime as never))
  return { app, mediaRoot }
}

const get = (
  app: { handle: (request: Request) => Promise<Response> },
  path: string,
  headers: Record<string, string> = {}
) => app.handle(new Request(`http://localhost${path}`, { headers }))

describe("GET /api/library/:workshopId/stream", () => {
  test("serves the whole optimized file with 200 when no Range is sent", async () => {
    const stack = makeStack([makeRow()])
    const res = await get(stack.app, "/api/library/abc/stream")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("video/mp4")
    expect(res.headers.get("accept-ranges")).toBe("bytes")
    expect(res.headers.get("content-length")).toBe("64")
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body).toEqual(FILE_BYTES)
  })

  test("a bounded Range yields 206 with exactly the requested slice", async () => {
    const stack = makeStack([makeRow()])
    const res = await get(stack.app, "/api/library/abc/stream", { range: "bytes=16-31" })
    expect(res.status).toBe(206)
    expect(res.headers.get("content-range")).toBe("bytes 16-31/64")
    expect(res.headers.get("content-length")).toBe("16")
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body).toEqual(FILE_BYTES.slice(16, 32))
  })

  test("an open-ended Range streams to EOF", async () => {
    const stack = makeStack([makeRow()])
    const res = await get(stack.app, "/api/library/abc/stream", { range: "bytes=48-" })
    expect(res.status).toBe(206)
    expect(res.headers.get("content-range")).toBe("bytes 48-63/64")
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body).toEqual(FILE_BYTES.slice(48))
  })

  test("a suffix Range serves the last N bytes", async () => {
    const stack = makeStack([makeRow()])
    const res = await get(stack.app, "/api/library/abc/stream", { range: "bytes=-8" })
    expect(res.status).toBe(206)
    expect(res.headers.get("content-range")).toBe("bytes 56-63/64")
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body).toEqual(FILE_BYTES.slice(56))
  })

  test("an out-of-bounds Range is refused with 416 and the total size", async () => {
    const stack = makeStack([makeRow()])
    const res = await get(stack.app, "/api/library/abc/stream", { range: "bytes=64-" })
    expect(res.status).toBe(416)
    expect(res.headers.get("content-range")).toBe("bytes */64")
  })

  test("an end before start is refused with 416", async () => {
    const stack = makeStack([makeRow()])
    const res = await get(stack.app, "/api/library/abc/stream", { range: "bytes=30-10" })
    expect(res.status).toBe(416)
  })

  test("unknown workshop id returns 404", async () => {
    const stack = makeStack([])
    const res = await get(stack.app, "/api/library/nope/stream")
    expect(res.status).toBe(404)
  })

  test("items whose transcode is not completed return 404", async () => {
    for (const status of ["pending", "running", "failed", "skipped"] as const) {
      const stack = makeStack([makeRow({ transcode_status: status })])
      const res = await get(stack.app, "/api/library/abc/stream")
      expect(res.status).toBe(404)
    }
  })

  test("completed row without a transcoded_path returns 404", async () => {
    const stack = makeStack([makeRow({ transcoded_path: null })])
    const res = await get(stack.app, "/api/library/abc/stream")
    expect(res.status).toBe(404)
  })

  test("a transcoded_path escaping optimized/ is refused, not served", async () => {
    // Both a straight traversal and a source/ sibling must be rejected: the
    // endpoint only ever exposes optimized/ output files.
    for (const path of ["../secret.mp4", "optimized/../source/abc/wallpaper.mp4", "/etc/hostname"]) {
      const stack = makeStack([makeRow({ transcoded_path: path })])
      writeFileSync(join(stack.mediaRoot, "secret.mp4"), FILE_BYTES)
      const res = await get(stack.app, "/api/library/abc/stream")
      expect(res.status).toBe(404)
    }
  })

  test("a completed row whose file vanished from disk returns 404", async () => {
    const stack = makeStack([makeRow({ transcoded_path: "optimized/gone.mp4" })])
    const res = await get(stack.app, "/api/library/abc/stream")
    expect(res.status).toBe(404)
  })
})
