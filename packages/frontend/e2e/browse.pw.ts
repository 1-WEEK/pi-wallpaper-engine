import { expect, test } from "playwright/test"
import { mockSystemSummary, mockWorkshopItems } from "./fixtures.js"
import { computeColumns } from "./helpers.js"

const summary = mockSystemSummary()

/** Boot all the api mocks needed for any Browse test. */
const mockAllEndpoints = async (
  page: import("playwright").Page,
  searchHandler: (r: import("playwright").Route) => void
) => {
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
  await page.route("**/api/library", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" })
  )
  await page.route("**/api/download/tasks", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" })
  )
  await page.route("**/api/workshop/search*", searchHandler)
}

test.describe("Browse grid pagination", () => {
  test("useColumnsPerRow: column count matches at 1280px (3 cols)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const columns = computeColumns(1280)
    expect(columns).toBe(3)
    const expectedPageSize = Math.ceil(25 / columns) * columns

    const items = mockWorkshopItems(expectedPageSize)
    await mockAllEndpoints(page, (r) => {
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ total: expectedPageSize * 2, items, nextCursor: "AoJw" }),
      })
    })

    await page.goto("/browse?q=test", { waitUntil: "networkidle" })
    const grid = page.locator(".browse-grid")
    await expect(grid.locator(".wallpaper-card")).toHaveCount(expectedPageSize, { timeout: 15000 })
    expect(await grid.locator(".wallpaper-card").count()).toBe(27)
    expect(27 % columns).toBe(0)
  })

  test("useColumnsPerRow: column count matches at 1600px (5 cols)", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 800 })
    expect(computeColumns(1600)).toBe(5)
    const expectedPageSize = Math.ceil(25 / 5) * 5

    await mockAllEndpoints(page, (r) => {
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          total: expectedPageSize * 2,
          items: mockWorkshopItems(expectedPageSize),
          nextCursor: "AoJw",
        }),
      })
    })

    await page.goto("/browse?q=test", { waitUntil: "networkidle" })
    const grid = page.locator(".browse-grid")
    await expect(grid.locator(".wallpaper-card")).toHaveCount(expectedPageSize, { timeout: 15000 })
    expect((await grid.locator(".wallpaper-card").count()) % 5).toBe(0)
  })

  test("useColumnsPerRow: column count matches at 1920px (6 cols)", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 800 })
    expect(computeColumns(1920)).toBe(6)
    const expectedPageSize = Math.ceil(25 / 6) * 6

    await mockAllEndpoints(page, (r) => {
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          total: expectedPageSize * 2,
          items: mockWorkshopItems(expectedPageSize),
          nextCursor: "AoJw",
        }),
      })
    })

    await page.goto("/browse?q=test", { waitUntil: "networkidle" })
    const grid = page.locator(".browse-grid")
    await expect(grid.locator(".wallpaper-card")).toHaveCount(expectedPageSize, { timeout: 15000 })
    expect((await grid.locator(".wallpaper-card").count()) % 6).toBe(0)
  })

  test("load-more also loads a page-size multiple of columns", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const columns = computeColumns(1280)
    const expectedPageSize = Math.ceil(25 / columns) * columns

    await mockAllEndpoints(page, (r) => {
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          total: expectedPageSize * 3,
          items: mockWorkshopItems(expectedPageSize),
          nextCursor: "cursor-1",
        }),
      })
    })

    await page.goto("/browse?q=test", { waitUntil: "networkidle" })

    const grid = page.locator(".browse-grid")
    await expect(grid.locator(".wallpaper-card")).toHaveCount(expectedPageSize, { timeout: 15000 })

    const loadMore = page.locator(".load-more button")
    await expect(loadMore).toBeVisible({ timeout: 5000 })
    await expect(loadMore).toBeEnabled()
    await loadMore.click()

    await expect(grid.locator(".wallpaper-card")).toHaveCount(expectedPageSize * 2, { timeout: 15000 })
    expect((await grid.locator(".wallpaper-card").count()) % columns).toBe(0)
  })

  test("resize: pageSize recomputes and refetches rows at the new column count", async ({ page }) => {
    // 1) Start narrow (1280px -> 3 cols, pageSize=27)
    await page.setViewportSize({ width: 1280, height: 800 })
    const colsA = computeColumns(1280)
    const pageSizeA = Math.ceil(25 / colsA) * colsA

    const capturedPageSizes: number[] = []

    await mockAllEndpoints(page, (r) => {
      const url = new URL(r.request().url())
      const pageSizeParam = parseInt(url.searchParams.get("pageSize") ?? "25", 10)
      capturedPageSizes.push(pageSizeParam)

      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          total: pageSizeParam * 4,
          items: mockWorkshopItems(pageSizeParam),
          nextCursor: `cursor-${capturedPageSizes.length}`,
        }),
      })
    })

    await page.goto("/browse?q=test", { waitUntil: "networkidle" })
    const grid = page.locator(".browse-grid")
    await expect(grid.locator(".wallpaper-card")).toHaveCount(pageSizeA, { timeout: 15000 })

    // 2) Resize to wide (1920px -> 6 cols); pageSize is part of the SWR key,
    // so the first page refetches at the new pageSize instead of reusing 27.
    await page.setViewportSize({ width: 1920, height: 800 })
    const colsB = computeColumns(1920)
    const pageSizeB = Math.ceil(25 / colsB) * colsB
    expect(pageSizeB).toBe(30)

    await expect(grid.locator(".wallpaper-card")).toHaveCount(pageSizeB, { timeout: 15000 })

    // 3) Load more after resize; the next page also uses the new pageSize.
    await expect(page.locator(".load-more button")).toBeVisible({ timeout: 5000 })
    await expect(page.locator(".load-more button")).toBeEnabled()
    await page.locator(".load-more button").click()

    await expect(grid.locator(".wallpaper-card")).toHaveCount(pageSizeB * 2, { timeout: 15000 })

    expect(capturedPageSizes[0]).toBe(pageSizeA)
    expect(capturedPageSizes).toContain(pageSizeB)
    expect(capturedPageSizes[capturedPageSizes.length - 1]).toBe(pageSizeB)

    expect(pageSizeA % colsA).toBe(0)
    expect(pageSizeB % colsB).toBe(0)
  })
})
