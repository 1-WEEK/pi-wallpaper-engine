import { expect, test } from "playwright/test"
import type { Page } from "playwright"
import { mockSystemSummary } from "./fixtures.js"

const mockAllEndpoints = async (page: Page) => {
  await page.route("**/api/auth/setup-state", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ enabled: false, setup_complete: true }),
    })
  )
  const summary = mockSystemSummary()
  summary.status.library.total = 7
  await page.route("**/api/system/summary", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(summary) })
  )
  await page.route("**/api/library", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" })
  )
  await page.route("**/api/storage", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: true,
        data_root: "/mock/data",
        default_root: "/mock/data",
        using_default: true,
        last_error: null,
        migration: null,
      }),
    })
  )
  await page.route("**/api/download/tasks**", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], total: 0 }),
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

test.describe("Desktop shell", () => {
  test("sidebar navigates between pages and marks the active link", async ({ page }) => {
    await mockAllEndpoints(page)
    await page.goto("/browse")

    const nav = page.locator(".sidebar-nav")
    await expect(nav.locator(".sidebar-link")).toHaveCount(4)
    await expect(nav.locator(".sidebar-link.active")).toHaveText(/Browse/)

    await nav.getByRole("link", { name: "Library" }).click()
    await expect(page).toHaveURL(/\/library$/)
    await expect(page.locator("h1.page-title")).toHaveText("Library")
    await expect(nav.locator(".sidebar-link.active")).toHaveText(/Library/)

    await nav.getByRole("link", { name: "Settings" }).click()
    await expect(page.locator("h1.page-title")).toHaveText("Settings")
  })

  test("sidebar shows Pi status and the library badge from the summary", async ({ page }) => {
    await mockAllEndpoints(page)
    await page.goto("/browse")

    const status = page.locator(".sidebar-status")
    await expect(status.getByText("1920×1080")).toBeVisible()
    await expect(status.getByText("idle")).toBeVisible()
    // library.total = 7 surfaces as the nav badge.
    await expect(page.locator(".sidebar-link", { hasText: "Library" }).locator(".sidebar-badge")).toHaveText("7")
  })

  test("unknown routes land on Browse", async ({ page }) => {
    await mockAllEndpoints(page)
    await page.goto("/definitely-not-a-page")
    // Browse may append its default tag filter to the URL after landing.
    await expect(page).toHaveURL(/\/browse/)
  })
})

test.describe("Mobile shell", () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test("tab bar replaces the sidebar and navigates", async ({ page }) => {
    await mockAllEndpoints(page)
    await page.goto("/browse")

    await expect(page.locator(".mobile-shell")).toBeVisible()
    await expect(page.locator(".shell-sidebar")).toHaveCount(0)

    const tabBar = page.locator(".mobile-tab-bar")
    await expect(tabBar).toBeVisible()
    await tabBar.getByRole("link", { name: /Library/ }).click()
    await expect(page).toHaveURL(/\/library$/)
  })
})
