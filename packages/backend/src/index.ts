import { Elysia } from "elysia"
import staticPlugin from "@elysiajs/static"
import { existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { makeRuntime, getConfig } from "./runtime.js"
import { workshopRoutes } from "./routes/workshop.js"
import { libraryRoutes } from "./routes/library.js"
import { playerRoutes } from "./routes/player.js"
import { downloadRoutes } from "./routes/download.js"
import { displayRoutes } from "./routes/display.js"
import { storageRoutes } from "./routes/storage.js"
import { systemRoutes } from "./routes/system.js"
import { authRoutes } from "./routes/auth.js"
import { createAuth, type AuthService } from "./services/Auth.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = resolve(__dirname, "../../..")
const CONFIG_PATH = process.env["PWE_CONFIG"] ?? resolve(PROJECT_ROOT, "config.json")
const FRONTEND_DIST = resolve(PROJECT_ROOT, "packages/frontend/dist")

if (!existsSync(CONFIG_PATH)) {
  console.error(`✗ Config not found: ${CONFIG_PATH}`)
  console.error("  Run install-pi.sh, or copy config.example.json to config.json and edit it.")
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

if (auth) {
  app.use(authRoutes(auth))
} else {
  app.get("/api/auth/setup-state", () => ({ enabled: false, setup_complete: false }))
}

app
  .use(workshopRoutes(runtime))
  .use(libraryRoutes(runtime))
  .use(playerRoutes(runtime))
  .use(downloadRoutes(runtime))
  .use(displayRoutes(runtime))
  .use(storageRoutes(runtime))
  .use(systemRoutes(runtime))

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
  console.log(`  Auth: enabled (db ${auth.path}, setup ${auth.handle.isSetupComplete() ? "complete" : "pending"})`)
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
