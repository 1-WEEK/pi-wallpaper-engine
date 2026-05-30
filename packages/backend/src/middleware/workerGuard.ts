import { Elysia } from "elysia"

/**
 * Machine-to-machine auth for the Worker pull protocol. Distinct from
 * `sessionGuard` (which protects browser sessions) — the Worker is a
 * headless container that cannot hold passkey cookies, so it presents a
 * shared API key in `X-Worker-Key` instead.
 *
 * The shared secret is read from `PWE_WORKER_API_KEY` at startup. Operators
 * place it in `~/.config/pi-wallpaper-engine/auth.env` next to the
 * `PWE_AUTH_*` vars; `index.ts` auto-loads that file before the server boots.
 *
 * Boot fails fast if the env var is missing or empty — silently accepting
 * unsigned requests would be a security bug, not a fallback worth keeping.
 */
export const workerGuard = () => {
  const key = process.env["PWE_WORKER_API_KEY"]
  if (!key || key.length < 8) {
    throw new Error(
      "PWE_WORKER_API_KEY is required (≥8 chars) when /api/transcode/* routes are mounted. " +
        "Set it in ~/.config/pi-wallpaper-engine/auth.env or the systemd unit env."
    )
  }
  const expected = key

  return new Elysia({ name: "pwe-worker-guard" }).onBeforeHandle(
    { as: "scoped" },
    ({ request, set }) => {
      const provided = request.headers.get("x-worker-key")
      if (!provided || provided !== expected) {
        set.status = 401
        return { ok: false, error: "Worker authentication required." }
      }
    }
  )
}
