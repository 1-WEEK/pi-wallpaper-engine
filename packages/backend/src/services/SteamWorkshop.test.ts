import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Config, type RuntimeConfig } from "./Config.js"
import {
  SteamWorkshop,
  SteamWorkshopLive,
  type WorkshopSearchParams,
  type WorkshopSearchResult,
} from "./SteamWorkshop.js"

// SteamWorkshop.search() owns the Steam QueryFiles URL assembly, cursor
// pagination, and an in-memory LRU cache — all pure once fetch is stubbed.
// We drive it through a real ManagedRuntime (fresh per test => fresh cache)
// and assert on the URL it requested plus the decoded result.

const realFetch = globalThis.fetch
let captured: string[] = []

const stubFetch = (payload: unknown) => {
  captured = []
  globalThis.fetch = ((input: RequestInfo | URL) => {
    captured.push(String(input))
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => payload,
    } as Response)
  }) as typeof fetch
}

const payload = (
  over: {
    total?: number
    next_cursor?: string
    items?: Array<{ publishedfileid: string; title: string }>
  } = {}
) => ({
  response: {
    total: over.total ?? 0,
    ...(over.next_cursor !== undefined ? { next_cursor: over.next_cursor } : {}),
    publishedfiledetails: over.items ?? [],
  },
})

const configImpl: RuntimeConfig = {
  steam: { username: "u", web_api_key: "KEY123", steamcmd_path: "/x" },
  paths: { data_root: "/tmp", source_dir: "source", optimized_dir: "optimized" },
  storage: { root: null },
  screen: { width: 1920, height: 1080, default_display_mode: "fill" },
  mpv: { binary_path: "mpv", ipc_socket: "/tmp/x.sock", hwdec: "auto", gpu_api: "opengl" },
  transcode: { target_codec: "hevc", target_quality: 23, heartbeat_timeout_ms: 60_000 },
  server: { host: "0.0.0.0", port: 8080 },
}

const buildRuntime = () =>
  ManagedRuntime.make(SteamWorkshopLive.pipe(Layer.provide(Layer.succeed(Config, configImpl))))

let runtime: ReturnType<typeof buildRuntime>

const search = (params: WorkshopSearchParams): Promise<WorkshopSearchResult> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* SteamWorkshop
      return yield* svc.search(params)
    })
  )

const lastUrl = () => new URL(captured.at(-1)!)

beforeEach(() => {
  runtime = buildRuntime()
})

afterEach(async () => {
  await runtime.dispose()
  globalThis.fetch = realFetch
})

describe("SteamWorkshop.search URL assembly", () => {
  test("always pins the Video required tag and de-dups a user-supplied Video", async () => {
    stubFetch(payload())
    await search({ query: "", tags: ["Video", "Anime"] })
    const sp = lastUrl().searchParams
    expect(sp.get("requiredtags[0]")).toBe("Video")
    expect(sp.get("requiredtags[1]")).toBe("Anime")
    expect(sp.has("requiredtags[2]")).toBe(false)
    expect(sp.get("match_all_tags")).toBe("true")
    // Empty query must not set search_text.
    expect(sp.has("search_text")).toBe(false)
  })

  test("trims search_text and maps sort=recent to query_type 1", async () => {
    stubFetch(payload())
    await search({ query: "  neon city  ", sort: "recent" })
    const sp = lastUrl().searchParams
    expect(sp.get("search_text")).toBe("neon city")
    expect(sp.get("query_type")).toBe("1")
  })

  test("defaults sort to trend (query_type 9)", async () => {
    stubFetch(payload())
    await search({ query: "x" })
    expect(lastUrl().searchParams.get("query_type")).toBe("9")
  })
})

describe("SteamWorkshop.search pagination", () => {
  test("surfaces next_cursor and decodes items when it advances", async () => {
    stubFetch(payload({ total: 2, next_cursor: "PAGE2", items: [{ publishedfileid: "111", title: "A" }] }))
    const result = await search({ query: "q", cursor: "*" })
    expect(result.total).toBe(2)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]!.publishedfileid).toBe("111")
    expect(result.nextCursor).toBe("PAGE2")
  })

  test("suppresses next_cursor when it equals the input cursor (end of feed)", async () => {
    stubFetch(payload({ total: 1, next_cursor: "DUP" }))
    const result = await search({ query: "q", cursor: "DUP" })
    expect(result.nextCursor).toBeUndefined()
  })
})

describe("SteamWorkshop.search caching", () => {
  test("identical params hit the cache and do not re-fetch", async () => {
    stubFetch(payload({ total: 1 }))
    const first = await search({ query: "cached", cursor: "*" })
    expect(captured).toHaveLength(1)
    const second = await search({ query: "cached", cursor: "*" })
    expect(captured).toHaveLength(1) // no second network call
    expect(second).toEqual(first)
  })
})
