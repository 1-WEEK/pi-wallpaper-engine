import { betterAuth, type BetterAuthOptions } from "better-auth"
import { APIError, createAuthMiddleware } from "better-auth/api"
import { getMigrations } from "better-auth/db/migration"
import { passkey } from "@better-auth/passkey"
import type { AuthConfig } from "@pwe/shared"
import { openAuthDb, resolveAuthDbPath, type AuthDbHandle } from "../db/AuthDb.js"

const SECONDS_PER_DAY = 86400

export interface AuthService {
  readonly instance: ReturnType<typeof betterAuth>
  readonly handle: AuthDbHandle
  readonly path: string
  readonly dispose: () => void
}

export const createAuth = async (config: AuthConfig): Promise<AuthService> => {
  const secretEnv = config.secret_env ?? "PWE_AUTH_SECRET"
  const secret = process.env[secretEnv]
  if (!secret || secret.length < 16) {
    throw new Error(
      `auth.enabled=true requires env ${secretEnv} (>=16 chars). Set it before starting the server.`
    )
  }

  const setupTokenEnv = config.setup_token_env ?? "PWE_AUTH_SETUP_TOKEN"

  const handle = openAuthDb()

  const options: BetterAuthOptions = {
    database: handle.db,
    secret,
    baseURL: config.base_url,
    trustedOrigins: [...config.trusted_origins],
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
    },
    session: {
      expiresIn: (config.session_days ?? 30) * SECONDS_PER_DAY,
    },
    advanced: {
      useSecureCookies: true,
      defaultCookieAttributes: {
        sameSite: "lax",
        secure: true,
        httpOnly: true,
      },
    },
    plugins: [
      passkey({
        rpID: config.rp_id,
        rpName: "Pi Wallpaper Engine",
        origin: config.base_url,
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email") return
        if (handle.isSetupComplete()) {
          throw new APIError("FORBIDDEN", {
            message: "Setup is already complete.",
          })
        }
        const expected = process.env[setupTokenEnv]
        if (!expected || expected.length < 8) {
          throw new APIError("FORBIDDEN", {
            message: `Setup unavailable: env ${setupTokenEnv} is not set.`,
          })
        }
        const provided = ctx.request?.headers.get("x-pwe-setup-token") ?? ""
        if (provided !== expected) {
          throw new APIError("FORBIDDEN", {
            message: "Invalid setup token.",
          })
        }
      }),
    },
  }

  const { runMigrations } = await getMigrations(options)
  await runMigrations()

  const instance = betterAuth(options)

  return {
    instance,
    handle,
    path: resolveAuthDbPath(),
    dispose: () => handle.dispose(),
  }
}
