import { Elysia } from "elysia"
import type { AuthService } from "../services/Auth.js"

const SIGNUP_PATH = "/api/auth/sign-up/email"

export const authRoutes = (auth: AuthService) =>
  new Elysia({ prefix: "/api/auth" })
    .get("/setup-state", () => ({
      enabled: true,
      setup_complete: auth.handle.isSetupComplete(),
      max_passkeys: auth.maxPasskeys,
    }))
    .all("/*", async ({ request }) => {
      const response = await auth.instance.handler(request)
      const url = new URL(request.url)
      if (
        url.pathname === SIGNUP_PATH &&
        request.method === "POST" &&
        response.ok &&
        !auth.handle.isSetupComplete()
      ) {
        auth.handle.markSetupComplete()
      }
      return response
    })
