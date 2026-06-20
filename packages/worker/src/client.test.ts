import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWorkerClient, WorkerHttpError } from "./client.js"

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

const mockFetch = (
  responder: (call: RecordedCall) => { status: number; body?: unknown }
) => {
  const calls: RecordedCall[] = []
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    const h = init?.headers as Record<string, string> | undefined
    if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v)
    const body = typeof init?.body === "string" ? init.body : ""
    const call = { url: String(url), method: init?.method ?? "GET", headers, body }
    calls.push(call)
    const result = responder(call)
    const responseBody =
      result.body === undefined
        ? null
        : typeof result.body === "string"
          ? result.body
          : JSON.stringify(result.body)
    return new Response(responseBody, { status: result.status })
  }) as typeof fetch
  return { fetch: impl, calls }
}

describe("createWorkerClient", () => {
  test("claim returns the job body on 200", async () => {
    const { fetch, calls } = mockFetch(() => ({
      status: 200,
      body: {
        id: "J1",
        workshop_id: "abc",
        source_url: "/api/transcode/J1/source",
        artifact_url: "/api/transcode/J1/artifact",
        target_width: 1200,
        target_height: 1080,
        target_codec: "hevc",
        target_quality: 23,
      },
    }))
    const client = createWorkerClient({
      baseUrl: "http://pi.local:8080",
      apiKey: "key",
      fetchImpl: fetch,
    })
    const job = await client.claim("nas-01")
    expect(job).not.toBeNull()
    expect(job?.id).toBe("J1")
    expect(calls[0]?.url).toBe("http://pi.local:8080/api/transcode/claim")
    expect(calls[0]?.headers["x-worker-key"]).toBe("key")
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ worker: "nas-01" })
  })

  test("claim returns null on 204", async () => {
    const { fetch } = mockFetch(() => ({ status: 204 }))
    const client = createWorkerClient({
      baseUrl: "http://pi.local:8080",
      apiKey: "key",
      fetchImpl: fetch,
    })
    expect(await client.claim("nas-01")).toBeNull()
  })

  test("heartbeat returns false on 404 instead of throwing", async () => {
    const { fetch } = mockFetch(() => ({ status: 404, body: { ok: false } }))
    const client = createWorkerClient({
      baseUrl: "http://pi.local:8080",
      apiKey: "key",
      fetchImpl: fetch,
    })
    expect(await client.heartbeat("missing")).toBe(false)
  })

  test("auth failures throw WorkerHttpError(code='auth')", async () => {
    const { fetch } = mockFetch(() => ({ status: 401, body: { ok: false } }))
    const client = createWorkerClient({
      baseUrl: "http://pi.local:8080",
      apiKey: "wrong",
      fetchImpl: fetch,
    })
    let thrown: unknown
    try {
      await client.claim("nas-01")
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(WorkerHttpError)
    expect((thrown as WorkerHttpError).code).toBe("auth")
  })

  test("progress encodes JSON body correctly", async () => {
    const { fetch, calls } = mockFetch(() => ({ status: 200, body: { ok: true } }))
    const client = createWorkerClient({
      baseUrl: "http://pi.local:8080",
      apiKey: "key",
      fetchImpl: fetch,
    })

    await client.progress("J1", 50)
    expect(calls[0]?.url).toContain("/api/transcode/J1/progress")
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ progress: 50 })
  })

  test("downloadSource streams source body to a local file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pwe-worker-client-"))
    try {
      const { fetch, calls } = mockFetch(() => ({ status: 200, body: "source-bytes" }))
      const client = createWorkerClient({
        baseUrl: "http://pi.local:8080",
        apiKey: "key",
        fetchImpl: fetch,
      })
      const target = join(dir, "source")
      await client.downloadSource("/api/transcode/J1/source", target)
      expect(await readFile(target, "utf-8")).toBe("source-bytes")
      expect(calls[0]?.method).toBe("GET")
      expect(calls[0]?.url).toBe("http://pi.local:8080/api/transcode/J1/source")
      expect(calls[0]?.headers["x-worker-key"]).toBe("key")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("uploadArtifact PUTs artifact with duration header", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pwe-worker-client-"))
    try {
      const artifact = join(dir, "output.mp4")
      await writeFile(artifact, "artifact-bytes")
      const { fetch, calls } = mockFetch(() => ({ status: 200, body: { ok: true } }))
      const client = createWorkerClient({
        baseUrl: "http://pi.local:8080",
        apiKey: "key",
        fetchImpl: fetch,
      })
      await client.uploadArtifact("/api/transcode/J1/artifact", artifact, 1000)
      expect(calls[0]?.method).toBe("PUT")
      expect(calls[0]?.url).toBe("http://pi.local:8080/api/transcode/J1/artifact")
      expect(calls[0]?.headers["x-worker-key"]).toBe("key")
      expect(calls[0]?.headers["x-transcode-duration-ms"]).toBe("1000")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("trailing slash on baseUrl is normalized", async () => {
    const { fetch, calls } = mockFetch(() => ({ status: 204 }))
    const client = createWorkerClient({
      baseUrl: "http://pi.local:8080/",
      apiKey: "key",
      fetchImpl: fetch,
    })
    await client.claim("nas-01")
    expect(calls[0]?.url).toBe("http://pi.local:8080/api/transcode/claim")
  })

  test("network errors throw WorkerHttpError(code='network')", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    const client = createWorkerClient({
      baseUrl: "http://pi.local:8080",
      apiKey: "key",
      fetchImpl: failing,
    })
    let thrown: unknown
    try {
      await client.claim("nas-01")
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(WorkerHttpError)
    expect((thrown as WorkerHttpError).code).toBe("network")
  })
})
