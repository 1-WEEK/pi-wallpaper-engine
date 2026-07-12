import { expect, test } from "playwright/test"
import { mockSystemSummary } from "./fixtures.js"

const summary = mockSystemSummary()

const mockLibraryItem = (id: string, overrides: Record<string, any> = {}) => ({
  workshop_id: id,
  title: `Wallpaper ${id}`,
  preview_url: `https://example.com/preview/${id}.jpg`,
  display_mode: "fill",
  source_resolution: "1920x1080",
  source_codec: "h264",
  source_size: 1024 * 1024 * 10,
  transcode_status: null,
  transcode_progress: 0,
  transcode_error: null,
  transcoded_path: null,
  transcoded_resolution: null,
  transcoded_codec: null,
  transcoded_size: null,
  ...overrides,
})

test.describe("Transcode Task List", () => {
  test("renders failed and completed items correctly and shows retry buttons", async ({ page }) => {
    // Mock endpoints
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
    await page.route("**/api/download/tasks", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: "[]" })
    )
    
    // Intercept library transcode response
    await page.route("**/api/library", (r) => {
      const items = [
        mockLibraryItem("111", {
          transcode_status: "completed",
          transcode_progress: 100,
          transcoded_resolution: "1920x1080",
          transcoded_codec: "hevc",
          transcoded_size: 1024 * 1024 * 5,
        }),
        mockLibraryItem("222", {
          transcode_status: "failed",
          transcode_error: "Mock failure",
        }),
        mockLibraryItem("333"), // Should be ignored because transcode_status is null
      ]
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(items) })
    })

    await page.goto("/transcode", { waitUntil: "networkidle" })

    // Verify UI renders them
    await expect(page.locator(".transcode-row")).toHaveCount(2)
    
    const completedItem = page.locator(".transcode-row").nth(0)
    await expect(completedItem.locator(".status-pill")).toHaveText("Completed")
    await expect(completedItem.locator(".transcode-codec-info")).toContainText("→ 1920x1080 • hevc")
    
    const failedItem = page.locator(".transcode-row").nth(1)
    await expect(failedItem.locator(".status-pill")).toHaveText("Failed")
    await expect(failedItem.locator(".transcode-message-error")).toHaveText("Mock failure")

    // Verify retry buttons exist
    await expect(page.locator("button:has-text('Retry All Failed')")).toBeVisible()
    await expect(failedItem.locator("button:has-text('Retry')")).toBeVisible()
    
    // Verify completed item does not have a retry button
    await expect(completedItem.locator("button:has-text('Retry')")).not.toBeVisible()
  })
})
