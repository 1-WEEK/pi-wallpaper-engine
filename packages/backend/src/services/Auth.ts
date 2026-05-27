import { betterAuth, type BetterAuthOptions } from "better-auth"
import { APIError, createAuthMiddleware } from "better-auth/api"
import { getMigrations } from "better-auth/db/migration"
import { passkey } from "@better-auth/passkey"
import type { AuthConfig } from "@pwe/shared"
import { openAuthDb, resolveAuthDbPath, type AuthDbHandle } from "../db/AuthDb.js"

const SECONDS_PER_DAY = 86400
const DEFAULT_MAX_PASSKEYS = 3

export interface AuthService {
  readonly instance: ReturnType<typeof betterAuth>
  readonly handle: AuthDbHandle
  readonly path: string
  readonly maxPasskeys: number
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
  const maxPasskeys = config.max_passkeys ?? DEFAULT_MAX_PASSKEYS

  const handle = openAuthDb()

  // Captured after betterAuth() returns; safe to use inside hooks which fire
  // at request time, after init has completed.
  let instanceRef: ReturnType<typeof betterAuth> | null = null

  const countUserPasskeys = (userId: string): number => {
    const row = handle.db
      .prepare<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM passkey WHERE userId = ?")
      .get(userId)
    return row?.n ?? 0
  }

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
        if (ctx.path === "/sign-up/email") {
          if (handle.isSetupComplete()) {
            throw new APIError("FORBIDDEN", { message: "Setup is already complete." })
          }
          const expected = process.env[setupTokenEnv]
          if (!expected || expected.length < 8) {
            throw new APIError("FORBIDDEN", {
              message: `Setup unavailable: env ${setupTokenEnv} is not set.`,
            })
          }
          const provided = ctx.request?.headers.get("x-pwe-setup-token") ?? ""
          if (provided !== expected) {
            throw new APIError("FORBIDDEN", { message: "Invalid setup token." })
          }
          return
        }

        if (ctx.path === "/passkey/verify-registration") {
          if (!instanceRef) return
          const session = await instanceRef.api
            .getSession({ headers: ctx.request?.headers ?? new Headers() })
            .catch(() => null)
          if (!session) return
          if (countUserPasskeys(session.user.id) >= maxPasskeys) {
            throw new APIError("FORBIDDEN", {
              message: `Passkey limit reached (${maxPasskeys}). Remove an existing passkey first.`,
            })
          }
          return
        }

        if (ctx.path === "/passkey/delete-passkey") {
          if (!instanceRef) return
          const session = await instanceRef.api
            .getSession({ headers: ctx.request?.headers ?? new Headers() })
            .catch(() => null)
          if (!session) return
          if (countUserPasskeys(session.user.id) <= 1) {
            throw new APIError("FORBIDDEN", {
              message:
                "Cannot delete your last passkey — you would be locked out. Register a second passkey first.",
            })
          }
          return
        }
      }),
    },
  }

  const { runMigrations } = await getMigrations(options)
  await runMigrations()

  const instance = betterAuth(options)
  instanceRef = instance

  return {
    instance,
    handle,
    path: resolveAuthDbPath(),
    maxPasskeys,
    dispose: () => handle.dispose(),
  }
}
