#!/usr/bin/env bun
/**
 * Preflight diagnostic. Runs every sanity check that would otherwise blow up
 * at runtime, with actionable remediation for each failure. Exits 0 if
 * everything passes, 1 otherwise.
 */
import { Schema } from "effect"
import { existsSync, readFileSync, statSync, accessSync, constants } from "node:fs"
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { Config as ConfigSchema } from "@pwe/shared"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = resolve(__dirname, "../../..")
const CONFIG_PATH = process.env["PWE_CONFIG"] ?? resolve(PROJECT_ROOT, "config.json")

type Result =
  | { kind: "pass"; label: string; detail?: string }
  | { kind: "fail"; label: string; detail: string; fix: string }
  | { kind: "warn"; label: string; detail: string }

const results: Result[] = []

const pass = (label: string, detail?: string) =>
  results.push(detail ? { kind: "pass", label, detail } : { kind: "pass", label })
const fail = (label: string, detail: string, fix: string) =>
  results.push({ kind: "fail", label, detail, fix })
const warn = (label: string, detail: string) =>
  results.push({ kind: "warn", label, detail })

const expandHome = (p: string): string =>
  p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p)

const args = new Set(process.argv.slice(2))
const fixDirs = args.has("--fix-dirs")

console.log("Pi Wallpaper Engine — Preflight\n" + "─".repeat(36))

// 1. Config file present + parses + schema valid
let config: typeof ConfigSchema.Type | null = null
if (!existsSync(CONFIG_PATH)) {
  fail(
    "Config file",
    `Not found at ${CONFIG_PATH}`,
    "Copy config.example.json to config.json and fill in steam.username + steam.web_api_key + paths.data_root"
  )
} else {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8")
    const parsed = JSON.parse(raw)
    config = Schema.decodeUnknownSync(ConfigSchema)(parsed)
    pass("Config valid", CONFIG_PATH)
  } catch (e) {
    fail(
      "Config valid",
      e instanceof Error ? e.message : String(e),
      "Check config.json against config.example.json — likely missing or invalid field"
    )
  }
}

// 2. Bun version
const bunVersion = Bun.version
if (bunVersion) {
  const [maj, min] = bunVersion.split(".").map((n) => parseInt(n, 10))
  if ((maj ?? 0) > 1 || ((maj ?? 0) === 1 && (min ?? 0) >= 1)) {
    pass("Bun version", bunVersion)
  } else {
    fail(
      "Bun version",
      `Have ${bunVersion}, need >= 1.1.0`,
      "Upgrade Bun: curl -fsSL https://bun.sh/install | bash"
    )
  }
} else {
  fail("Bun version", "Could not detect", "Run `bun --version` manually")
}

// Helper: run command and check exit 0
async function checkBinary(
  label: string,
  cmd: string[],
  fixHint: string
): Promise<{ ok: boolean; out: string }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    if (code === 0) {
      const firstLine = (stdout || stderr).split("\n")[0]?.trim() ?? ""
      pass(label, firstLine)
      return { ok: true, out: stdout }
    } else {
      fail(label, `Exit code ${code}: ${stderr.slice(0, 200)}`, fixHint)
      return { ok: false, out: stderr }
    }
  } catch (e) {
    fail(label, e instanceof Error ? e.message : String(e), fixHint)
    return { ok: false, out: "" }
  }
}

// 3-5. Binaries
await checkBinary(
  "mpv binary",
  [config?.mpv.binary_path ?? "mpv", "--version"],
  "sudo apt install -y mpv"
)
await checkBinary(
  "SteamCMD binary",
  [config?.steam.steamcmd_path ?? "/usr/games/steamcmd", "+quit"],
  "sudo apt install -y steamcmd (and accept the Valve license prompt)"
)
await checkBinary("ffprobe", ["ffprobe", "-version"], "sudo apt install -y ffmpeg")

// 6. data_root exists + writable
if (config) {
  const dataRoot = expandHome(config.paths.data_root)
  if (!existsSync(dataRoot)) {
    if (fixDirs) {
      try {
        mkdirSync(dataRoot, { recursive: true })
        pass("data_root", `${dataRoot} (created)`)
      } catch (e) {
        fail(
          "data_root",
          `Cannot create ${dataRoot}: ${e instanceof Error ? e.message : String(e)}`,
          `Check parent directory permissions, or pass --fix-dirs`
        )
      }
    } else {
      fail(
        "data_root",
        `${dataRoot} does not exist`,
        `Create it: mkdir -p ${dataRoot}  (or re-run with --fix-dirs)`
      )
    }
  } else {
    try {
      accessSync(dataRoot, constants.R_OK | constants.W_OK)
      pass("data_root", dataRoot)
    } catch {
      fail(
        "data_root",
        `${dataRoot} exists but is not readable/writable`,
        `chown to current user, or pick a different paths.data_root`
      )
    }
  }

  // 7. data_root writable check via temp file
  if (existsSync(dataRoot)) {
    const probe = resolve(dataRoot, `.preflight-${Date.now()}.tmp`)
    try {
      writeFileSync(probe, "ok")
      unlinkSync(probe)
      pass("data_root writable")
    } catch (e) {
      fail(
        "data_root writable",
        e instanceof Error ? e.message : String(e),
        `chmod u+rw ${dataRoot}`
      )
    }

    // 8. source / optimized subdirs
    for (const sub of [config.paths.source_dir, config.paths.optimized_dir]) {
      const subAbs = resolve(dataRoot, sub)
      if (existsSync(subAbs)) {
        pass(`${sub}/ exists`)
      } else {
        try {
          mkdirSync(subAbs, { recursive: true })
          pass(`${sub}/ created`)
        } catch (e) {
          fail(
            `${sub}/ directory`,
            e instanceof Error ? e.message : String(e),
            `mkdir -p ${subAbs}`
          )
        }
      }
    }
  }
}

// 9. Steam Web API key valid
if (config?.steam.web_api_key) {
  try {
    const u = new URL("https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/")
    u.searchParams.set("key", config.steam.web_api_key)
    u.searchParams.set("query_type", "9")
    u.searchParams.set("numperpage", "1")
    u.searchParams.set("appid", "431960")
    u.searchParams.set("filetype", "0")
    const res = await fetch(u.toString())
    if (res.ok) {
      pass("Steam Web API key", `HTTP ${res.status}`)
    } else {
      fail(
        "Steam Web API key",
        `HTTP ${res.status}`,
        "Register a key at https://steamcommunity.com/dev/apikey and set steam.web_api_key in config.json"
      )
    }
  } catch (e) {
    warn(
      "Steam Web API key",
      `Cannot reach Steam API: ${e instanceof Error ? e.message : String(e)}`
    )
  }
}

// 10. SteamCMD has been logged in.
// SteamCMD on Linux stores auth in ~/Steam/config/config.vdf, with the username
// as a key under the "Accounts" block once login succeeds.
if (config?.steam.username) {
  const configVdfPath = resolve(homedir(), "Steam/config/config.vdf")
  if (existsSync(configVdfPath)) {
    try {
      const contents = readFileSync(configVdfPath, "utf-8")
      const userTag = `"${config.steam.username}"`
      if (contents.includes(userTag)) {
        pass("SteamCMD logged in", `user ${config.steam.username}`)
      } else {
        warn(
          "SteamCMD logged in",
          `Steam/config/config.vdf has no Accounts entry for ${config.steam.username} — first run will need 2FA`
        )
      }
    } catch {
      warn("SteamCMD logged in", "Cannot read Steam/config/config.vdf")
    }
  } else {
    warn(
      "SteamCMD logged in",
      "Never logged in. Run: " + (config.steam.steamcmd_path ?? "steamcmd") + " +login " + config.steam.username
    )
  }
}

// 11. Server port free
if (config) {
  try {
    const probeServer = Bun.serve({
      port: config.server.port,
      hostname: config.server.host,
      fetch: () => new Response("probe"),
    })
    probeServer.stop()
    pass("Port free", `${config.server.host}:${config.server.port}`)
  } catch (e) {
    fail(
      "Port free",
      `${config.server.host}:${config.server.port} unavailable: ${e instanceof Error ? e.message : String(e)}`,
      `Change config.server.port or stop the conflicting process`
    )
  }
}

// 12. SQLite writable at data_root
if (config) {
  const dataRoot = expandHome(config.paths.data_root)
  if (existsSync(dataRoot)) {
    const dbPath = resolve(dataRoot, ".preflight-sqlite.db")
    try {
      const { Database } = await import("bun:sqlite")
      const db = new Database(dbPath, { create: true })
      db.exec("CREATE TABLE IF NOT EXISTS t (n INTEGER); DROP TABLE t;")
      db.close()
      try {
        unlinkSync(dbPath)
      } catch {
        // ignore
      }
      pass("SQLite writable")
    } catch (e) {
      fail(
        "SQLite writable",
        e instanceof Error ? e.message : String(e),
        `Check ${dataRoot} permissions`
      )
    }
  }
}

// 13. mpv hardware decode — requires DISPLAY; downgrade to warn if headless
if (config && process.env["DISPLAY"] === undefined && process.env["WAYLAND_DISPLAY"] === undefined) {
  warn("mpv hwdec check", "No DISPLAY/WAYLAND_DISPLAY — skipped (run from a graphical session)")
} else if (config) {
  const sampleAsset = resolve(__dirname, "test-assets/sample-1080p.mp4")
  if (!existsSync(sampleAsset)) {
    warn(
      "mpv hwdec check",
      `Test asset missing at ${sampleAsset} — generate with ffmpeg (see install-pi.sh)`
    )
  } else {
    try {
      const proc = Bun.spawn(
        [
          config.mpv.binary_path,
          `--hwdec=${config.mpv.hwdec}`,
          `--gpu-api=${config.mpv.gpu_api}`,
          "--vo=null",
          "--frames=10",
          "--msg-level=all=info",
          sampleAsset,
        ],
        { stdout: "pipe", stderr: "pipe", stdin: "ignore" }
      )
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      await proc.exited
      const out = stdout + stderr
      if (/Using hardware decoding/i.test(out) || /\(hw\)/i.test(out)) {
        pass("mpv hwdec", "hardware decoding active")
      } else if (/Failed to initialize/i.test(out) || /unsupported/i.test(out)) {
        warn(
          "mpv hwdec",
          `hwdec=${config.mpv.hwdec} not active — falling back to software. Try different mpv.hwdec value.`
        )
      } else {
        warn("mpv hwdec", "Could not confirm hardware decode from mpv output")
      }
    } catch (e) {
      warn("mpv hwdec", e instanceof Error ? e.message : String(e))
    }
  }
}

console.log("")
for (const r of results) {
  if (r.kind === "pass") {
    console.log(`✓ ${r.label}${r.detail ? ` — ${r.detail}` : ""}`)
  } else if (r.kind === "warn") {
    console.log(`⚠ ${r.label} — ${r.detail}`)
  } else {
    console.log(`✗ ${r.label} — ${r.detail}`)
    console.log(`  → ${r.fix}`)
  }
}

const failures = results.filter((r) => r.kind === "fail").length
const warnings = results.filter((r) => r.kind === "warn").length

console.log("")
console.log(`${failures} failed, ${warnings} warning${warnings === 1 ? "" : "s"}`)
process.exit(failures > 0 ? 1 : 0)

// Use writeFileSync export so eslint doesn't complain about unused import
void writeFileSync
void statSync
