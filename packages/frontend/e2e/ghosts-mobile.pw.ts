import { test, expect } from "playwright/test"
import { mockLibraryItem, mockSearchResult, mockWorkshopItems, mockSystemSummary } from "./fixtures.js"
import { mockAuthDisabled, mockLibraryList, mockSummary } from "./helpers.js"

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: async ({ browserName }, use) => use(browserName === "chromium"),
})

test.describe("Mobile cross-page ghosts (ticket 06)", () => {
  test("download receipt: Browse detail ADD flies thumbnail into TabBar Library item, then navpulse fires", async ({
    page,
  }) => {
    await mockAuthDisabled(page)
    await mockSummary(page)
    await mockLibraryList(page, [])
    await page.route("**/api/download/tasks**", (route) =>
      route.fulfill({ json: { items: [], total: 0 } })
    )
    await page.route("**/api/download/3000000000", (route) =>
      route.fulfill({ json: { ok: true, task_id: "dl-1" } })
    )
    const items = mockWorkshopItems(5).map((item) => ({ ...item, preview_url: "/favicon.svg" }))
    await page.route("**/api/workshop/search*", (route) => {
      return route.fulfill({
        json: mockSearchResult(items, items.length),
      })
    })

    await page.goto("/browse?q=mobile")
    await page.getByRole("button", { name: "Open Wallpaper 1", exact: true }).tap()
    const sheet = page.locator(".mobile-sheet.open")
    await expect(sheet).toBeVisible()

    const navLibrary = page.locator('.mobile-tab-bar-item[data-nav="library"]')
    await expect(navLibrary).toBeVisible()

    const dlBtn = sheet.getByRole("button", { name: /DOWNLOAD/ })
    await dlBtn.tap()

    // Nav item receives the .nav-pulse class and animates mp-navpulse
    await expect(navLibrary).toHaveClass(/nav-pulse/, { timeout: 2000 })
    const icon = navLibrary.locator(".mobile-tab-bar-icon")
    await expect(icon).toHaveCSS("animation-name", "mp-navpulse")

    // The pulse retires after 1.4s
    await expect(navLibrary).not.toHaveClass(/nav-pulse/, { timeout: 4000 })
  })

  test("PLAY ghost: Library detail foot PLAY closes sheet, flies hero media to MiniPlayer thumb, then navpulse fires", async ({
    page,
  }) => {
    await mockAuthDisabled(page)
    const item = mockLibraryItem({
      workshop_id: "1693728660",
      title: "Neon City",
      transcode_status: "completed",
      preview_url: "/favicon.svg",
    })
    const summary = mockSystemSummary()
    summary.status.player.current_workshop_id = "1693728660"
    summary.status.player.current_preview_url = "/favicon.svg"
    await mockSummary(page, summary)
    await mockLibraryList(page, [item])
    await page.route("**/api/download/tasks**", (route) =>
      route.fulfill({ json: { items: [], total: 0 } })
    )
    await page.route("**/api/player/play/1693728660", (route) =>
      route.fulfill({ json: { ok: true } })
    )

    await page.goto("/library")
    const card = page.getByRole("button", { name: "Open Neon City", exact: true })
    await card.tap()

    const sheet = page.locator(".mobile-sheet.open")
    await expect(sheet).toBeVisible()

    const playBtn = sheet.locator(".mobile-sheet-footer .lbmd-play")
    await playBtn.tap()

    // Sheet closes
    await expect(page.locator(".mobile-sheet.open")).toHaveCount(0)

    // MiniPlayer thumb receives .nav-pulse class and plays mp-navpulse-thumb
    const thumb = page.locator(".mobile-mini-player-thumb")
    await expect(thumb).toHaveClass(/nav-pulse/, { timeout: 2000 })
    await expect(thumb).toHaveCSS("animation-name", "mp-navpulse-thumb")

    // The pulse retires
    await expect(thumb).not.toHaveClass(/nav-pulse/, { timeout: 4000 })
  })

  test("<120px distance skips flight directly to landing pulse", async ({ page }) => {
    await page.goto("/browse")
    const result = await page.evaluate(async () => {
      // Browser context evaluation requires in-browser dynamic import for the client module bundle.
      const { flyGhost } = await import("./src/ghost.js")
      flyGhost({
        from: new DOMRect(100, 100, 40, 40),
        to: new DOMRect(120, 120, 40, 40), // distance ~28px (<120px)
        onDone: () => {
          pulseRan = true
        },
      })
      // Ghost element should NOT have been appended to DOM
      const ghostAppended = document.querySelectorAll("img[style*='fixed'], div[style*='fixed']").length > 0
      return { pulseRan, ghostAppended }
    })

    expect(result.pulseRan).toBe(true)
    expect(result.ghostAppended).toBe(false)
  })

  test("reduce-motion: ghost does not initialize, instant cut + landing pulse preserved", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" })
    await mockAuthDisabled(page)
    await mockSummary(page)
    await mockLibraryList(page, [])
    await page.route("**/api/download/tasks**", (route) =>
      route.fulfill({ json: { items: [], total: 0 } })
    )
    await page.route("**/api/download/3000000000", (route) =>
      route.fulfill({ json: { ok: true, task_id: "dl-1" } })
    )
    const items = mockWorkshopItems(2).map((item) => ({ ...item, preview_url: "/favicon.svg" }))
    await page.route("**/api/workshop/search*", (route) => {
      return route.fulfill({
        json: mockSearchResult(items, items.length),
      })
    })

    await page.goto("/browse?q=mobile")
    await page.getByRole("button", { name: "Open Wallpaper 1", exact: true }).tap()
    const sheet = page.locator(".mobile-sheet.open")
    await expect(sheet).toBeVisible()

    const navLibrary = page.locator('.mobile-tab-bar-item[data-nav="library"]')
    const dlBtn = sheet.getByRole("button", { name: /DOWNLOAD/ })
    await dlBtn.tap()

    // No ghost spawned
    expect(await page.locator("img[style*='fixed']").count()).toBe(0)

    // Landing pulse is PRESERVED per spec §5.1 table
    await expect(navLibrary).toHaveClass(/nav-pulse/, { timeout: 2000 })
  })
})
