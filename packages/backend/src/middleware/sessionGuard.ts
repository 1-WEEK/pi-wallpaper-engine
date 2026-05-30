import { Elysia } from "elysia"
import type { AuthService } from "../services/Auth.js"

// `/api/transcode/` is intentionally public to sessionGuard because Worker
// requests authenticate via `workerGuard` (shared API key in X-Worker-Key),
// not Better Auth sessions. The Worker is a headless container that cannot
// hold passkey cookies.
const PUBLIC_PREFIXES = ["/api/health", "/api/auth/", "/api/transcode/"]

const isPublicPath = (pathname: string): boolean =>
  PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))

export const sessionGuard = (auth: AuthService) =>
  new Elysia({ name: "pwe-session-guard" }).onBeforeHandle(
    { as: "global" },
    async ({ request, set }) => {
      const url = new URL(request.url)
      if (!url.pathname.startsWith("/api/")) return
      if (isPublicPath(url.pathname)) return

      const session = await auth.instance.api
        .getSession({ headers: request.headers })
        .catch(() => null)
      if (!session) {
        set.status = 401
        return { ok: false, error: "Authentication required." }
      }
    }
  )
