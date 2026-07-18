import { expect, test } from "playwright/test"
import type { Page } from "playwright"
import { mockSystemSummary } from "./fixtures.js"

const mockStorageStatus = () => ({
  available: true,
  data_root: "/mock/data",
  default_root: "/mock/data",
  using_default: true,
  last_error: null,
  migration: null,
})

const mockAllEndpoints = async (page: Page) => {
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
  await page.route("**/api/storage", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mockStorageStatus()),
    })
  )
  await page.route("**/api/library", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" })
  )
}

test.describe("Settings page", () => {
  test("renders config groups from the system summary", async ({ page }) => {
    await mockAllEndpoints(page)
    await page.goto("/settings")

    await expect(page.locator("h1.page-title")).toHaveText("Settings")
    for (const group of ["Steam credentials", "Display", "Sleep timer", "Rotation interval", "mpv"]) {
      await expect(page.locator(".settings-group-title", { hasText: group })).toBeVisible()
    }
    // Values come from the mocked summary, not placeholders.
    await expect(page.getByText("abc***")).toBeVisible()
    const mpvGroup = page.locator(".settings-group", { hasText: "mpv" })
    await expect(mpvGroup.getByText("auto")).toBeVisible()
    await expect(mpvGroup.getByText("opengl")).toBeVisible()
  })

  test("sleep preset posts minutes to the API", async ({ page }) => {
    await mockAllEndpoints(page)

    let postedMinutes: number | null = null
    await page.route("**/api/player/sleep", (r) => {
      postedMinutes = (r.request().postDataJSON() as { minutes: number }).minutes
      return r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ active: true, deadline: Date.now() + 30 * 60_000 }),
      })
    })

    await page.goto("/settings")
    // "30m" exists in both Sleep timer and Rotation interval — scope to sleep.
    const sleepGroup = page.locator(".settings-group", { hasText: "Sleep timer" })
    await sleepGroup.getByRole("button", { name: "30m", exact: true }).click()
    await expect.poll(() => postedMinutes).toBe(30)
  })

  test("rotation preset posts seconds to the API", async ({ page }) => {
    await mockAllEndpoints(page)

    let postedSeconds: number | null = null
    await page.route("**/api/player/interval", (r) => {
      postedSeconds = (r.request().postDataJSON() as { seconds: number }).seconds
      return r.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })

    await page.goto("/settings")
    const rotationGroup = page.locator(".settings-group", { hasText: "Rotation interval" })
    await rotationGroup.getByRole("button", { name: "5m", exact: true }).click()
    await expect.poll(() => postedSeconds).toBe(300)
  })
})
