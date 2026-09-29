import { defineConfig } from "playwright/test"

export default defineConfig({
  testDir: "./packages/frontend/e2e",
  testMatch: "**/*.pw.ts",
  retries: 0,
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
  },
  webServer: {
    command: "bun run dev:frontend",
    port: 5173,
    reuseExistingServer: true,
    // Cold vite boots (fresh optimize-deps) can exceed the 60s default.
    timeout: 120_000,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    // WebKit (Safari engine) verification (spec §11): opt-in via
    // PWE_E2E_WEBKIT=1 — the bundled webkit build needs libevent,
    // libharfbuzz-icu, libmanette and libhyphen on Linux (or macOS), so it
    // stays out of the default gate.
    ...(process.env.PWE_E2E_WEBKIT
      ? [{ name: "webkit", use: { browserName: "webkit" as const } }]
      : []),
  ],
})
