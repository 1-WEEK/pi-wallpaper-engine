import { expect, test } from "playwright/test"
import type { Page } from "playwright"
import type { LibraryItem } from "@pwe/shared"
import { mockLibraryItem, mockSystemSummary } from "./fixtures.js"

const mockAllEndpoints = async (page: Page, items: LibraryItem[]) => {
  await page.route("**/api/auth/setup-state", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ enabled: false, setup_complete: true }),
    })
  )
  await page.route("**/api/system/summary", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mockSystemSummary()),
    })
  )
  await page.route("**/api/library", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(items) })
  )
}

test.describe("Library page", () => {
  test("renders cards with badges matching transcode state", async ({ page }) => {
    await mockAllEndpoints(page, [
      mockLibraryItem(),
      mockLibraryItem({
        workshop_id: "222",
        title: "Rainy Window",
        transcode_status: "failed",
        transcoded_path: null,
        transcoded_size: null,
        transcode_error: "ffmpeg exited 1",
      }),
    ])

    await page.goto("/library")
    const cards = page.locator(".library-card")
    await expect(cards).toHaveCount(2)

    // Completed card shows the space-saved badge (100MB vs 500MB → 80%).
    const completedCard = cards.filter({ hasText: "Neon City" })
    await expect(completedCard.locator(".library-card-badge")).toHaveText(/saved 80%/)

    // Failed card shows the status badge and a Transcode retry action.
    const failedCard = cards.filter({ hasText: "Rainy Window" })
    await expect(failedCard.locator(".library-card-badge")).toHaveText("failed")
    await expect(failedCard.getByRole("button", { name: "Transcode this wallpaper" })).toBeVisible()
  })

  test("list view shows the same rows", async ({ page }) => {
    await mockAllEndpoints(page, [mockLibraryItem()])
    await page.goto("/library")
    await expect(page.locator(".library-card")).toHaveCount(1)

    await page.getByRole("button", { name: "List" }).click()
    await expect(page.locator(".library-row")).toHaveCount(1)
    await expect(page.locator(".library-row-title-text")).toHaveText("Neon City")
  })

  test("Preview opens a stream-backed player only for completed items", async ({ page }) => {
    await mockAllEndpoints(page, [
      mockLibraryItem(),
      mockLibraryItem({
        workshop_id: "222",
        title: "Rainy Window",
        transcode_status: "failed",
        transcoded_path: null,
      }),
    ])

    await page.route("**/api/library/1693728660/stream", (r) =>
      r.fulfill({ status: 200, contentType: "video/mp4", body: "x" })
    )

    await page.goto("/library")
    const cards = page.locator(".library-card")
    await expect(cards).toHaveCount(2)

    // Only the completed card offers Preview.
    await expect(
      page.getByRole("button", { name: "Preview this wallpaper in the browser" })
    ).toHaveCount(1)
    await expect(
      cards.filter({ hasText: "Rainy Window" }).getByRole("button", { name: /Preview/ })
    ).toHaveCount(0)

    await page.getByRole("button", { name: "Preview this wallpaper in the browser" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText("Neon City")).toBeVisible()

    // The player must point at the streaming endpoint. (The Range/206/auth
    // contract of that endpoint is covered by backend route tests; this
    // headless build has no media stack, so it never actually fetches.)
    const video = dialog.locator("video.video-preview-player")
    await expect(video).toHaveAttribute("src", "/api/library/1693728660/stream")

    // Simulate the media error a real browser fires when it can't decode
    // HEVC — the overlay must swap to the polite notice, not crash.
    await video.evaluate((el) => el.dispatchEvent(new Event("error")))
    await expect(dialog.locator(".video-preview-error")).toBeVisible()
    await expect(dialog.locator(".video-preview-error")).toContainText("HEVC")

    // Closing tears the overlay down.
    await page.getByRole("button", { name: "Close preview" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
  })
})
