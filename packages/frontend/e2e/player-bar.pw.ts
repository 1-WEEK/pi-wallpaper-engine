import { expect, test } from "playwright/test"
import type { Page } from "playwright"
import type { SystemSummary } from "@pwe/shared"
import { mockSystemSummary } from "./fixtures.js"
import { mockAuthDisabled, mockLibraryList } from "./helpers.js"

const playingSummary = (): SystemSummary => {
  const summary = mockSystemSummary()
  summary.status.player = {
    ...summary.status.player,
    playing: true,
    current_workshop_id: "1693728660",
    current_title: "Neon City",
    current_resolution: "1920x1080",
    current_codec: "hevc",
  }
  return summary
}

/** Summary is served from a mutable ref so actions can change what the next poll sees. */
const mockAllEndpoints = async (page: Page, summaryRef: { value: SystemSummary }) => {
  await mockAuthDisabled(page)
  await mockLibraryList(page, [])
  await page.route("**/api/system/summary", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(summaryRef.value),
    })
  )
  await page.route("**/api/workshop/search*", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ total: 0, items: [] }),
    })
  )
}

test.describe("PlayerBar", () => {
  test("shows the current wallpaper and transport state", async ({ page }) => {
    await mockAllEndpoints(page, { value: playingSummary() })
    await page.goto("/browse")

    const dock = page.locator(".player-dock")
    await expect(dock.locator(".player-title")).toHaveText("Neon City")
    await expect(dock.locator(".player-subtitle")).toContainText("looping")
    await expect(dock.locator(".player-codec")).toContainText("1920x1080 · hevc")
    await expect(dock.getByRole("button", { name: "Pause playback" })).toBeEnabled()
  })

  test("idle player disables current-item controls", async ({ page }) => {
    await mockAllEndpoints(page, { value: mockSystemSummary() })
    await page.goto("/browse")

    const dock = page.locator(".player-dock")
    await expect(dock.locator(".player-title")).toHaveText("No wallpaper selected")
    await expect(dock.getByRole("button", { name: "Stop playback" })).toBeDisabled()
    await expect(dock.getByRole("button", { name: "Resume playback" })).toBeDisabled()
    // Next/prev drive rotation and stay usable without a current item.
    await expect(dock.getByRole("button", { name: "Next wallpaper" })).toBeEnabled()
  })

  test("pause posts to the API and the bar reflects the paused state", async ({ page }) => {
    const summaryRef = { value: playingSummary() }
    await mockAllEndpoints(page, summaryRef)

    let pausePosted = false
    await page.route("**/api/player/pause", (r) => {
      pausePosted = true
      const next = playingSummary()
      next.status.player.playing = false
      summaryRef.value = next
      return r.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })

    await page.goto("/browse")
    await page.getByRole("button", { name: "Pause playback" }).click()

    await expect.poll(() => pausePosted).toBe(true)
    // onRefresh refetches the summary, which now reports paused.
    await expect(page.getByRole("button", { name: "Resume playback" })).toBeVisible()
    await expect(page.locator(".player-subtitle")).toContainText("paused")
  })

  test("display mode segmented posts the chosen mode", async ({ page }) => {
    const summaryRef = { value: playingSummary() }
    await mockAllEndpoints(page, summaryRef)

    let postedMode: string | null = null
    await page.route("**/api/player/display-mode", (r) => {
      postedMode = (r.request().postDataJSON() as { mode: string }).mode
      const next = playingSummary()
      next.status.player.display_mode = "fit"
      summaryRef.value = next
      return r.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })

    await page.goto("/browse")
    const segmented = page.locator(".player-right .segmented")
    await segmented.getByRole("button", { name: "fit" }).click()

    await expect.poll(() => postedMode).toBe("fit")
    await expect(segmented.getByRole("button", { name: "fit" })).toHaveClass(/active/)
  })
})
