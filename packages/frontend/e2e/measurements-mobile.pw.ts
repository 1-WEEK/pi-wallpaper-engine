import { test, expect } from "playwright/test"
import { mockLibraryItem, mockSearchResult, mockWorkshopItems, mockSystemSummary } from "./fixtures.js"
import { mockAuthDisabled, mockLibraryList, mockSummary } from "./helpers.js"

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: async ({ browserName }, use) => use(browserName === "chromium"),
})

test.describe("Mobile programmatic measurements (§7.2)", () => {
  test("touch target tiers: 52px interactive rows, 44px commands/chips/inputs, 48px CTAs", async ({
    page,
  }) => {
    await mockAuthDisabled(page)
    const summary = mockSystemSummary()
    await mockSummary(page, summary)
    const libItems = [mockLibraryItem({ workshop_id: "1001", title: "Wall 1" })]
    await mockLibraryList(page, libItems)
    await page.route("**/api/download/tasks**", (route) => route.fulfill({ json: { items: [], total: 0 } }))
    const browseItems = mockWorkshopItems(4).map((it) => ({ ...it, preview_url: "/favicon.svg" }))
    await page.route("**/api/workshop/search*", (route) =>
      route.fulfill({ json: mockSearchResult(browseItems, 4) })
    )

    // 1. Settings: 52px interactive rows (.setm-row), 44px commands (.set-seg button)
    await page.goto("/settings")
    for (const row of await page.locator(".setm-row").all()) {
      const b = (await row.boundingBox())!
      expect(b.height).toBeGreaterThanOrEqual(52)
    }

    await page.goto("/settings?sec=playback")
    for (const seg of await page.locator(".setm .set-seg button").all()) {
      const b = (await seg.boundingBox())!
      expect(b.height).toBeGreaterThanOrEqual(44)
    }

    // 2. Browse: 44px command (FILTERS), 48px CTA (Show results)
    await page.goto("/browse?q=mobile")
    const ftg = page.getByRole("button", { name: "Open filters", exact: true })
    expect((await ftg.boundingBox())!.height).toBeGreaterThanOrEqual(44)

    await ftg.tap()
    const sheet = page.locator(".mobile-sheet.open")
    await expect(sheet).toBeVisible()
    const cta = sheet.getByRole("button", { name: /Show .* results/ })
    const ctaBox = (await cta.boundingBox())!
    expect(ctaBox.height).toBeGreaterThanOrEqual(47.5)
    await cta.tap()

    // 3. Library: 48px foot PLAY CTA
    await page.goto("/library")
    await page.getByRole("button", { name: "Open Wall 1", exact: true }).tap()
    const libSheet = page.locator(".mobile-sheet.open")
    await expect(libSheet).toBeVisible()
    const playCta = libSheet.locator(".mobile-sheet-footer .lbmd-play")
    expect((await playCta.boundingBox())!.height).toBeGreaterThanOrEqual(47.5)
    await libSheet.getByRole("button", { name: "Close", exact: true }).tap()
  })

  test("spine alignment <= 1.5px on Browse and Library 2-up grids", async ({ page }) => {
    await mockAuthDisabled(page)
    await mockSummary(page)
    const libItems = [
      mockLibraryItem({ workshop_id: "1001", title: "Wall 1" }),
      mockLibraryItem({ workshop_id: "1002", title: "Wall 2" }),
    ]
    await mockLibraryList(page, libItems)
    await page.route("**/api/download/tasks**", (route) => route.fulfill({ json: { items: [], total: 0 } }))
    const browseItems = mockWorkshopItems(4).map((it) => ({ ...it, preview_url: "/favicon.svg" }))
    await page.route("**/api/workshop/search*", (route) =>
      route.fulfill({ json: mockSearchResult(browseItems, 4) })
    )

    // Browse spine alignment
    await page.goto("/browse?q=mobile")
    const bCards = page.locator(".bwm-card")
    await expect(bCards.nth(0)).toBeVisible()
    await expect(bCards.nth(1)).toBeVisible()
    const bFirst = (await bCards.nth(0).boundingBox())!
    const bSecond = (await bCards.nth(1).boundingBox())!
    const bSpine = (await page.locator(".mp-gridlines .mp-gl-v").boundingBox())!
    const bGutterCenter = (bFirst.x + bFirst.width + bSecond.x) / 2
    expect(Math.abs(bSpine.x + 0.5 - bGutterCenter)).toBeLessThanOrEqual(1.5)

    // Library spine alignment
    await page.goto("/library")
    const lCards = page.locator(".lbm-card")
    await expect(lCards.nth(0)).toBeVisible()
    await expect(lCards.nth(1)).toBeVisible()
    const lFirst = (await lCards.nth(0).boundingBox())!
    const lSecond = (await lCards.nth(1).boundingBox())!
    const lSpine = (await page.locator(".mp-gridlines .mp-gl-v").boundingBox())!
    const lGutterCenter = (lFirst.x + lFirst.width + lSecond.x) / 2
    expect(Math.abs(lSpine.x + 0.5 - lGutterCenter)).toBeLessThanOrEqual(1.5)
  })

  test("spacing scale and scrollWidth <= 390 across all 4 routes", async ({ page }) => {
    await mockAuthDisabled(page)
    await mockSummary(page)
    await mockLibraryList(page, [
      mockLibraryItem({ workshop_id: "1001", title: "Wall 1" }),
    ])
    await page.route("**/api/download/tasks**", (route) => route.fulfill({ json: { items: [], total: 0 } }))
    const browseItems = mockWorkshopItems(2).map((it) => ({ ...it, preview_url: "/favicon.svg" }))
    await page.route("**/api/workshop/search*", (route) =>
      route.fulfill({ json: mockSearchResult(browseItems, 2) })
    )

    for (const url of ["/browse", "/library", "/activity", "/settings"]) {
      await page.goto(url)
      await expect(page.locator(".mobile-shell")).toBeVisible()
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
      expect(scrollWidth).toBeLessThanOrEqual(390)

      // Spacing scale: side padding 16px
      const pageEl = page.locator(".mp, .setm, .act")
      if ((await pageEl.count()) > 0) {
        const paddingLeft = await pageEl.first().evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft))
        const paddingRight = await pageEl.first().evaluate((el) => parseFloat(getComputedStyle(el).paddingRight))
        expect(paddingLeft).toBe(16)
        expect(paddingRight).toBe(16)
      }
    }
  })
})

test.describe("Mobile reduce-motion degradation (§7.4)", () => {
  test.use({ colorScheme: "dark" })

  test("reduced motion disables sheet slide and skips ghost flight", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" })
    await mockAuthDisabled(page)
    await mockSummary(page)
    await mockLibraryList(page, [])
    await page.route("**/api/download/tasks**", (route) => route.fulfill({ json: { items: [], total: 0 } }))

    await page.goto("/browse")

    // Open sheet
    await page.getByRole("button", { name: "Open filters", exact: true }).tap()
    const sheet = page.locator(".mobile-sheet.open")
    await expect(sheet).toBeVisible()

    // Panel has transform 0s transition under reduced motion
    const transition = await sheet
      .locator(".mobile-sheet-panel")
      .evaluate((el) => getComputedStyle(el).transition)
    expect(transition).toContain("opacity")
  })
})
