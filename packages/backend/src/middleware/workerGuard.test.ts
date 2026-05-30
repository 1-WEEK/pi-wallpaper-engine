import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Elysia } from "elysia"
import { workerGuard } from "./workerGuard.js"

const ENV = "PWE_WORKER_API_KEY"
const originalEnv = process.env[ENV]

const restore = () => {
  if (originalEnv === undefined) delete process.env[ENV]
  else process.env[ENV] = originalEnv
}

const buildApp = () =>
  new Elysia()
    .use(workerGuard())
    .post("/api/transcode/claim", () => ({ ok: true }))

afterEach(restore)

describe("workerGuard", () => {
  beforeEach(() => {
    process.env[ENV] = "test-secret-key-1234"
  })

  test("401 when X-Worker-Key header is missing", async () => {
    const app = buildApp()
    const res = await app.handle(
      new Request("http://localhost/api/transcode/claim", { method: "POST" })
    )
    expect(res.status).toBe(401)
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body.error).toContain("Worker authentication required")
  })

  test("401 when X-Worker-Key does not match", async () => {
    const app = buildApp()
    const res = await app.handle(
      new Request("http://localhost/api/transcode/claim", {
        method: "POST",
        headers: { "x-worker-key": "wrong" },
      })
    )
    expect(res.status).toBe(401)
  })

  test("passes through when X-Worker-Key matches", async () => {
    const app = buildApp()
    const res = await app.handle(
      new Request("http://localhost/api/transcode/claim", {
        method: "POST",
        headers: { "x-worker-key": "test-secret-key-1234" },
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  test("constructor throws when PWE_WORKER_API_KEY is unset", () => {
    delete process.env[ENV]
    expect(() => workerGuard()).toThrow(/PWE_WORKER_API_KEY/)
  })

  test("constructor throws when key is shorter than 8 chars", () => {
    process.env[ENV] = "short"
    expect(() => workerGuard()).toThrow(/PWE_WORKER_API_KEY/)
  })
})
