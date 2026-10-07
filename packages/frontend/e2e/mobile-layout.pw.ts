import { test, expect } from "playwright/test"
import type { Locator, Page } from "playwright"
import type { ActivityTask } from "@pwe/shared"
import { mockSearchResult, mockWorkshopItems } from "./fixtures.js"
import { mockAuthDisabled, mockLibraryList, mockSummary } from "./helpers.js"

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  // Mobile WebKit rejects wheel input and exposes no trusted touch drag API.
  isMobile: async ({ browserName }, use) => use(browserName === "chromium"),
})

const bootBrowse = async (page: Page, total = 25) => {
  await mockAuthDisabled(page)
  await mockSummary(page)
  await mockLibraryList(page, [])
  await page.route("**/api/download/tasks**", (route) =>
    route.fulfill({ json: { items: [], total: 0 } })
  )
  const items = mockWorkshopItems(total).map((item) => ({ ...item, preview_url: "/favicon.svg" }))
  await page.route("**/api/workshop/search*", (route) => {
    const url = new URL(route.request().url())
    const offset = Number(url.searchParams.get("cursor")) || 0
    const pageSize = Number(url.searchParams.get("pageSize")) || 25
    const nextOffset = offset + pageSize
    return route.fulfill({ json: mockSearchResult(
      items.slice(offset, nextOffset), items.length,
      nextOffset < items.length ? String(nextOffset) : undefined
    ) })
  })
  await page.goto("/browse?q=mobile")
  await expect(page.getByRole("button", { name: "Open Wallpaper 25", exact: true })).toBeAttached()
}

// Chromium exposes trusted touch drags via CDP. WebKit's public automation
// interface supports native wheel scrolling but only taps for touch input.
const scrollGesture = async (
  page: Page,
  target: Locator,
  browserName: string,
  direction = 1
) => {
  const box = await target.boundingBox()
  expect(box).not.toBeNull()
  const viewport = page.viewportSize()!
  const top = Math.max(0, box!.y)
  const bottom = Math.min(viewport.height, box!.y + box!.height)
  const distance = (bottom - top) * 0.6
  const x = box!.x + box!.width / 2
  const y = direction > 0 ? bottom - (bottom - top) * 0.2 : top + (bottom - top) * 0.2
  if (browserName !== "chromium") {
    await page.mouse.move(x, y)
    await page.mouse.wheel(0, direction * distance)
    return
  }
  const session = await page.context().newCDPSession(page)
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart", touchPoints: [{ x, y }],
    })
    for (let step = 1; step <= 12; step++) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove", touchPoints: [{ x, y: y - direction * distance * step / 12 }],
      })
      await page.waitForTimeout(16)
    }
    // Release a stopped drag so a later tap cannot be consumed by a fling.
    await page.waitForTimeout(150)
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  } finally {
    await session.detach()
  }
}

const expectChromeInViewport = async (page: Page) => {
  for (const selector of [".mobile-top-bar", ".mobile-main", ".mobile-mini-player", ".mobile-tab-bar"]) {
    const chrome = page.locator(selector)
    await expect(chrome).toBeVisible()
    await expect.poll(async () => (await chrome.boundingBox())!.y).toBeGreaterThanOrEqual(0)
    await expect.poll(async () => {
      const bounds = (await chrome.boundingBox())!
      return bounds.y + bounds.height
    }).toBeLessThanOrEqual(page.viewportSize()!.height + 1)
    const bounds = (await chrome.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1)
  }
}

const scrollToEdge = async (page: Page, target: Locator, browserName: string, edge: "start" | "end" = "end") => {
  const remaining = () => target.evaluate(
    (el, edge) => edge === "start" ? el.scrollTop : el.scrollHeight - el.clientHeight - el.scrollTop,
    edge
  )
  await expect.poll(async () => {
    if (await remaining() > 2) await scrollGesture(page, target, browserName, edge === "end" ? 1 : -1)
    return remaining()
  }, { timeout: 20_000, intervals: [100] }).toBeLessThanOrEqual(2)
}

test("long Browse lists scroll while navigation and player stay visible", async ({ page, browserName }) => {
  await bootBrowse(page)
  const main = page.locator(".mobile-main")
  expect(await main.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(800)
  await expectChromeInViewport(page)
  await scrollGesture(page, main, browserName)
  await expect.poll(() => main.evaluate((el) => el.scrollTop)).toBeGreaterThan(100)
  await expectChromeInViewport(page)
})

test("safe-area spacing protects navigation as the visible viewport changes", async ({ page }) => {
  await bootBrowse(page)
  // Desktop automation has no Home indicator; exercise representative insets.
  await page.addStyleTag({ content: ".mobile-shell { --mobile-safe-top: 47px; --mobile-safe-bottom: 34px; }" })
  for (const height of [844, 640, 780]) {
    await page.setViewportSize({ width: 390, height })
    await expectChromeInViewport(page)
    const tabs = page.locator(".mobile-tab-bar-item")
    for (const tab of await tabs.all()) {
      await expect.poll(async () => {
        const box = await tab.boundingBox()
        return box!.y + box!.height
      }).toBeLessThanOrEqual(height - 34)
    }
    expect((await page.locator(".mobile-top-bar").boundingBox())!.y).toBeGreaterThanOrEqual(47)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  }
})

test("sheets protect bottom actions and Browse scrolling resumes after dismissal", async ({ page, browserName }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 390, height: 460 })
  await bootBrowse(page)
  await page.addStyleTag({ content: ".mobile-shell { --mobile-safe-top: 47px; --mobile-safe-bottom: 34px; }" })
  await page.route("**/api/player/**", (route) => route.fulfill({ json: {} }))
  await page.route("**/api/download/3*", (route) => route.fulfill({ json: { ok: true } }))

  for (const kind of ["filters", "detail", "player"]) {
    const main = page.locator(".mobile-main")
    await main.evaluate((el) => el.scrollTo(0, 0))
    if (kind === "filters") await page.getByRole("button", { name: "Open filters", exact: true }).tap()
    else if (kind === "detail") await page.getByRole("button", { name: "Open Wallpaper 1", exact: true }).tap()
    else await page.getByRole("button", { name: "Open player controls" }).tap()

    const sheet = page.locator(".mobile-sheet.open")
    const body = sheet.locator(".mobile-sheet-body")
    await expect(sheet).toHaveCount(1)
    await expect.poll(async () => (await sheet.locator(".mobile-sheet-panel").boundingBox())!.y)
      .toBeGreaterThanOrEqual(47)
    await expect.poll(async () => {
      const box = await body.boundingBox()
      return box!.y + box!.height
    }).toBeLessThanOrEqual(460 - 34)
    await scrollToEdge(page, body, browserName)
    const action = kind === "filters"
      ? sheet.getByRole("button", { name: /Show .* results/ })
      : kind === "detail"
        ? sheet.getByRole("button", { name: /DOWNLOAD/ })
        : sheet.getByRole("radiogroup", { name: "Play limit repeat mode" }).getByRole("radio").last()
    await expect(action).toBeInViewport({ ratio: 1 })
    await action.tap()
    if (kind !== "filters") await sheet.getByRole("button", { name: "Close", exact: true }).tap()
    await expect(page.locator(".mobile-sheet.open")).toHaveCount(0)
    const before = await main.evaluate((el) => el.scrollTop)
    await scrollGesture(page, main, browserName)
    await expect.poll(() => main.evaluate((el) => el.scrollTop)).toBeGreaterThan(before + 50)
  }
})

test("phone rotation keeps mobile controls and sheets inside the viewport", async ({ page, browserName }) => {
  await bootBrowse(page)
  await page.setViewportSize({ width: 844, height: 390 })
  await expect(page.locator(".mobile-shell")).toBeVisible()
  await expectChromeInViewport(page)
  await page.addStyleTag({ content: ".mobile-shell { --mobile-safe-top: 0px; --mobile-safe-right: 47px; --mobile-safe-bottom: 21px; --mobile-safe-left: 47px; }" })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(844)
  const main = page.locator(".mobile-main")
  await scrollGesture(page, main, browserName)
  await expect.poll(() => main.evaluate((el) => el.scrollTop)).toBeGreaterThan(50)
  await page.getByRole("button", { name: "Open player controls" }).tap()
  const sheet = page.locator(".mobile-sheet.open")
  await expect.poll(async () => (await sheet.locator(".mobile-sheet-panel").boundingBox())!.y)
    .toBeGreaterThanOrEqual(0)
  const body = sheet.locator(".mobile-sheet-body")
  await scrollToEdge(page, body, browserName)
  const lastAction = sheet.getByRole("radiogroup", { name: "Play limit repeat mode" }).getByRole("radio").last()
  const actionBox = (await lastAction.boundingBox())!
  expect(actionBox.x).toBeGreaterThanOrEqual(47)
  expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(844 - 47)
  expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(390 - 21)
  await page.screenshot({ path: test.info().outputPath("landscape-player.png") })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(sheet).toBeVisible()
  await sheet.getByRole("button", { name: "Close", exact: true }).tap()
  await expectChromeInViewport(page)
  const before = await main.evaluate((el) => el.scrollTop)
  await scrollGesture(page, main, browserName)
  await expect.poll(() => main.evaluate((el) => el.scrollTop)).toBeGreaterThan(before + 50)
})

test("appended results remain reachable and scrolling works after leaving Browse", async ({ page, browserName }) => {
  test.setTimeout(90_000)
  await bootBrowse(page, 50)
  await page.addStyleTag({ content: ".mobile-shell { --mobile-safe-top: 47px; --mobile-safe-bottom: 34px; }" })
  const main = page.locator(".mobile-main")
  await scrollToEdge(page, main, browserName)
  const firstEnd = await main.evaluate((el) => el.scrollTop)
  await page.getByRole("button", { name: /LOAD MORE/ }).tap()
  const last = page.getByRole("button", { name: "Open Wallpaper 50", exact: true })
  await expect(last).toBeAttached()
  await scrollGesture(page, main, browserName)
  await expect.poll(() => main.evaluate((el) => el.scrollTop)).toBeGreaterThan(firstEnd + 50)
  await scrollToEdge(page, main, browserName)
  await expect(last).toBeInViewport({ ratio: 1 })
  const lastBox = (await last.boundingBox())!
  const mainBox = (await main.boundingBox())!
  expect(lastBox.y).toBeGreaterThanOrEqual(mainBox.y)
  expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(mainBox.y + mainBox.height + 1)
  await expectChromeInViewport(page)
  await page.screenshot({ path: test.info().outputPath("portrait-last-item.png") })
  await last.tap()
  const sheet = page.locator(".mobile-sheet.open")
  await expect(sheet.locator(".mobile-sheet-title")).toHaveText("Wallpaper 50")
  await sheet.getByRole("button", { name: "Close", exact: true }).tap()
  const end = await main.evaluate((el) => el.scrollTop)
  await scrollGesture(page, main, browserName, -1)
  await expect.poll(() => main.evaluate((el) => el.scrollTop)).toBeLessThan(end - 50)
  await scrollToEdge(page, main, browserName, "start")
  await expect(page.getByRole("button", { name: "Open Wallpaper 1", exact: true })).toBeInViewport({ ratio: 1 })

  const tabs = page.locator(".mobile-tab-bar")
  await tabs.getByRole("link", { name: /Library/ }).tap()
  await expect(page).toHaveURL(/\/library$/)
  await tabs.getByRole("link", { name: /Browse/ }).tap()
  await expect(page).toHaveURL(/\/browse\?q=mobile$/)
  await expect(page.getByRole("button", { name: "Open Wallpaper 25", exact: true })).toBeAttached()
  await main.evaluate((el) => el.scrollTo(0, 0))
  await scrollGesture(page, main, browserName)
  await expect.poll(() => main.evaluate((el) => el.scrollTop)).toBeGreaterThan(100)
})

test("long Activity queues keep the Queue sheet anchored to the mobile shell", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 390, height: 460 })
  await mockAuthDisabled(page)
  await mockSummary(page)
  const tasks: ActivityTask[] = Array.from({ length: 25 }, (_, index) => ({
    task_id: `task-${index}`,
    task_type: "transcode",
    workshop_id: String(3000000000 + index),
    title: `Wallpaper ${index + 1}`,
    preview_url: "",
    content_rating: "Everyone",
    rating_sex: null,
    adult_hint: 0,
    stage: "complete",
    message: "",
    started_at: 1_700_000_000_000,
    finished_at: 1_700_000_060_000,
    percent: 100,
    bytes_done: null,
    bytes_total: null,
  }))
  await page.route("**/api/download/tasks**", (route) => {
    const active = new URL(route.request().url()).searchParams.get("active") === "1"
    const items = active ? [] : tasks
    return route.fulfill({ json: { items, total: items.length } })
  })
  await page.goto("/activity")
  await expect(page.locator(".act-row")).toHaveCount(25)
  await page.addStyleTag({ content: ".mobile-shell { --mobile-safe-top: 47px; --mobile-safe-bottom: 34px; }" })
  const main = page.locator(".mobile-main")
  expect(await main.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(800)
  await page.getByRole("button", { name: "QUEUE\u2026", exact: true }).tap()
  const sheet = page.locator(".mobile-sheet.open")
  const body = sheet.locator(".mobile-sheet-body")
  await expect.poll(async () => {
    const box = (await body.boundingBox())!
    return box.y + box.height
  }).toBeLessThanOrEqual(460 - 34)
  await scrollToEdge(page, body, browserName)
  const lastAction = sheet.getByRole("button", { name: "All", exact: true })
  // The segment clips its rounded button corners; measure the outer control.
  await expect(sheet.locator(".mpm-seg")).toBeInViewport({ ratio: 1 })
  await lastAction.tap()
  await expect(lastAction).toHaveAttribute("aria-pressed", "true")
  await sheet.getByRole("button", { name: "Close", exact: true }).tap()
  await scrollGesture(page, main, browserName)
  await expect.poll(() => main.evaluate((el) => el.scrollTop)).toBeGreaterThan(50)
  await expectChromeInViewport(page)
})

test.describe("Browse mobile (ticket 02)", () => {
  test("mode-aware head shows RESULTS / {MODE} and the ITEMS readout", async ({ page }) => {
    await bootBrowse(page)
    await expect(page.locator(".mp-title")).toHaveText("Results / Trending")
    await expect(page.locator(".mp-count")).toHaveText("25 ITEMS")
    // No double wayfinding declaration: TabBar owns Browse.
    await expect(page.locator(".mp-title")).not.toContainText("Workshop")
  })

  test("FILTERS — n mono command replaces the filters pill", async ({ page }) => {
    await bootBrowse(page)
    await expect(page.locator(".bwm-filters-pill")).toHaveCount(0)
    const ftg = page.getByRole("button", { name: "Open filters", exact: true })
    await expect(ftg).toContainText("FILTERS")
    await expect(ftg.locator(".bwm-ftg-n")).toBeHidden()
    await ftg.tap()
    const sheet = page.locator(".mobile-sheet.open")
    await sheet.getByRole("button", { name: "1920 x 1080", exact: true }).tap()
    await sheet.getByRole("button", { name: /Show .* results/ }).tap()
    await expect(ftg.locator(".bwm-ftg-n")).toHaveText("— 1")
    const box = (await ftg.boundingBox())!
    expect(box.height).toBeGreaterThanOrEqual(44)
  })

  test("selected chips are hairline rows with ✕ remove and per-chip aria", async ({ page }) => {
    await bootBrowse(page)
    const ftg = page.getByRole("button", { name: "Open filters", exact: true })
    await ftg.tap()
    const sheet = page.locator(".mobile-sheet.open")
    await sheet.getByRole("button", { name: "1920 x 1080", exact: true }).tap()
    await sheet.getByRole("button", { name: /Show .* results/ }).tap()
    const chip = page.getByRole("button", { name: "Remove filter 1920 x 1080", exact: true })
    await expect(chip).toBeVisible()
    expect((await chip.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await chip.tap()
    await expect(page.locator(".bwm-selected-row")).toHaveCount(0)
    await expect(ftg.locator(".bwm-ftg-n")).toBeHidden()
  })

  test("filters sheet is four-zone ●/○ rows with collapsible heads and CLEAR", async ({ page }) => {
    await bootBrowse(page)
    await page.getByRole("button", { name: "Open filters", exact: true }).tap()
    const sheet = page.locator(".mobile-sheet.open")
    // SORT zone: ●/○ selection rows, no segmented control residue.
    await expect(sheet.locator(".mpm-seg")).toHaveCount(0)
    await expect(sheet.locator(".bwm-sheet-chips")).toHaveCount(0)
    const trend = sheet.getByRole("button", { name: "Trending", exact: true })
    await expect(trend).toContainText("●")
    await expect(sheet.getByRole("button", { name: "Rating", exact: true })).toContainText("○")
    // Collapsible group heads: RES open by default with amber count, GENRE collapsed.
    const resHead = sheet.getByRole("button", { name: /^RESOLUTION/ })
    const genreHead = sheet.getByRole("button", { name: /^GENRE/ })
    await expect(resHead).toHaveAttribute("aria-expanded", "true")
    await expect(genreHead).toHaveAttribute("aria-expanded", "false")
    await expect(sheet.getByRole("button", { name: "Abstract", exact: true })).toHaveCount(0)
    await genreHead.tap()
    await expect(sheet.getByRole("button", { name: "Abstract", exact: true })).toBeVisible()
    await sheet.getByRole("button", { name: "Abstract", exact: true }).tap()
    await sheet.getByRole("button", { name: "1920 x 1080", exact: true }).tap()
    await expect(resHead.locator(".bwm-grp-n")).toHaveText("— 1")
    await expect(genreHead.locator(".bwm-grp-n")).toHaveText("— 1")
    // Header action: {n} ACTIVE — CLEAR.
    const clear = sheet.getByRole("button", { name: /CLEAR/ })
    await expect(clear).toHaveText("2 ACTIVE — CLEAR")
    // Footer CTA: literal mixed case "Show {n} results", 48px, no uppercase transform.
    const cta = sheet.getByRole("button", { name: /Show .* results/ })
    await expect(cta).toHaveText("Show 25 results")
    expect((await cta.boundingBox())!.height).toBeGreaterThanOrEqual(48)
    await expect(cta).toHaveCSS("text-transform", "none")
    await clear.tap()
    await expect(sheet.getByRole("button", { name: /ACTIVE — CLEAR/ })).toHaveCount(0)
    await sheet.getByRole("button", { name: /Show .* results/ }).tap()
    await expect(page.locator(".mobile-sheet.open")).toHaveCount(0)
  })

  test("adult •• entry reveals ● 18+ and drops adult selections on collapse", async ({ page }) => {
    await bootBrowse(page)
    await page.getByRole("button", { name: "Open filters", exact: true }).tap()
    const sheet = page.locator(".mobile-sheet.open")
    const adult = sheet.getByRole("button", { name: "Toggle adult content", exact: true })
    await expect(adult).toHaveText("••")
    await expect(sheet.getByRole("button", { name: "Mature", exact: true })).toHaveCount(0)
    await adult.tap()
    await expect(adult).toHaveText("● 18+")
    await sheet.getByRole("button", { name: "Mature", exact: true }).tap()
    await expect(sheet.getByRole("button", { name: "Mature", exact: true })).toContainText("●")
    await adult.tap()
    await expect(adult).toHaveText("••")
    await expect(sheet.getByRole("button", { name: "Mature", exact: true })).toHaveCount(0)
    // The adult selection was dropped, so no CLEAR action remains.
    await expect(sheet.getByRole("button", { name: /ACTIVE — CLEAR/ })).toHaveCount(0)
  })

  test("detail sheet: 88% detent, 16:9 hero, ↓ DOWNLOAD →, no PLAY, no steppers", async ({ page }) => {
    await page.route("**/api/download/3*", (route) => route.fulfill({ json: { ok: true } }))
    await bootBrowse(page)
    await page.getByRole("button", { name: "Open Wallpaper 1", exact: true }).tap()
    const sheet = page.locator(".mobile-sheet.open")
    const body = sheet.locator(".mobile-sheet-body")
    // 16:9 hero.
    const hero = sheet.locator(".bwd-hero")
    const hb = (await hero.boundingBox())!
    expect(Math.abs(hb.width / hb.height - 16 / 9)).toBeLessThan(0.02)
    // Mono meta line: N°001 · WS-{id} · {size} · FPS.
    await expect(sheet.locator(".bwd-meta-line")).toContainText("N°001 · WS-3000000000 ·")
    // No PLAY, no description, no ←/→ steppers.
    await expect(sheet.getByRole("button", { name: /PLAY/ })).toHaveCount(0)
    await expect(sheet.getByText(/test wallpaper item/i)).toHaveCount(0)
    await expect(sheet.getByRole("button", { name: /PREV|NEXT/ })).toHaveCount(0)
    await expect(sheet.getByText("RESOLUTION / CODEC KNOWN AFTER DOWNLOAD")).toBeVisible()
    const dl = sheet.getByRole("button", { name: /DOWNLOAD/ })
    await expect(dl).toContainText("↓ DOWNLOAD →")
    await expect(sheet.getByRole("link", { name: /STEAM ↗/ })).toBeVisible()
    // 88% detent.
    const panel = sheet.locator(".mobile-sheet-panel")
    const pb = (await panel.boundingBox())!
    expect(Math.abs(pb.height - 844 * 0.88)).toBeLessThan(30)
    await expect(body).toBeVisible()
    await sheet.getByRole("button", { name: "Close", exact: true }).tap()
  })

  test("LOAD MORE explicit pagination ends in END — n SHOWN and spine realigns", async ({ page }) => {
    await bootBrowse(page, 30)
    // Spine overlay present with the mp prefix, aligned to the 2-up gutter.
    const spine = page.locator(".mp-gridlines")
    await expect(spine).toBeAttached()
    const vLine = page.locator(".mp-gridlines .mp-gl-v")
    await expect(vLine).toHaveCount(1)
    const cards = page.locator(".bwm-card")
    const first = (await cards.nth(0).boundingBox())!
    const second = (await cards.nth(1).boundingBox())!
    const spineBox = (await vLine.boundingBox())!
    const gutterCenter = (first.x + first.width + second.x) / 2
    expect(Math.abs(spineBox.x + 0.5 - gutterCenter)).toBeLessThanOrEqual(1.5)
    const hBefore = await page.locator(".mp-gridlines .mp-gl-h").count()
    await page.getByRole("button", { name: /LOAD MORE/ }).tap()
    await expect(page.getByRole("button", { name: "Open Wallpaper 26", exact: true })).toBeAttached()
    // Appended rows grew the horizontal line set (manual re-measure).
    await expect.poll(() => page.locator(".mp-gridlines .mp-gl-h").count()).toBeGreaterThan(hBefore)
    // Exhausted: END — {n} SHOWN terminal row replaces LOAD MORE.
    await expect(page.getByRole("button", { name: /LOAD MORE/ })).toHaveCount(0)
    await expect(page.locator(".bwm-end")).toHaveText("END — 30 SHOWN")
  })
})

test.describe("Mouse viewport", () => {
  test.use({ hasTouch: false, isMobile: false })

  test("wide and short mouse viewports keep the desktop shell", async ({ page }) => {
    await bootBrowse(page)
    for (const viewport of [{ width: 844, height: 390 }, { width: 1280, height: 900 }]) {
      await page.setViewportSize(viewport)
      await expect(page.locator(".rail")).toBeVisible()
      await expect(page.locator(".pbar")).toBeVisible()
      await expect(page.locator(".mobile-shell")).toHaveCount(0)
    }
    await page.screenshot({ path: test.info().outputPath("desktop-shell.png") })
  })
})
