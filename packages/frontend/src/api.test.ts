import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { api } from "./api.js"

// `api.workshopSearch` is the only api.ts method with real branching logic
// (the rest are 1:1 fetch wrappers). It builds the query string by hand, so we
// drive it with a stubbed `fetch` and assert the URL it produced. Parsing the
// captured URL back through URLSearchParams keeps the assertions order-robust.

const realFetch = globalThis.fetch
let captured: string[] = []

const stubFetch = (response: { ok: boolean; status: number; body: unknown }) => {
  captured = []
  globalThis.fetch = ((input: RequestInfo | URL) => {
    captured.push(String(input))
    return Promise.resolve({
      ok: response.ok,
      status: response.status,
      json: async () => response.body,
    } as Response)
  }) as typeof fetch
}

const lastQuery = () => new URLSearchParams(captured[0]!.split("?")[1] ?? "")

beforeEach(() => {
  stubFetch({ ok: true, status: 200, body: { total: 0, items: [] } })
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe("api.workshopSearch URL building", () => {
  test("defaults cursor to '*' and omits optional params", async () => {
    await api.workshopSearch("hello")
    const q = lastQuery()
    expect(captured[0]!.startsWith("/api/workshop/search?")).toBe(true)
    expect(q.get("q")).toBe("hello")
    expect(q.get("cursor")).toBe("*")
    expect(q.has("pageSize")).toBe(false)
    expect(q.has("tags")).toBe(false)
    expect(q.has("sort")).toBe(false)
  })

  test("passes cursor, pageSize, sort and joins tags with commas", async () => {
    await api.workshopSearch("anime", {
      cursor: "AoJw",
      pageSize: 50,
      tags: ["Anime", "Nature"],
      sort: "recent",
    })
    const q = lastQuery()
    expect(q.get("q")).toBe("anime")
    expect(q.get("cursor")).toBe("AoJw")
    expect(q.get("pageSize")).toBe("50")
    expect(q.get("tags")).toBe("Anime,Nature")
    expect(q.get("sort")).toBe("recent")
  })

  test("omits tags when the array is empty", async () => {
    await api.workshopSearch("x", { tags: [] })
    expect(lastQuery().has("tags")).toBe(false)
  })

  test("rejects with the server error message on a non-ok response", async () => {
    stubFetch({ ok: false, status: 500, body: { error: "upstream boom" } })
    await expect(api.workshopSearch("x")).rejects.toThrow("upstream boom")
  })
})
