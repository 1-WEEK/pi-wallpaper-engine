import { expect, test } from "playwright/test"
import type { Page } from "playwright"
import { mockSystemSummary } from "./fixtures.js"
import { mockAuthDisabled, mockLibraryList, mockSummary } from "./helpers.js"

const mockAllEndpoints = async (page: Page) => {
  await mockAuthDisabled(page)
  const summary = mockSystemSummary()
  await mockSummary(page, summary)
  await mockLibraryList(page, [])
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
  test("rail navigates between pages and marks the active link", async ({ page }) => {
    await mockAllEndpoints(page)
    await page.goto("/browse")

    const nav = page.locator(".rail-nav")
    await expect(nav.locator(".rail-nav-link")).toHaveCount(4)
    await expect(nav.locator(".rail-nav-link.is-here")).toHaveText(/Browse/)

    await nav.getByRole("link", { name: "Library" }).click()
    await expect(page).toHaveURL(/\/library$/)
    await expect(page.locator("h1.lib-title")).toContainText("Library")
    await expect(nav.locator(".rail-nav-link.is-here")).toHaveText(/Library/)

    await nav.getByRole("link", { name: "Settings" }).click()
    await expect(page.locator("h1.set-title")).toContainText("Settings")
  })

  test("rail shows the live activity task count", async ({ page }) => {
    await mockAuthDisabled(page)
    const summary = mockSystemSummary()
    summary.status.downloads.active = 3
    await mockSummary(page, summary)
    await mockLibraryList(page, [])
    await page.goto("/browse")

    await expect(
      page.locator(".rail-nav-link", { hasText: "Activity" }).locator(".rail-nav-count")
    ).toHaveText("3")
  })

  test("theme switch: AUTO follows the OS, manual choice overrides and persists", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" })
    await mockAllEndpoints(page)
    await page.goto("/browse")
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")

    // Manual choice overrides the system …
    await page.getByRole("button", { name: "[A]", exact: true }).click()
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light")

    // … and persists across reloads (inline boot script, no flash).
    await page.reload()
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light")

    // Back to AUTO: follows the OS again, live.
    await page.getByRole("button", { name: "[AUTO]", exact: true }).click()
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
    await page.emulateMedia({ colorScheme: "light" })
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
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

  test("tab bar replaces the rail and navigates", async ({ page }) => {
    await mockAllEndpoints(page)
    await page.goto("/browse")

    await expect(page.locator(".mobile-shell")).toBeVisible()
    await expect(page.locator(".rail")).toHaveCount(0)

    const tabBar = page.locator(".mobile-tab-bar")
    await expect(tabBar).toBeVisible()
    await tabBar.getByRole("link", { name: /Library/ }).click()
    await expect(page).toHaveURL(/\/library$/)
  })
})
