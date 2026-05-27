import { Elysia } from "elysia"

interface Rule {
  readonly match: (pathname: string, method: string) => boolean
  readonly limit: number
  readonly windowMs: number
  readonly label: string
}

const RULES: ReadonlyArray<Rule> = [
  {
    label: "sign-up",
    match: (p, m) => m === "POST" && p === "/api/auth/sign-up/email",
    limit: 5,
    windowMs: 60_000,
  },
  {
    label: "sign-in",
    match: (p, m) => m === "POST" && p.startsWith("/api/auth/sign-in/"),
    limit: 20,
    windowMs: 60_000,
  },
  {
    label: "passkey-auth",
    match: (p, m) => m === "POST" && p.startsWith("/api/auth/passkey/verify-"),
    limit: 30,
    windowMs: 60_000,
  },
]

const HISTORY_CAP = 1024
const SWEEP_INTERVAL_MS = 5 * 60_000

const clientKey = (request: Request): string => {
  const forwarded = request.headers.get("x-forwarded-for")
  if (forwarded) return forwarded.split(",")[0]!.trim()
  const cfIp = request.headers.get("cf-connecting-ip")
  if (cfIp) return cfIp.trim()
  return "anon"
}

export const authRateLimit = () => {
  const buckets = new Map<string, number[]>()
  let lastSweep = Date.now()

  const sweep = (now: number) => {
    if (now - lastSweep < SWEEP_INTERVAL_MS) return
    lastSweep = now
    const cutoff = now - 60_000
    for (const [key, hits] of buckets) {
      const fresh = hits.filter((t) => t > cutoff)
      if (fresh.length === 0) buckets.delete(key)
      else buckets.set(key, fresh)
    }
  }

  return new Elysia({ name: "pwe-auth-rate-limit" }).onBeforeHandle(
    { as: "global" },
    ({ request, set }) => {
      const url = new URL(request.url)
      const pathname = url.pathname
      const method = request.method
      const rule = RULES.find((r) => r.match(pathname, method))
      if (!rule) return

      const now = Date.now()
      sweep(now)
      const key = `${rule.label}:${clientKey(request)}`
      const cutoff = now - rule.windowMs
      const hits = (buckets.get(key) ?? []).filter((t) => t > cutoff)
      if (hits.length >= rule.limit) {
        set.status = 429
        set.headers["retry-after"] = String(Math.ceil(rule.windowMs / 1000))
        return { ok: false, error: `Too many ${rule.label} requests. Wait a minute.` }
      }
      hits.push(now)
      if (hits.length > HISTORY_CAP) hits.splice(0, hits.length - HISTORY_CAP)
      buckets.set(key, hits)
    }
  )
}
