import { describe, expect, test } from "bun:test"
import { Elysia } from "elysia"
import { sessionGuard } from "./sessionGuard.js"
import { originGuard } from "./originGuard.js"
import { authRateLimit } from "./authRateLimit.js"
import type { AuthService } from "../services/Auth.js"

const mockAuth = (hasSession: boolean): AuthService =>
  ({
    instance: {
      api: {
        getSession: async () => (hasSession ? { user: { id: "u1" } } : null),
      },
    } as unknown as AuthService["instance"],
    handle: {} as AuthService["handle"],
    path: "/tmp/auth.db",
    maxPasskeys: 3,
    dispose: () => {},
  } as AuthService)

const buildApp = (guard: any) =>
  new Elysia()
    .use(guard)
    .get("/api/library", () => ({ ok: true }))
    .get("/api/health", () => ({ ok: true }))

describe("sessionGuard", () => {
  test("returns 401 on protected routes when unauthenticated", async () => {
    const app = buildApp(sessionGuard(mockAuth(false)))
    const res = await app.handle(new Request("http://localhost/api/library"))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toContain("Authentication required")
  })

  test("passes through on /api/health", async () => {
    const app = buildApp(sessionGuard(mockAuth(false)))
    const res = await app.handle(new Request("http://localhost/api/health"))
    expect(res.status).toBe(200)
  })

  test("passes through on /api/auth/*", async () => {
    const app = new Elysia()
      .use(sessionGuard(mockAuth(false)))
      .post("/api/auth/sign-up/email", () => ({ ok: true }))
    const res = await app.handle(
      new Request("http://localhost/api/auth/sign-up/email", { method: "POST" })
    )
    expect(res.status).toBe(200)
  })

  test("allows authenticated requests", async () => {
    const app = buildApp(sessionGuard(mockAuth(true)))
    const res = await app.handle(new Request("http://localhost/api/library"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })
})

describe("originGuard", () => {
  const config = {
    enabled: true,
    base_url: "https://pwe.example.com",
    trusted_origins: ["https://pwe.example.com"],
    rp_id: "pwe.example.com",
    admin_email: "admin@example.com",
    secret_env: "PWE_AUTH_SECRET",
    setup_token_env: "PWE_AUTH_SETUP_TOKEN",
    session_days: 30,
    max_passkeys: 3,
  }

  test("allows requests from trusted origin", async () => {
    const app = buildApp(originGuard(config))
    const res = await app.handle(
      new Request("http://localhost/api/library", {
        headers: { origin: "https://pwe.example.com" },
      })
    )
    expect(res.status).toBe(200)
  })

  test("blocks requests from untrusted origin", async () => {
    const app = buildApp(originGuard(config))
    const res = await app.handle(
      new Request("http://localhost/api/library", {
        headers: { origin: "https://evil.com" },
      })
    )
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toContain("Untrusted origin")
  })

  test("requires origin on state-changing requests", async () => {
    const app = new Elysia()
      .use(originGuard(config))
      .post("/api/library", () => ({ ok: true }))
    const res = await app.handle(
      new Request("http://localhost/api/library", { method: "POST" })
    )
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toContain("Origin header required")
  })

  test("allows GET without origin", async () => {
    const app = buildApp(originGuard(config))
    const res = await app.handle(new Request("http://localhost/api/library"))
    expect(res.status).toBe(200)
  })

  test("ignores non-api paths", async () => {
    const app = new Elysia().use(originGuard(config)).get("/", () => "ok")
    const res = await app.handle(new Request("http://localhost/"))
    expect(res.status).toBe(200)
  })
})

describe("authRateLimit", () => {
  const makeRequest = (pathname: string, method: string, clientIp?: string) => {
    const headers = new Headers()
    if (clientIp) headers.set("x-forwarded-for", clientIp)
    return new Request(`http://localhost${pathname}`, { method, headers })
  }

  test("allows requests under the limit", async () => {
    const app = new Elysia()
      .use(authRateLimit())
      .post("/api/auth/sign-up/email", () => ({ ok: true }))
    const res = await app.handle(
      makeRequest("/api/auth/sign-up/email", "POST", "1.2.3.4")
    )
    expect(res.status).toBe(200)
  })

  test("returns 429 after exceeding sign-up limit", async () => {
    const app = new Elysia()
      .use(authRateLimit())
      .post("/api/auth/sign-up/email", () => ({ ok: true }))
    for (let i = 0; i < 5; i++) {
      await app.handle(makeRequest("/api/auth/sign-up/email", "POST", "1.2.3.4"))
    }
    const res = await app.handle(
      makeRequest("/api/auth/sign-up/email", "POST", "1.2.3.4")
    )
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("60")
  })

  test("tracks different clients separately", async () => {
    const app = new Elysia()
      .use(authRateLimit())
      .post("/api/auth/sign-up/email", () => ({ ok: true }))
    for (let i = 0; i < 6; i++) {
      await app.handle(makeRequest("/api/auth/sign-up/email", "POST", "1.2.3.4"))
    }
    const res = await app.handle(
      makeRequest("/api/auth/sign-up/email", "POST", "5.6.7.8")
    )
    expect(res.status).toBe(200)
  })

  test("does not limit non-auth endpoints", async () => {
    const app = new Elysia()
      .use(authRateLimit())
      .get("/api/library", () => ({ ok: true }))
    for (let i = 0; i < 10; i++) {
      await app.handle(makeRequest("/api/library", "GET", "1.2.3.4"))
    }
    const res = await app.handle(makeRequest("/api/library", "GET", "1.2.3.4"))
    expect(res.status).toBe(200)
  })

  test("limits sign-in endpoints", async () => {
    const app = new Elysia()
      .use(authRateLimit())
      .post("/api/auth/sign-in/passkey", () => ({ ok: true }))
    for (let i = 0; i < 20; i++) {
      await app.handle(
        makeRequest("/api/auth/sign-in/passkey", "POST", "1.2.3.4")
      )
    }
    const res = await app.handle(
      makeRequest("/api/auth/sign-in/passkey", "POST", "1.2.3.4")
    )
    expect(res.status).toBe(429)
  })

  test("limits passkey verify endpoints", async () => {
    const app = new Elysia()
      .use(authRateLimit())
      .post("/api/auth/passkey/verify-authentication", () => ({ ok: true }))
    for (let i = 0; i < 30; i++) {
      await app.handle(
        makeRequest("/api/auth/passkey/verify-authentication", "POST", "1.2.3.4")
      )
    }
    const res = await app.handle(
      makeRequest("/api/auth/passkey/verify-authentication", "POST", "1.2.3.4")
    )
    expect(res.status).toBe(429)
  })
})
