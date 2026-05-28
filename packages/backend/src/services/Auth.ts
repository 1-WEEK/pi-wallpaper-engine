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

const validateAuthConfig = (config: AuthConfig): void => {
  let baseUrl: URL
  try {
    baseUrl = new URL(config.base_url)
  } catch {
    throw new Error(`auth.base_url is not a valid URL: ${config.base_url}`)
  }
  if (config.rp_id !== baseUrl.host) {
    throw new Error(
      `auth.rp_id (${config.rp_id}) must equal the host of base_url (${baseUrl.host}). ` +
        `WebAuthn binds passkeys to rp_id; a mismatch causes login to fail with an opaque error.`
    )
  }
  const trustedOrigins = config.trusted_origins
    .map((o) => {
      try {
        return new URL(o).origin
      } catch {
        return null
      }
    })
    .filter((o): o is string => o !== null)
  if (!trustedOrigins.includes(baseUrl.origin)) {
    throw new Error(
      `auth.trusted_origins must include base_url's origin (${baseUrl.origin}). ` +
        `Got: [${trustedOrigins.join(", ")}]`
    )
  }
}

export const createAuth = async (config: AuthConfig): Promise<AuthService> => {
  validateAuthConfig(config)

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
        // Email/password sign-in is never the right path here. emailAndPassword
        // is enabled only so Better Auth can create the initial admin user
        // during /sign-up/email (which is gated by the setup token). After
        // that, the admin is meant to use passkeys exclusively. Refuse any
        // email/password sign-in attempt explicitly rather than leaving the
        // endpoint silently 401-ing against an unguessable random password.
        if (ctx.path === "/sign-in/email") {
          throw new APIError("FORBIDDEN", {
            message: "Email/password sign-in is disabled. Use a passkey.",
          })
        }

        if (ctx.path === "/sign-up/email") {
          // Setup is "complete" iff a passkey already exists. A bare user
          // without passkeys is treated as an abandoned setup and cleaned up
          // below, so the admin can retry without ssh+auth-reset.
          if (handle.hasAnyPasskey()) {
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
          // Token valid, no passkey yet. Delete any orphan user records left
          // from a prior abandoned attempt; otherwise Better Auth would reject
          // this sign-up with "email already exists" and the admin would be
          // locked out without DB-level recovery.
          for (const orphanId of handle.listOrphanUserIds()) {
            handle.deleteUser(orphanId)
          }
          return
        }

        if (ctx.path === "/passkey/verify-registration") {
          if (!instanceRef) return
          const session = await instanceRef.api
            .getSession({ headers: ctx.request?.headers ?? new Headers() })
            .catch(() => null)
          if (!session) return
          if (handle.countUserPasskeys(session.user.id) >= maxPasskeys) {
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
          if (handle.countUserPasskeys(session.user.id) <= 1) {
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
