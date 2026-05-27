#!/usr/bin/env bun
import { existsSync, rmSync } from "node:fs"
import { resolveAuthDbPath } from "../src/db/AuthDb.js"

const FORCE = process.argv.includes("--yes") || process.argv.includes("-y")

const path = resolveAuthDbPath()
const targets = [path, `${path}-shm`, `${path}-wal`].filter((p) => existsSync(p))

if (targets.length === 0) {
  console.log(`No auth database found at ${path}. Nothing to do.`)
  process.exit(0)
}

console.log("This will permanently delete the following files:")
for (const t of targets) console.log(`  - ${t}`)
console.log(
  "All registered passkeys and the admin account will be removed.\n" +
    "You will need PWE_AUTH_SETUP_TOKEN set in the environment again to redo first-run setup."
)

if (!FORCE) {
  console.log("\nRe-run with --yes to confirm:")
  console.log("  bun run --filter @pwe/backend auth:reset -- --yes")
  process.exit(2)
}

for (const t of targets) {
  rmSync(t, { force: true })
  console.log(`  removed ${t}`)
}
console.log("\nDone. Restart the backend and complete setup again.")
