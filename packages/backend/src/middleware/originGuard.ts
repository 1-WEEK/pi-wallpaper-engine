import { Elysia } from "elysia"
import type { AuthConfig } from "@pwe/shared"

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"])

const PUBLIC_PREFIXES = ["/api/health", "/api/auth/"]

const isPublicPath = (pathname: string): boolean =>
  PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))

const originHost = (origin: string): string | null => {
  try {
    return new URL(origin).origin
  } catch {
    return null
  }
}

export const originGuard = (config: AuthConfig) => {
  const trusted = new Set(
    config.trusted_origins
      .map((o) => originHost(o))
      .filter((o): o is string => o !== null)
  )

  return new Elysia({ name: "pwe-origin-guard" }).onBeforeHandle(
    { as: "global" },
    ({ request, set }) => {
      const url = new URL(request.url)
      if (!url.pathname.startsWith("/api/")) return
      if (isPublicPath(url.pathname)) return

      const origin = request.headers.get("origin")
      if (origin) {
        const normalized = originHost(origin)
        if (!normalized || !trusted.has(normalized)) {
          set.status = 403
          return { ok: false, error: "Untrusted origin." }
        }
        return
      }

      if (STATE_CHANGING.has(request.method)) {
        set.status = 403
        return { ok: false, error: "Origin header required for write requests." }
      }
    }
  )
}
