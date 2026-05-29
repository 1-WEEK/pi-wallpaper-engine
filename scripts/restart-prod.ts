#!/usr/bin/env bun
// Safe restart of the pi-wallpaper-engine systemd user service.
//   1. Refuse to restart on a dirty working tree (unless --force).
//   2. Snapshot the SQLite state db (db + db-shm + db-wal) before restart.
//   3. Health-check after restart; print a rollback hint if it fails.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const PROJECT_ROOT = "/home/one-week/Documents/pi-wallpaper-engine"
const STATE_DIR = join(homedir(), ".local/state/pi-wallpaper-engine")
const SNAPSHOT_DIR = join(STATE_DIR, "snapshots")
const HEALTH_URL = "http://localhost:8080/api/health"
const SERVICE = "pi-wallpaper-engine.service"
const SNAPSHOT_KEEP = 10
const DB_FILES = [
  "pi-wallpaper-engine.db",
  "pi-wallpaper-engine.db-shm",
  "pi-wallpaper-engine.db-wal",
] as const

const FORCE = process.argv.includes("--force")

const run = async (cmd: string[], opts: { cwd?: string } = {}): Promise<{ exit: number; stdout: string }> => {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const exit = await proc.exited
  return { exit, stdout }
}

// --- 1. dirty-tree guard ----------------------------------------------------
const { stdout: dirty } = await run(["git", "status", "--porcelain"], { cwd: PROJECT_ROOT })
if (dirty.trim() && !FORCE) {
  console.error("✗ working tree is dirty — refusing to restart.")
  console.error("  uncommitted changes:")
  for (const line of dirty.trimEnd().split("\n")) console.error(`    ${line}`)
  console.error("")
  console.error("  options:")
  console.error("    - commit first, then re-run")
  console.error("    - bun run service:restart -- --force   (skip this guard)")
  process.exit(1)
}

// --- 2. db snapshot ---------------------------------------------------------
const ts = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace("T", "-")
  .slice(0, 15) // YYYYMMDD-HHMMSS
const snap = join(SNAPSHOT_DIR, ts)
mkdirSync(snap, { recursive: true })
for (const f of DB_FILES) {
  const src = join(STATE_DIR, f)
  if (existsSync(src)) copyFileSync(src, join(snap, f))
}
console.log(`✓ db snapshot → ${snap}`)

// Trim old snapshots, keep the most recent SNAPSHOT_KEEP.
const all = existsSync(SNAPSHOT_DIR)
  ? readdirSync(SNAPSHOT_DIR)
      .filter((n) => /^\d{8}-\d{6}$/.test(n))
      .sort()
      .reverse()
  : []
for (const old of all.slice(SNAPSHOT_KEEP)) {
  rmSync(join(SNAPSHOT_DIR, old), { recursive: true, force: true })
}

// --- 3. restart + health check ---------------------------------------------
// Hard timeout in case systemctl hangs (would otherwise block forever).
const restart = run(["systemctl", "--user", "restart", SERVICE])
const timeout = new Promise<{ exit: number; stdout: string }>((_, reject) =>
  setTimeout(() => reject(new Error("systemctl timed out after 5s")), 5_000)
)
const { exit } = await Promise.race([restart, timeout]).catch((e) => {
  console.error(`✗ ${e.message}`)
  process.exit(1)
})
if (exit !== 0) {
  console.error(`✗ systemctl exited ${exit}`)
  process.exit(1)
}
console.log("✓ restart issued, waiting for health…")

const probe = async () => {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2_000) })
    return res.ok
  } catch {
    return false
  }
}

for (let i = 1; i <= 8; i++) {
  await Bun.sleep(1_000)
  if (await probe()) {
    console.log(`✓ health OK after ${i}s`)
    process.exit(0)
  }
}

console.error("")
console.error("✗ health check failed after 8s — service may be crashed or restarting.")
console.error(`  diagnose:    journalctl --user -u ${SERVICE} -n 80 --no-pager`)
console.error(`  rollback:    git reset --hard HEAD^ && bun run service:restart -- --force`)
console.error(`  db restore:  cp -a ${snap}/* ${STATE_DIR}/   (then restart)`)
process.exit(1)
