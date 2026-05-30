import { Elysia } from "elysia"
import staticPlugin from "@elysiajs/static"
import { existsSync, readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { makeRuntime, getConfig } from "./runtime.js"
import { workshopRoutes } from "./routes/workshop.js"
import { libraryRoutes } from "./routes/library.js"
import { playerRoutes } from "./routes/player.js"
import { downloadRoutes } from "./routes/download.js"
import { displayRoutes } from "./routes/display.js"
import { storageRoutes } from "./routes/storage.js"
import { systemRoutes } from "./routes/system.js"
import { transcodeRoutes } from "./routes/transcode.js"
import { buildAuthHandler } from "./routes/auth.js"
import { createAuth, type AuthService } from "./services/Auth.js"
import { originGuard } from "./middleware/originGuard.js"
import { sessionGuard } from "./middleware/sessionGuard.js"
import { authRateLimit } from "./middleware/authRateLimit.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = resolve(__dirname, "../../..")
const CONFIG_DIR = resolve(homedir(), ".config/pi-wallpaper-engine")
const DEFAULT_CONFIG_PATH = resolve(CONFIG_DIR, "config.json")
const CONFIG_PATH = process.env["PWE_CONFIG"] ?? DEFAULT_CONFIG_PATH
const FRONTEND_DIST = resolve(PROJECT_ROOT, "packages/frontend/dist")

// Auto-load auth.env so dev mode and direct launches work outside systemd too.
const AUTH_ENV_PATH = resolve(CONFIG_DIR, "auth.env")
if (existsSync(AUTH_ENV_PATH)) {
  for (const line of readFileSync(AUTH_ENV_PATH, "utf-8").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    const key = trimmed.slice(0, eq)
    const value = trimmed.slice(eq + 1)
    if (process.env[key] === undefined) process.env[key] = value
  }
}

if (!existsSync(CONFIG_PATH)) {
  console.error(`✗ Config not found: ${CONFIG_PATH}`)
  console.error("  Run install-pi.sh, or copy config.example.json to ~/.config/pi-wallpaper-engine/config.json and edit it.")
  process.exit(1)
}

const runtime = makeRuntime(CONFIG_PATH)

let config: Awaited<ReturnType<typeof getConfig>>
try {
  config = await getConfig(runtime)
} catch (e) {
  console.error("✗ Failed to load config:", e instanceof Error ? e.message : String(e))
  await runtime.dispose()
  process.exit(1)
}

let auth: AuthService | null = null
if (config.auth?.enabled) {
  try {
    auth = await createAuth(config.auth)
  } catch (e) {
    console.error("✗ Failed to initialize auth:", e instanceof Error ? e.message : String(e))
    await runtime.dispose()
    process.exit(1)
  }
}

const app = new Elysia()
  .onError(({ code, error, request, set }) => {
    if (code === "NOT_FOUND") {
      const url = new URL(request.url)
      const accept = request.headers.get("accept") ?? ""
      const wantsHtml = accept.includes("text/html")
      const isApi = url.pathname.startsWith("/api/")
      const isAsset = url.pathname.startsWith("/assets/")
      if (wantsHtml && !isApi && !isAsset && existsSync(FRONTEND_DIST)) {
        set.status = 200
        set.headers["content-type"] = "text/html; charset=utf-8"
        return Bun.file(`${FRONTEND_DIST}/index.html`)
      }
      set.status = 404
      return { error: "Not found" }
    }
    console.error("Unhandled route error:", error)
    set.status = 500
    return { error: error instanceof Error ? error.message : String(error) }
  })
  .get("/api/health", () => ({ ok: true, version: "0.1.0" }))

if (auth && config.auth) {
  app.use(originGuard(config.auth))
  app.use(authRateLimit())
  // Bind the Better Auth handler under /api/auth/*. The `.all()` line catches
  // every HTTP method via memoirist's ALL-trie fallback. The explicit `.get()`
  // is needed only because `staticPlugin({ prefix: "/" })` registers a GET
  // catch-all (`/*`) further down — memoirist looks up routes per-method, so
  // for GET it finds the static plugin's wildcard first and never falls back
  // to the ALL trie. A same-method, more-specific GET route here wins the
  // per-method match and pre-empts the shadowing. Other methods (POST/PUT/
  // DELETE/PATCH/OPTIONS/HEAD) are not registered by staticPlugin, so their
  // tries miss and Elysia falls back to ALL cleanly.
  const authHandler = buildAuthHandler(auth, config.auth)
  const forward = ({ request }: { request: Request }) => authHandler(request)
  app.get("/api/auth/*", forward)
  app.all("/api/auth/*", forward)
  app.use(sessionGuard(auth))
} else {
  app.get("/api/auth/setup-state", () => ({ enabled: false, setup_complete: false }))
}

app
  .use(workshopRoutes(runtime))
  .use(libraryRoutes(runtime))
  .use(playerRoutes(runtime))
  .use(downloadRoutes(runtime, auth))
  .use(displayRoutes(runtime))
  .use(storageRoutes(runtime))
  .use(systemRoutes(runtime))

// Mount Worker pull endpoints only when PWE_WORKER_API_KEY is configured.
// Without the key the backend boots fine for browsing/playback, but new
// downloads that decideTranscode flags will sit in `pending` until both the
// key is set AND a Worker is running.
const workerKey = process.env["PWE_WORKER_API_KEY"]
if (workerKey && workerKey.length >= 8) {
  app.use(transcodeRoutes(runtime))
} else {
  console.warn(
    "⚠ PWE_WORKER_API_KEY not set (or <8 chars). /api/transcode/* routes are not mounted; new transcode jobs will queue but no Worker can claim them. Set the key in ~/.config/pi-wallpaper-engine/auth.env to enable."
  )
}

if (existsSync(FRONTEND_DIST)) {
  app.use(staticPlugin({ assets: FRONTEND_DIST, prefix: "/" }))
} else {
  console.warn(
    `⚠ Frontend dist not found at ${FRONTEND_DIST}. Run 'bun run build' to build the UI.`
  )
  app.get("/", () => ({
    message:
      "Frontend not built. Run `bun run build` from project root. API is available under /api/*.",
  }))
}

const server = app.listen({ hostname: config.server.host, port: config.server.port })

console.log(`▶ pi-wallpaper-engine listening on http://${config.server.host}:${config.server.port}`)
console.log(`  Config: ${CONFIG_PATH}`)
console.log(`  Data root: ${config.paths.data_root}`)
console.log(`  Media root: ${config.storage.root ?? config.paths.data_root}`)
if (auth) {
  console.log(`  Auth: enabled (db ${auth.path}, setup ${auth.handle.hasAnyPasskey() ? "complete" : "pending"})`)
} else {
  console.log("  Auth: disabled (config.auth.enabled is false or absent)")
}

const shutdown = async (signal: string) => {
  console.log(`\n${signal} received, shutting down...`)
  await server.stop()
  if (auth) auth.dispose()
  await runtime.dispose()
  process.exit(0)
}

process.on("SIGINT", () => void shutdown("SIGINT"))
process.on("SIGTERM", () => void shutdown("SIGTERM"))
