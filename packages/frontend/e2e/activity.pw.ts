import { expect, test } from "playwright/test"
import { mockSystemSummary } from "./fixtures.js"

const summary = mockSystemSummary()

/** Boot the minimal mocks needed to render the app shell on the Activity page. */
const mockShellEndpoints = async (page: import("playwright").Page) => {
  await page.route("**/api/auth/setup-state", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ enabled: false, setup_complete: true }),
    })
  )
  await page.route("**/api/system/summary", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(summary) })
  )
  await page.route("**/api/download/tasks**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], total: 0 }) })
  )
}

test.describe("Activity routing", () => {
  test("canonical route is /activity", async ({ page }) => {
    await mockShellEndpoints(page)
    await page.goto("/activity", { waitUntil: "networkidle" })
    await expect(page).toHaveURL(/\/activity$/)
    await expect(page.locator("h1.page-title")).toHaveText("Activity")
    await expect(page.locator(".sidebar-link", { hasText: "Activity" })).toHaveClass(/active/)
  })

  test("legacy /downloads redirects to /activity", async ({ page }) => {
    await mockShellEndpoints(page)
    await page.goto("/downloads", { waitUntil: "networkidle" })
    await expect(page).toHaveURL(/\/activity$/)
    await expect(page.locator("h1.page-title")).toHaveText("Activity")
  })

  test("legacy /transcode redirects to /activity", async ({ page }) => {
    await mockShellEndpoints(page)
    await page.goto("/transcode", { waitUntil: "networkidle" })
    await expect(page).toHaveURL(/\/activity$/)
    await expect(page.locator("h1.page-title")).toHaveText("Activity")
  })
})
