import { Elysia } from "elysia"
import type { AuthService } from "../services/Auth.js"

const PUBLIC_PREFIXES = ["/api/health", "/api/auth/"]

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
