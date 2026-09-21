import { expect, test } from "playwright/test"
import type { Page, Route } from "playwright"
import type { ActivityTask } from "@pwe/shared"
import { mockSearchResult, mockSystemSummary, mockWorkshopItems } from "./fixtures.js"
import { computeColumns } from "./helpers.js"

const summary = mockSystemSummary()

/** Boot all the api mocks needed for any Browse test. */
const mockAllEndpoints = async (
  page: Page,
  searchHandler: (r: Route) => void,
  tasksHandler?: (r: Route) => void
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
  await page.route("**/api/download/tasks**", (r) =>
    tasksHandler
      ? tasksHandler(r)
      : r.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: [], total: 0 }),
        })
  )
  await page.route("**/api/workshop/search*", searchHandler)
}

/** Search handler returning `pageSize` items per request. Pages after the
 *  first get offset ids so React keys stay unique across appended pages. */
const pagedSearch = (total: number, nextCursor: string | undefined = "AoJw") => (r: Route) => {
  const url = new URL(r.request().url())
  const pageSize = parseInt(url.searchParams.get("pageSize") ?? "25", 10)
  const cursor = url.searchParams.get("cursor")
  const offset = !cursor || cursor === "*" ? 0 : 1000
  const items = mockWorkshopItems(pageSize).map((it, i) => ({
    ...it,
    publishedfileid: String(3000000000 + offset + i),
  }))
  void r.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(mockSearchResult(items, total, nextCursor)),
  })
}

interface GridMeasurement {
  expectedV: number[]
  vLines: number[]
  expectedH: number[]
  hLines: number[]
  crosses: Array<{ x: number; y: number }>
}

/** Measure cards and overlay lines with offset geometry (matching the
 *  production measurement — no getBoundingClientRect) and return both the
 *  expected gutter centers and the actual line positions. */
const measureGrid = (page: Page): Promise<GridMeasurement> =>
  page.evaluate(() => {
    const root = document.querySelector(".bws") as HTMLElement
    const walk = (el: HTMLElement) => {
      let x = 0
      let y = 0
      let n: HTMLElement | null = el
      while (n && n !== root) {
        x += n.offsetLeft
        y += n.offsetTop
        n = n.offsetParent as HTMLElement | null
      }
      return { x, y }
    }
    const cards = [...document.querySelectorAll(".bws-card")].map((el) => {
      const box = el as HTMLElement
      const p = walk(box)
      return { left: p.x, top: p.y, right: p.x + box.offsetWidth, bottom: p.y + box.offsetHeight }
    })
    const byTop = [...cards].sort((a, b) => a.top - b.top)
    const rows: typeof byTop[] = []
    for (const c of byTop) {
      const row = rows[rows.length - 1]
      if (row && Math.abs(row[0].top - c.top) <= 4) row.push(c)
      else rows.push([c])
    }
    const fullest = [...rows].sort((a, b) => b.length - a.length)[0]
    const cols = [...fullest].sort((a, b) => a.left - b.left)
    const expectedV = cols.slice(0, -1).map((c, i) => (c.right + cols[i + 1].left) / 2)
    const expectedH = rows
      .slice(0, -1)
      .map(
        (row, i) =>
          (Math.max(...row.map((c) => c.bottom)) + Math.min(...rows[i + 1].map((c) => c.top))) / 2
      )
    const vLines = [...document.querySelectorAll(".bws-gl-v")].map((el) => {
      const line = el as HTMLElement
      return walk(line).x + line.offsetWidth / 2
    })
    const hLines = [...document.querySelectorAll(".bws-gl-h")].map((el) => {
      const line = el as HTMLElement
      return walk(line).y + line.offsetHeight / 2
    })
    const crosses = [...document.querySelectorAll(".bws-gx")].map((el) => walk(el as HTMLElement))
    return { expectedV, vLines, expectedH, hLines, crosses }
  })

const TOLERANCE = 1.5

const expectAligned = (m: GridMeasurement) => {
  expect(m.vLines.length).toBeGreaterThan(0)
  expect(m.hLines.length).toBeGreaterThan(0)
  expect(m.vLines.length).toBe(m.expectedV.length)
  expect(m.hLines.length).toBe(m.expectedH.length)
  m.vLines.forEach((x, i) => {
    expect(Math.abs(x - m.expectedV[i])).toBeLessThanOrEqual(TOLERANCE)
  })
  m.hLines.forEach((y, i) => {
    expect(Math.abs(y - m.expectedH[i])).toBeLessThanOrEqual(TOLERANCE)
  })
  // Every + cross sits on a vertical/horizontal line intersection.
  expect(m.crosses.length).toBe(m.vLines.length * m.hLines.length)
  for (const cross of m.crosses) {
    expect(m.expectedV.some((x) => Math.abs(x - cross.x) <= TOLERANCE)).toBe(true)
    expect(m.expectedH.some((y) => Math.abs(y - cross.y) <= TOLERANCE)).toBe(true)
  }
}

test.describe("Browse contact sheet: column measurement", () => {
  test("1280px → 3 columns, page fills complete rows", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const columns = computeColumns(1280)
    expect(columns).toBe(3)
    const expectedPageSize = Math.ceil(25 / columns) * columns

    await mockAllEndpoints(page, pagedSearch(expectedPageSize * 2))
    await page.goto("/browse?q=test", { waitUntil: "networkidle" })
    const grid = page.locator(".bws-grid")
    await expect(grid.locator(".bws-card")).toHaveCount(expectedPageSize, { timeout: 15000 })
    expect(expectedPageSize % columns).toBe(0)
  })

  test("1600px → 4 columns, page fills complete rows", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    const columns = computeColumns(1600)
    expect(columns).toBe(4)
    const expectedPageSize = Math.ceil(25 / columns) * columns

    await mockAllEndpoints(page, pagedSearch(expectedPageSize * 2))
    await page.goto("/browse?q=test", { waitUntil: "networkidle" })
    const grid = page.locator(".bws-grid")
    await expect(grid.locator(".bws-card")).toHaveCount(expectedPageSize, { timeout: 15000 })
    expect(expectedPageSize % columns).toBe(0)
  })

  test("1920px → 5 columns, page fills complete rows", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 900 })
    const columns = computeColumns(1920)
    expect(columns).toBe(5)
    const expectedPageSize = Math.ceil(25 / columns) * columns

    await mockAllEndpoints(page, pagedSearch(expectedPageSize * 2))
    await page.goto("/browse?q=test", { waitUntil: "networkidle" })
    const grid = page.locator(".bws-grid")
    await expect(grid.locator(".bws-card")).toHaveCount(expectedPageSize, { timeout: 15000 })
    expect(expectedPageSize % columns).toBe(0)
  })
})

test.describe("Browse contact sheet: coordinate grid", () => {
  test("lines and crosses align to measured gutters within 1.5px", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    await mockAllEndpoints(page, pagedSearch(200))
    await page.goto("/browse?q=test", { waitUntil: "networkidle" })
    await expect(page.locator(".bws-grid .bws-card")).toHaveCount(28, { timeout: 15000 })
    // 4 columns → 3 vertical lines; 28 cards → 7 rows → 6 horizontal lines.
    await expect(page.locator(".bws-gl-v")).toHaveCount(3)
    await expect(page.locator(".bws-gl-h")).toHaveCount(6)
    expectAligned(await measureGrid(page))
  })

  test("resize realigns instantly: lines follow the reflowed grid", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    await mockAllEndpoints(page, pagedSearch(400))
    await page.goto("/browse?q=test", { waitUntil: "networkidle" })
    const grid = page.locator(".bws-grid")
    await expect(grid.locator(".bws-card")).toHaveCount(28, { timeout: 15000 })
    expectAligned(await measureGrid(page))

    // Narrow to 3 columns: the pageSize key change refetches 27 cards and
    // the overlay must track the new gutters (2 vertical lines).
    await page.setViewportSize({ width: 1280, height: 900 })
    await expect(grid.locator(".bws-card")).toHaveCount(27, { timeout: 15000 })
    await expect(page.locator(".bws-gl-v")).toHaveCount(2)
    expectAligned(await measureGrid(page))
  })
})

test.describe("Browse contact sheet: infinite scroll", () => {
  test("sentinel appends without a scroll jump; exhaustion shows END — n SHOWN", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    const pageSize = Math.ceil(25 / computeColumns(1600)) * computeColumns(1600)
    await mockAllEndpoints(page, (r) => {
      const url = new URL(r.request().url())
      const cursor = url.searchParams.get("cursor")
      if (cursor === "*") {
        void r.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(mockSearchResult(mockWorkshopItems(pageSize), pageSize * 2, "c2")),
        })
        return
      }
      void r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          mockSearchResult(
            mockWorkshopItems(pageSize).map((it, i) => ({
              ...it,
              publishedfileid: String(4000000000 + i),
            })),
            pageSize * 2,
            undefined
          )
        ),
      })
    })

    await page.goto("/browse?q=test", { waitUntil: "networkidle" })
    const grid = page.locator(".bws-grid")
    await expect(grid.locator(".bws-card")).toHaveCount(pageSize, { timeout: 15000 })

    const scroller = page.locator(".main")
    await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight))
    const scrolled = await scroller.evaluate((el) => el.scrollTop)
    expect(scrolled).toBeGreaterThan(0)

    await expect(grid.locator(".bws-card")).toHaveCount(pageSize * 2, { timeout: 15000 })
    // Appending below the fold must not move the scroll position.
    const after = await scroller.evaluate((el) => el.scrollTop)
    expect(Math.abs(after - scrolled)).toBeLessThanOrEqual(2)

    await expect(page.locator(".bws-state-end")).toContainText(`END — ${pageSize * 2} SHOWN`)
  })

  test("resize recomputes pageSize; the next page uses the new size", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const colsA = computeColumns(1280)
    const pageSizeA = Math.ceil(25 / colsA) * colsA

    const capturedPageSizes: number[] = []
    await mockAllEndpoints(page, (r) => {
      const url = new URL(r.request().url())
      const pageSizeParam = parseInt(url.searchParams.get("pageSize") ?? "25", 10)
      capturedPageSizes.push(pageSizeParam)
      void r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          mockSearchResult(mockWorkshopItems(pageSizeParam), pageSizeParam * 4, "next")
        ),
      })
    })

    await page.goto("/browse?q=test", { waitUntil: "networkidle" })
    const grid = page.locator(".bws-grid")
    await expect(grid.locator(".bws-card")).toHaveCount(pageSizeA, { timeout: 15000 })

    await page.setViewportSize({ width: 1920, height: 900 })
    const colsB = computeColumns(1920)
    const pageSizeB = Math.ceil(25 / colsB) * colsB
    expect(pageSizeB).toBe(25)

    await expect(grid.locator(".bws-card")).toHaveCount(pageSizeB, { timeout: 15000 })

    // Scroll to the sentinel; the next page also uses the new pageSize.
    await page.locator(".main").evaluate((el) => el.scrollTo(0, el.scrollHeight))
    await expect(grid.locator(".bws-card")).toHaveCount(pageSizeB * 2, { timeout: 15000 })

    expect(capturedPageSizes[0]).toBe(pageSizeA)
    expect(capturedPageSizes).toContain(pageSizeB)
    expect(capturedPageSizes[capturedPageSizes.length - 1]).toBe(pageSizeB)
  })
})

test.describe("Browse contact sheet: download intent", () => {
  test("ADD queues a download; the task surfaces on the card and in Activity", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    const firstId = "3000000000"
    const activeDownload: ActivityTask = {
      task_id: "task-dl-1",
      task_type: "download",
      workshop_id: firstId,
      title: "Wallpaper 1",
      preview_url: "",
      content_rating: "Everyone",
      rating_sex: null,
      adult_hint: 0,
      stage: "downloading",
      message: "Downloading",
      started_at: Date.now(),
      finished_at: null,
      percent: 12,
      bytes_done: null,
      bytes_total: null,
    }
    let queued = false
    let postedTo: string | null = null

    await mockAllEndpoints(
      page,
      pagedSearch(200),
      (r) =>
        void r.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: queued ? [activeDownload] : [], total: queued ? 1 : 0 }),
        })
    )
    await page.route(`**/api/download/${firstId}`, (r) => {
      if (r.request().method() !== "POST") {
        void r.fallback()
        return
      }
      postedTo = r.request().url()
      queued = true
      void r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      })
    })

    await page.goto("/browse?q=test", { waitUntil: "networkidle" })
    const card = page.locator(".bws-card").first()
    await expect(card.locator(".bws-card-index")).toHaveText("N°001")
    await card.hover()
    await card.locator("button.bws-add", { hasText: "ADD" }).click()

    await expect.poll(() => postedTo).toContain(`/api/download/${firstId}`)
    // The tasks refetch turns the card's ADD into the live stage readout…
    await expect(card.locator(".bws-add.is-static")).toHaveText("DOWNLOADING")

    // …and the same task appears on the Activity page.
    await page.locator(".rail-nav-link", { hasText: "Activity" }).click()
    await expect(page.locator(".main")).toContainText("Wallpaper 1", { timeout: 15000 })
  })
})

test.describe("Browse contact sheet: state blocks", () => {
  test("skeleton (pulsing cross + scanline) shows while the first page loads", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    let release!: () => void
    const gate = new Promise<void>((res) => {
      release = res
    })
    await mockAllEndpoints(page, (r) => {
      void gate.then(() =>
        r.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(mockSearchResult(mockWorkshopItems(28), 56, undefined)),
        })
      )
    })
    await page.goto("/browse?q=test")
    const skeleton = page.locator(".bws-state-loading")
    await expect(skeleton).toBeVisible()
    await expect(skeleton).toContainText("FETCHING INDEX…")
    await expect(skeleton.locator(".bws-state-cross")).toHaveCSS("animation-name", "bws-pulse")
    release()
    await expect(page.locator(".bws-card").first()).toBeAttached({ timeout: 15000 })
  })

  test("empty state", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    await mockAllEndpoints(page, (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockSearchResult([], 0, undefined)),
      })
    )
    await page.goto("/browse?q=test", { waitUntil: "networkidle" })
    await expect(page.locator(".bws-state-empty")).toContainText(
      "0 RESULTS — WIDEN QUERY OR CLEAR FILTERS"
    )
  })

  test("page-level error only when the whole page fails, with retry", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    await mockAllEndpoints(page, (r) =>
      r.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "steam offline" }),
      })
    )
    await page.goto("/browse?q=test", { waitUntil: "networkidle" })
    const block = page.locator(".bws-state-error")
    await expect(block).toHaveCount(1)
    await expect(block).toContainText("ERR — steam offline")
    await expect(block.locator(".bws-state-retry")).toBeVisible()
  })
})

test.describe("Browse contact sheet: reduced motion", () => {
  test.use({ reducedMotion: "reduce" })

  test("penter degrades to a 0.2s pure fade; the grid still measures", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    await mockAllEndpoints(page, pagedSearch(200))
    await page.goto("/browse?q=test", { waitUntil: "networkidle" })
    await expect(page.locator(".bws-grid .bws-card")).toHaveCount(28, { timeout: 15000 })

    const anim = await page.locator(".bws-card").first().evaluate((el) => {
      const cs = getComputedStyle(el as HTMLElement)
      return { name: cs.animationName, duration: cs.animationDuration }
    })
    expect(anim.name).toBe("pt-enter-fade")
    expect(anim.duration).toBe("0.2s")

    // The coordinate grid is layout geometry, not motion — still aligned.
    expectAligned(await measureGrid(page))
  })
})
