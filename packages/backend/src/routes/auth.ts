import type { AuthConfig } from "@pwe/shared"
import type { AuthService } from "../services/Auth.js"

const SETUP_STATE_PATH = "/api/auth/setup-state"
const PREFLIGHT_MAX_AGE = "86400"
const PREFLIGHT_ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE"
const PREFLIGHT_ALLOW_HEADERS = "content-type, x-pwe-setup-token"

// Handler bound under /api/auth/* by index.ts (see the explicit method
// registrations there for why we don't return an Elysia plugin).
//
// setup-state is the only PWE-specific endpoint we layer in; everything else
// is forwarded to Better Auth. We do not mark "setup complete" here — that
// state is derived from "at least one passkey exists" in AuthDbHandle, which
// removes the race where a half-finished sign-up locked the admin out
// permanently.
export const buildAuthHandler = (
  auth: AuthService,
  authConfig: AuthConfig
) => {
  const allowedOrigins = new Set(
    authConfig.trusted_origins
      .map((o) => {
        try {
          return new URL(o).origin
        } catch {
          return null
        }
      })
      .filter((o): o is string => o !== null)
  )

  return (request: Request): Promise<Response> => {
    const url = new URL(request.url)

    // CORS preflight. Same-origin browsers won't issue this, but a future
    // split-origin deployment (or non-browser caller) needs an explicit ACK
    // since Better Auth doesn't register OPTIONS handlers.
    if (request.method === "OPTIONS") {
      const origin = request.headers.get("origin")
      const headers: Record<string, string> = {
        "Access-Control-Allow-Methods": PREFLIGHT_ALLOW_METHODS,
        "Access-Control-Allow-Headers": PREFLIGHT_ALLOW_HEADERS,
        "Access-Control-Max-Age": PREFLIGHT_MAX_AGE,
      }
      if (origin && allowedOrigins.has(origin)) {
        headers["Access-Control-Allow-Origin"] = origin
        headers["Access-Control-Allow-Credentials"] = "true"
        headers["Vary"] = "Origin"
      }
      return Promise.resolve(new Response(null, { status: 204, headers }))
    }

    if (url.pathname === SETUP_STATE_PATH && request.method === "GET") {
      return Promise.resolve(
        Response.json({
          enabled: true,
          setup_complete: auth.handle.hasAnyPasskey(),
          max_passkeys: auth.maxPasskeys,
        })
      )
    }

    return auth.instance.handler(request)
  }
}
