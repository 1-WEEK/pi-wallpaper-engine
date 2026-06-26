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
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
  ],
})
