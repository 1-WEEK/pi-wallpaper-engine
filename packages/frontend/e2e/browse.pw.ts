import { expect, test } from "playwright/test"
import type { Page, Route } from "playwright"
import type { ActivityTask } from "@pwe/shared"
import { mockSearchResult, mockSystemSummary, mockWorkshopItems } from "./fixtures.js"
import { computeColumns, freezePageClock } from "./helpers.js"

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
    // First paint after a cold vite transform plus the tasks refetch window
    // can outlast the 30s default test timeout under parallel-suite load.
    test.setTimeout(60_000)
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

    // No networkidle: the app's SWR polling can keep the network busy past
    // the navigation window under load; readiness is asserted on the grid.
    await page.goto("/browse?q=test")
    const card = page.locator(".bws-card").first()
    // First paint after a cold vite transform can outlast the default 5s
    // expect timeout under parallel-suite load.
    await expect(card.locator(".bws-card-index")).toHaveText("N°001", { timeout: 30000 })
    await card.hover()
    await card.locator("button.bws-add", { hasText: "ADD" }).click()

    await expect.poll(() => postedTo).toContain(`/api/download/${firstId}`)
    // The tasks refetch turns the card's ADD into the live stage readout…
    // (lands on the app's SWR refresh window, slow under suite load).
    await expect(card.locator(".bws-add.is-static")).toHaveText("DOWNLOADING", { timeout: 15000 })

    // …and the same task appears on the Activity page.
    await page.locator(".rail-nav-link", { hasText: "Activity" }).click()
    await expect(page.locator(".main")).toContainText("Wallpaper 1", { timeout: 15000 })
  })
})

/** Boot Browse with every download POST accepted (ticket 12 receipt tests). */
const bootWithDownload = async (page: Page) => {
  let posted = 0
  await page.setViewportSize({ width: 1600, height: 900 })
  await mockAllEndpoints(page, pagedSearch(200))
  await page.route("**/api/download/3*", (r) => {
    if (r.request().method() !== "POST") {
      void r.fallback()
      return
    }
    posted += 1
    void r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
  })
  await page.goto("/browse?q=test", { waitUntil: "networkidle" })
  await expect(page.locator(".bws-grid .bws-card")).toHaveCount(28, { timeout: 15000 })
  return { posted: () => posted }
}

const addCard = async (page: Page, index: number) => {
  const card = page.locator(".bws-card").nth(index)
  await card.hover()
  await card.locator("button.bws-add", { hasText: "ADD" }).click()
}

/** Ghost start pose (static inline style = the from rect) plus the running
 *  animation's final keyframe and duration. */
const ghostSnapshot = (page: Page) =>
  page.locator("body > img").last().evaluate((el) => {
    const style = (el as HTMLElement).style
    const effect = el.getAnimations()[0]?.effect as KeyframeEffect | undefined
    const kfs = effect?.getKeyframes() ?? []
    const last = (kfs[kfs.length - 1] ?? {}) as Record<string, unknown>
    return {
      left: parseFloat(style.left),
      top: parseFloat(style.top),
      lastTransform: String(last.transform ?? ""),
      duration: Number(effect?.getComputedTiming().duration),
    }
  })

test.describe("Browse download receipt ghost (ticket 12)", () => {
  test("ADD flies the thumbnail into the Library nav item, then navpulse fires", async ({
    page,
  }) => {
    await bootWithDownload(page)
    const mediaBox = (await page.locator(".bws-card").first().locator(".bws-media").boundingBox())!
    const navBox = (await page.locator('[data-nav="library"]').boundingBox())!

    await addCard(page, 0)
    const ghosts = page.locator("body > img")
    await expect(ghosts).toHaveCount(1)

    // Start pose = the card media rect; the final keyframe lands on a 48×30
    // chip centered in the Library nav item; the flight is the registered
    // 420ms §5 exception on --ease-out.
    const g = await ghostSnapshot(page)
    expect(g.duration).toBe(420)
    expect(g.left).toBeCloseTo(mediaBox.x, 0)
    expect(g.top).toBeCloseTo(mediaBox.y, 0)
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(g.lastTransform)
    expect(m).not.toBeNull()
    expect(g.left + parseFloat(m![1])).toBeCloseTo(navBox.x + navBox.width / 2 - 24, 0)
    expect(g.top + parseFloat(m![2])).toBeCloseTo(navBox.y + navBox.height / 2 - 15, 0)

    // The ghost lands (~420ms) → the nav label flashes inverse once (~1.4s),
    // on the label so it never fights the XOR mask's covered state.
    const navLink = page.locator('[data-nav="library"]')
    await expect(navLink).toHaveClass(/nav-pulse/, { timeout: 2000 })
    await expect(navLink.locator(".rail-nav-label")).toHaveCSS("animation-name", "navpulse")
    // …and the pulse retires instead of sticking.
    await expect(navLink).not.toHaveClass(/nav-pulse/, { timeout: 4000 })
    await expect(ghosts).toHaveCount(0)
  })

  test("rapid repeated ADDs replace the ghost — never stack", async ({ page }) => {
    await bootWithDownload(page)
    await addCard(page, 0)
    await expect(page.locator("body > img")).toHaveCount(1)
    await addCard(page, 1)
    // Mid-flight of the second ghost: the first was killed, nothing queued.
    await page.waitForTimeout(150)
    expect(await page.locator("body > img").count()).toBe(1)
    await expect(page.locator("body > img")).toHaveCount(0, { timeout: 2000 })
    // Exactly one receipt pulse — the surviving flight's landing beat.
    await expect(page.locator('[data-nav="library"]')).toHaveClass(/nav-pulse/, { timeout: 2000 })
  })
})

test.describe("Browse download receipt ghost: reduced motion (ticket 12)", () => {
  test.use({ reducedMotion: "reduce" })

  test("instant receipt: no ghost, no pulse; the queue state still lands", async ({ page }) => {
    const { posted } = await bootWithDownload(page)
    const card = page.locator(".bws-card").first()
    await card.hover()
    await card.locator("button.bws-add", { hasText: "ADD" }).click()
    await expect.poll(() => posted()).toBe(1)
    await expect(card.locator(".bws-add.is-static")).toHaveText("QUEUED")
    await page.waitForTimeout(600)
    expect(await page.locator("body > img").count()).toBe(0)
    await expect(page.locator('[data-nav="library"]')).not.toHaveClass(/nav-pulse/)
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

/** Boot a desktop Browse page with 28 cards (1600px → 4 columns). */
const bootBrowse = async (page: Page) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await mockAllEndpoints(page, pagedSearch(200))
  await page.goto("/browse?q=test", { waitUntil: "networkidle" })
  await expect(page.locator(".bws-grid .bws-card")).toHaveCount(28, { timeout: 15000 })
}

test.describe("Browse views: density list (ticket 05)", () => {
  test("V toggles grid ↔ density list with the ledger row grammar", async ({ page }) => {
    await bootBrowse(page)
    await expect(page.locator(".bws-view-hint")).toHaveText("V — GRID")

    await page.keyboard.press("v")
    await expect(page.locator(".bws-view-hint")).toHaveText("V — LIST")
    await expect(page.locator(".bws-grid")).toHaveCount(0)
    const rows = page.locator(".ledger-row")
    await expect(rows).toHaveCount(28)

    // Ledger grammar: N° + 56px thumb + title + dotted leader + mono meta.
    const first = rows.first()
    await expect(first.locator(".ledger-no")).toHaveText("N°001")
    await expect(first.locator(".ledger-thumb")).toHaveCSS("width", "56px")
    await expect(first.locator(".ledger-title")).toHaveText("Wallpaper 1")
    await expect(first.locator(".ledger-leader")).toBeAttached()
    await expect(first.locator(".ledger-meta")).toContainText("5.0 MB")
    // Hairline separators between rows.
    await expect(first).toHaveCSS("border-bottom-width", "1px")

    await page.keyboard.press("v")
    await expect(page.locator(".bws-view-hint")).toHaveText("V — GRID")
    await expect(page.locator(".bws-grid .bws-card")).toHaveCount(28)
    await expect(page.locator(".ledger-list")).toHaveCount(0)
  })

  test("arrow keys roam rows one by one", async ({ page }) => {
    await bootBrowse(page)
    await page.keyboard.press("v")
    const rows = page.locator(".ledger-row")
    await expect(rows.nth(0)).toHaveClass(/is-cursor/)

    await page.keyboard.press("ArrowDown")
    await expect(rows.nth(1)).toHaveClass(/is-cursor/)
    await page.keyboard.press("ArrowDown")
    await expect(rows.nth(2)).toHaveClass(/is-cursor/)
    await page.keyboard.press("ArrowUp")
    await expect(rows.nth(1)).toHaveClass(/is-cursor/)
    // Clamped at the top edge.
    await page.keyboard.press("ArrowUp")
    await page.keyboard.press("ArrowUp")
    await expect(rows.nth(0)).toHaveClass(/is-cursor/)
  })
})

test.describe("Browse views: immersive focus view (ticket 05)", () => {
  test("Enter opens from the grid with a media View Transition", async ({ page }) => {
    await bootBrowse(page)

    // §5 F3: in Chromium the open is a card-media View Transition. Install a
    // watcher BEFORE pressing Enter — the pseudo animations live only ~300ms,
    // so polling after the fact races the finished transition.
    const hasVtApi = await page.evaluate(
      () => typeof document.startViewTransition === "function"
    )
    if (hasVtApi) {
      await page.evaluate(() => {
        const w = window as unknown as {
          __vtPseudos: Set<string>
          __vtDone: boolean
        }
        w.__vtPseudos = new Set()
        w.__vtDone = false
        const orig = document.startViewTransition.bind(document)
        document.startViewTransition = ((cb: () => void | Promise<unknown>) => {
          const vt = orig(cb)
          const watch = () => {
            for (const a of document.getAnimations()) {
              const p = (a.effect as KeyframeEffect | null)?.pseudoElement
              if (p) w.__vtPseudos.add(p)
            }
            if (!w.__vtDone) requestAnimationFrame(watch)
          }
          watch()
          vt.finished.finally(() => {
            w.__vtDone = true
          })
          return vt
        }) as typeof document.startViewTransition
      })
    }

    await page.keyboard.press("Enter")
    const focus = page.locator(".pfocus")
    await expect(focus).toBeVisible()
    await expect(focus.locator(".pfocus-title")).toHaveText("Wallpaper 1")
    await expect(focus.locator(".pfocus-no")).toHaveText("N°001")
    await expect(focus.locator(".pfocus-meta")).toContainText("ID 3000000000")
    // Pure download semantics: DOWNLOAD + STEAM, no PLAY anywhere.
    await expect(focus.locator(".pfocus-primary")).toHaveText("DOWNLOAD ↓")
    await expect(focus.locator(".pfocus-cmd")).toContainText("STEAM")
    await expect(focus).not.toContainText("PLAY")

    if (hasVtApi) {
      // The delayed live-DOM chrome entrance is marked on the stage.
      await expect(focus.locator(".pfocus-stage")).toHaveClass(/pfocus-vt/)
      // The transition ran and the media morph (group/old/new pseudos) existed.
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { __vtDone: boolean }).__vtDone))
        .toBe(true)
      const pseudos = await page.evaluate(() => [
        ...(window as unknown as { __vtPseudos: Set<string> }).__vtPseudos,
      ])
      expect(pseudos).toContain("::view-transition-group(card-media)")
      expect(pseudos).toContain("::view-transition-new(card-media)")
    }
  })

  test("←/→ steps through items and wraps; Esc closes with a ghost flight", async ({
    page,
  }) => {
    await bootBrowse(page)

    await page.keyboard.press("Enter")
    const focus = page.locator(".pfocus")
    await expect(focus.locator(".pfocus-title")).toHaveText("Wallpaper 1")

    await page.keyboard.press("ArrowRight")
    await expect(focus.locator(".pfocus-title")).toHaveText("Wallpaper 2")
    await expect(focus.locator(".pfocus-no")).toHaveText("N°002")

    // Wrap-around: 0 ← 1 → step left twice from N°002 lands on the last item.
    await page.keyboard.press("ArrowLeft")
    await page.keyboard.press("ArrowLeft")
    await expect(focus.locator(".pfocus-title")).toHaveText("Wallpaper 28")

    await page.keyboard.press("Escape")
    // §5 F6: the close direction flies a fixed-position ghost of the media
    // back to the card while the chrome plays its 150ms exit beat.
    await expect
      .poll(
        () => page.evaluate(() => document.body.querySelectorAll(":scope > img").length),
        { timeout: 2000 }
      )
      .toBeGreaterThan(0)
    await expect(focus).toHaveCount(0)
  })

  test("Esc exit beat: scrim and stage fade in lockstep — 150ms, no snap-off", async ({
    page,
  }) => {
    await bootBrowse(page)
    await page.keyboard.press("Enter")
    await expect(page.locator(".pfocus")).toBeVisible()

    /* Freeze the unmount timer: the close handler removes the focus view on
     * a real 150ms setTimeout, which races the probes below. */
    await freezePageClock(page)
    await page.keyboard.press("Escape")
    await page.clock.runFor(50) // close class applies; exit animations created
    await expect(page.locator(".pfocus-scrim-out")).toBeAttached()

    /* Freeze the exit 10ms in: both layers must still be mostly opaque.
     * Regression for the pre-15 snap-off: the lingering fill:both entrance
     * animation re-resolved its implicit `to` against the closing class and
     * the scrim/panel jumped to opacity 0 with no exit at all. */
    const mid = await page.evaluate(() => {
      const read = (sel: string, name: string) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const exits = (el.getAnimations() as CSSAnimation[]).filter(
          (a) => a.animationName === name
        )
        if (exits.length !== 1) return null
        exits[0].pause()
        exits[0].currentTime = 10
        return parseFloat(getComputedStyle(el).opacity)
      }
      return {
        scrim: read(".pfocus-scrim", "pfocus-scrim-out"),
        stage: read(".pfocus-stage", "pfocus-out"),
      }
    })
    expect(mid.scrim).not.toBeNull()
    expect(mid.stage).not.toBeNull()
    expect(mid.scrim!).toBeGreaterThan(0.5)
    expect(mid.stage!).toBeGreaterThan(0.5)

    await page.clock.runFor(300) // let the frozen unmount timer fire
    await expect(page.locator(".pfocus")).toHaveCount(0)
  })

  test("Enter opens from the density list; scrim click closes", async ({ page }) => {
    await bootBrowse(page)
    await page.keyboard.press("v")
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("Enter")

    const focus = page.locator(".pfocus")
    await expect(focus).toBeVisible()
    await expect(focus.locator(".pfocus-title")).toHaveText("Wallpaper 2")

    await focus.locator(".pfocus-scrim").click({ position: { x: 20, y: 20 } })
    await expect(focus).toHaveCount(0)
  })

  test("DOWNLOAD queues via the API and the action flips to the live stage", async ({
    page,
  }) => {
    const firstId = "3000000000"
    const activeDownload: ActivityTask = {
      task_id: "task-dl-focus",
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

    await page.setViewportSize({ width: 1600, height: 900 })
    await mockAllEndpoints(page, pagedSearch(200), (r) =>
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
    await expect(page.locator(".bws-grid .bws-card")).toHaveCount(28, { timeout: 15000 })

    await page.keyboard.press("Enter")
    const focus = page.locator(".pfocus")
    await focus.locator(".pfocus-primary", { hasText: "DOWNLOAD" }).click()

    await expect.poll(() => postedTo).toContain(`/api/download/${firstId}`)
    await expect(focus.locator(".pfocus-static")).toHaveText("DOWNLOADING")
  })
})

test.describe("Browse views: reduced motion (ticket 05)", () => {
  test.use({ reducedMotion: "reduce" })

  test("focus view cuts instantly: no VT marker, no close ghost", async ({ page }) => {
    await bootBrowse(page)

    await page.keyboard.press("Enter")
    const focus = page.locator(".pfocus")
    await expect(focus).toBeVisible()
    await expect(focus.locator(".pfocus-stage")).toHaveClass("pfocus-stage")

    await page.keyboard.press("Escape")
    await expect(focus).toHaveCount(0)
    // No ghost was spawned for the close.
    expect(await page.evaluate(() => document.body.querySelectorAll(":scope > img").length)).toBe(
      0
    )
  })

  test("the exit beat degrades to an instant cut: opacity 0 with no animation", async ({
    page,
  }) => {
    await bootBrowse(page)
    await page.keyboard.press("Enter")
    await expect(page.locator(".pfocus")).toBeVisible()

    // Same frozen-clock seam as the exit-beat test above: under reduced
    // motion there is no exit animation, but the 150ms unmount timer still
    // races the probe.
    await freezePageClock(page)
    await page.keyboard.press("Escape")
    await page.clock.runFor(50)
    await expect(page.locator(".pfocus-scrim-out")).toBeAttached()
    const exit = await page.evaluate(() => {
      const el = document.querySelector(".pfocus-scrim")
      return el
        ? { anims: el.getAnimations().length, opacity: getComputedStyle(el).opacity }
        : null
    })
    expect(exit).toEqual({ anims: 0, opacity: "0" })
    await page.clock.runFor(300)
    await expect(page.locator(".pfocus")).toHaveCount(0)
  })
})

/* ── Ticket 06: keyboard roaming & the 1-bit card focus band (Q 方案) ── */

/** Ring vs the cursor item: max edge delta (client rects, same frame) plus
 *  the ring's in-flight WAAPI animation count. */
const measureRing = (
  page: Page,
  itemSelector: string,
  index: number
): Promise<{ d: number; anims: number } | null> =>
  page.evaluate(
    ({ sel, i }) => {
      const ring = document.querySelector(".focus-ring")
      const item = document.querySelectorAll(sel)[i]
      if (!ring || !item) return null
      const r = ring.getBoundingClientRect()
      const c = item.getBoundingClientRect()
      const d = Math.max(
        Math.abs(r.x - c.x),
        Math.abs(r.y - c.y),
        Math.abs(r.width - c.width),
        Math.abs(r.height - c.height)
      )
      return { d, anims: ring.getAnimations().length }
    },
    { sel: itemSelector, i: index }
  )

/** Poll until the ring hugs item `index` exactly and nothing is animating. */
const expectRingOn = async (page: Page, itemSelector: string, index: number) => {
  await expect
    .poll(
      async () => {
        const m = await measureRing(page, itemSelector, index)
        return m !== null && m.d <= 1.5 && m.anims === 0
      },
      { timeout: 3000 }
    )
    .toBe(true)
}

test.describe("Browse focus band: keyboard roaming (ticket 06)", () => {
  test("arrows roam by the measured column count; the band hugs the cursor card", async ({
    page,
  }) => {
    await bootBrowse(page)
    const cols = computeColumns(1600)
    expect(cols).toBe(4)

    // The Q focus language: SVG-tile checkerboard dither band (no conic
    // gradient), an XOR difference block for the commit flip, and the mono
    // C·R coordinate readout riding the frame.
    const ring = page.locator(".focus-ring")
    await expect(ring).toBeVisible()
    await expect(ring.locator(".focus-ring-dither")).toHaveCSS(
      "background-image",
      /data:image\/svg\+xml/
    )
    await expect(ring.locator(".focus-ring-xor")).toHaveCSS("mix-blend-mode", "difference")
    await expect(ring.locator(".focus-ring-coord")).toHaveText("C1·R1")
    await expect(page.locator(".bws-card").nth(0)).toHaveClass(/bws-cursor/)
    await expectRingOn(page, ".bws-card", 0)

    // Down jumps a full measured row; right/left step within it.
    await page.keyboard.press("ArrowDown")
    await expect(page.locator(".bws-card").nth(cols)).toHaveClass(/bws-cursor/)
    await expect(ring.locator(".focus-ring-coord")).toHaveText("C1·R2")
    await expectRingOn(page, ".bws-card", cols)

    await page.keyboard.press("ArrowRight")
    await expect(page.locator(".bws-card").nth(cols + 1)).toHaveClass(/bws-cursor/)
    await expect(ring.locator(".focus-ring-coord")).toHaveText("C2·R2")
    await page.keyboard.press("ArrowUp")
    await expect(page.locator(".bws-card").nth(1)).toHaveClass(/bws-cursor/)
    await expectRingOn(page, ".bws-card", 1)
    // Clamped at the left edge.
    await page.keyboard.press("ArrowLeft")
    await page.keyboard.press("ArrowLeft")
    await expect(page.locator(".bws-card").nth(0)).toHaveClass(/bws-cursor/)
  })

  test("the band follows the cursor into the density list, row by row", async ({ page }) => {
    await bootBrowse(page)
    await page.keyboard.press("v")
    const rows = page.locator(".ledger-row")
    await expect(rows).toHaveCount(28)
    // The view toggle is a reflow, not a focus move: snap, never slide.
    await expectRingOn(page, ".ledger-row", 0)

    await page.keyboard.press("ArrowDown")
    await expect(rows.nth(1)).toHaveClass(/is-cursor/)
    await expect(page.locator(".focus-ring-coord")).toHaveText("C1·R2")
    await expectRingOn(page, ".ledger-row", 1)
  })

  test("the 250ms slide re-triggers from the presented value, never the old target", async ({
    page,
  }) => {
    await bootBrowse(page)
    const cols = computeColumns(1600)

    /* Deterministic choreography: sampling the slide by wall-clock or rAF
     * races under suite load (the first probe can land after the whole
     * 250ms flight). Instead, spy on Element.prototype.animate: record the
     * keyframes of every ring slide and freeze each one at a FIXED 60ms
     * the moment it is created, so the presented value is deterministic no
     * matter how loaded the machine is. */
    await page.evaluate(() => {
      const w = window as unknown as {
        __ringCalls: Array<{ from: string; to: string; duration: number }>
        __ringAnims: Animation[]
        __origAnimate: typeof Element.prototype.animate
      }
      w.__ringCalls = []
      w.__ringAnims = []
      w.__origAnimate = Element.prototype.animate
      Element.prototype.animate = function (
        this: Element,
        kfs: Keyframe[] | PropertyIndexedKeyframes | null,
        opts?: number | KeyframeAnimationOptions
      ): Animation {
        const anim = w.__origAnimate.call(this, kfs, opts)
        if ((this as HTMLElement).classList?.contains("focus-ring") && Array.isArray(kfs)) {
          const o = (opts ?? {}) as KeyframeAnimationOptions
          w.__ringCalls.push({
            from: String((kfs[0] as Keyframe).transform ?? ""),
            to: String((kfs[kfs.length - 1] as Keyframe).transform ?? ""),
            duration: Number(o.duration),
          })
          anim.pause()
          anim.currentTime = 60 // freeze mid-flight at a deterministic frame
          w.__ringAnims.push(anim)
        }
        return anim
      }
    })

    // Dispatch on body (bubbles to the window listener): dispatching on
    // window directly makes e.target the window, which has no .closest.
    const key = (k: string) =>
      page.evaluate(
        (key) =>
          document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
        k
      )

    const cards = page.locator(".bws-card")
    const x0 = (await cards.nth(0).boundingBox())!.x
    const x1 = (await cards.nth(1).boundingBox())!.x

    await key("ArrowRight")
    // Slide 1 exists (spied, frozen at 60ms) — React flushes asynchronously,
    // so poll the recording, not the clock.
    await expect.poll(() => page.evaluate(() => (window as any).__ringCalls.length)).toBe(1)
    // The frozen presented value is genuinely mid-flight…
    const midX = await page
      .locator(".focus-ring")
      .evaluate((el) => el.getBoundingClientRect().x)
    expect(midX).toBeGreaterThan(x0 + 2)
    expect(midX).toBeLessThan(x1 - 2)

    await key("ArrowDown") // re-target while slide 1 is frozen mid-flight
    await expect.poll(() => page.evaluate(() => (window as any).__ringCalls.length)).toBe(2)

    const calls = await page.evaluate(() => (window as any).__ringCalls)
    const px = (t: string) => parseFloat(/translate\((-?[\d.]+)px/.exec(t)?.[1] ?? "NaN")
    // The ring lives in host offset geometry: translate(x) is host-relative,
    // so compare against viewport rects shifted by x0 (card 0's offsetLeft
    // inside the host is 0).
    const pitch = x1 - x0
    // Slide 1: from the origin card to the ArrowRight target.
    expect(px(calls[0].from)).toBeCloseTo(0, 0)
    expect(px(calls[0].to)).toBeCloseTo(pitch, 0)
    expect(calls[0].duration).toBe(250)
    // Slide 2 (§5 F4): starts from the PRESENTED value the app read off the
    // frozen frame — not from 0 (origin restart) and not from pitch
    // (old-target restart).
    expect(px(calls[1].from)).toBeCloseTo(midX - x0, 0)
    expect(calls[1].duration).toBe(250)

    /* Restore the prototype and let the last slide finish so the ring can
     * settle on the re-targeted card for the assertions below. */
    await page.evaluate(() => {
      const w = window as unknown as {
        __ringAnims: Animation[]
        __origAnimate: typeof Element.prototype.animate
      }
      Element.prototype.animate = w.__origAnimate
      w.__ringAnims[w.__ringAnims.length - 1]?.play()
    })

    await expect(page.locator(".bws-card").nth(cols + 1)).toHaveClass(/bws-cursor/)
    await expectRingOn(page, ".bws-card", cols + 1)
  })

  test("Enter plays the ~120ms commit beat (dither out, XOR in) before the focus view", async ({
    page,
  }) => {
    test.setTimeout(60_000) // cold vite transform + VT capture under suite load
    await bootBrowse(page)
    // Record WHEN the commit flip and the focus-view mount happen — the
    // 120ms beat is too short to catch by polling after the fact.
    await page.evaluate(() => {
      const w = window as unknown as { __commitAt: number | null; __focusAt: number | null }
      w.__commitAt = null
      w.__focusAt = null
      new MutationObserver(() => {
        if (
          w.__commitAt === null &&
          document.querySelector(".focus-ring")?.classList.contains("commit")
        )
          w.__commitAt = performance.now()
        if (w.__focusAt === null && document.querySelector(".pfocus"))
          w.__focusAt = performance.now()
      }).observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["class"],
      })
    })

    await page.keyboard.press("Enter")
    const focus = page.locator(".pfocus")
    await expect(focus).toBeVisible()
    await expect(focus.locator(".pfocus-title")).toHaveText("Wallpaper 1")

    const t = await page.evaluate(() => {
      const w = window as unknown as { __commitAt: number | null; __focusAt: number | null }
      return { commitAt: w.__commitAt, focusAt: w.__focusAt }
    })
    expect(t.commitAt).not.toBeNull()
    expect(t.focusAt).not.toBeNull()
    const delta = (t.focusAt ?? 0) - (t.commitAt ?? 0)
    expect(delta).toBeGreaterThanOrEqual(90) // the commit beat really played first
    // Upper bound is sanity only: the 120ms beat is a setTimeout (fires late,
    // never early) and the VT snapshot capture is unbounded under parallel
    // suite load — observed >1000ms with an otherwise correct beat.
    expect(delta).toBeLessThan(4000)
  })

  test("hover coexists with focus and the band never eats pointer events", async ({ page }) => {
    let postedTo: string | null = null
    await page.setViewportSize({ width: 1600, height: 900 })
    await mockAllEndpoints(page, pagedSearch(200))
    await page.route("**/api/download/3000000000", (r) => {
      if (r.request().method() !== "POST") {
        void r.fallback()
        return
      }
      postedTo = r.request().url()
      void r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      })
    })
    await page.goto("/browse?q=test", { waitUntil: "networkidle" })
    const grid = page.locator(".bws-grid")
    await expect(grid.locator(".bws-card")).toHaveCount(28, { timeout: 15000 })

    // Hovering another card moves nothing; the band stays on the cursor card.
    await grid.locator(".bws-card").nth(2).hover()
    await page.waitForTimeout(150)
    await expect(grid.locator(".bws-card").nth(0)).toHaveClass(/bws-cursor/)
    await expectRingOn(page, ".bws-card", 0)

    // The band layers OVER the focused card (z-index) but is
    // pointer-events: none — the ADD button beneath it still clicks.
    const card0 = grid.locator(".bws-card").nth(0)
    await card0.hover()
    await card0.locator("button.bws-add", { hasText: "ADD" }).click()
    await expect.poll(() => postedTo).toContain("/api/download/3000000000")
  })
})

test.describe("Browse focus band: resize realignment (ticket 06)", () => {
  test("resize snaps the band onto the same card — no slide, even mid-flight", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    await mockAllEndpoints(page, pagedSearch(400))
    await page.goto("/browse?q=test", { waitUntil: "networkidle" })
    const grid = page.locator(".bws-grid")
    await expect(grid.locator(".bws-card")).toHaveCount(28, { timeout: 15000 })

    await page.keyboard.press("ArrowRight")
    await page.keyboard.press("ArrowRight")
    await expect(grid.locator(".bws-card").nth(2)).toHaveClass(/bws-cursor/)
    await expectRingOn(page, ".bws-card", 2) // slide settled

    // Plain resize: 4 → 3 columns reflows (and refetches 27 cards); the band
    // must keep hugging card N°003 with no in-flight animation.
    await page.setViewportSize({ width: 1280, height: 900 })
    await expect(grid.locator(".bws-card")).toHaveCount(27, { timeout: 15000 })
    await expect(grid.locator(".bws-card").nth(2)).toHaveClass(/bws-cursor/)
    await expectRingOn(page, ".bws-card", 2)

    // Mid-flight resize: start a slide, resize before it ends — the FLIP is
    // cancelled and the band lands clean on the same cursor card.
    await page.setViewportSize({ width: 1600, height: 900 })
    await expect(grid.locator(".bws-card")).toHaveCount(28, { timeout: 15000 })
    await page.keyboard.press("ArrowDown") // cursor 2 → 6, slide starts
    await page.waitForTimeout(80) // well inside the 250ms slide
    await page.setViewportSize({ width: 1280, height: 900 })
    await expect(grid.locator(".bws-card")).toHaveCount(27, { timeout: 15000 })
    await expect(grid.locator(".bws-card").nth(6)).toHaveClass(/bws-cursor/)
    await expectRingOn(page, ".bws-card", 6)
  })
})

test.describe("Browse focus band: reduced motion (ticket 06)", () => {
  test.use({ reducedMotion: "reduce" })

  test("static and instant: no slide, no commit beat, resize still hugs", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    await mockAllEndpoints(page, pagedSearch(400))
    await page.goto("/browse?q=test", { waitUntil: "networkidle" })
    const grid = page.locator(".bws-grid")
    await expect(grid.locator(".bws-card")).toHaveCount(28, { timeout: 15000 })

    await page.keyboard.press("ArrowDown")
    await expect(grid.locator(".bws-card").nth(4)).toHaveClass(/bws-cursor/)
    // Zero animation: the band is simply there, instantly.
    const m = await measureRing(page, ".bws-card", 4)
    expect(m).not.toBeNull()
    expect(m?.anims).toBe(0)
    expect(m?.d).toBeLessThanOrEqual(1.5)

    // Enter: no commit beat — the focus view opens immediately.
    await page.evaluate(() => {
      const w = window as unknown as { __commitAt: number | null; __focusAt: number | null }
      w.__commitAt = null
      w.__focusAt = null
      new MutationObserver(() => {
        if (
          w.__commitAt === null &&
          document.querySelector(".focus-ring")?.classList.contains("commit")
        )
          w.__commitAt = performance.now()
        if (w.__focusAt === null && document.querySelector(".pfocus"))
          w.__focusAt = performance.now()
      }).observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["class"],
      })
    })
    await page.keyboard.press("Enter")
    await expect(page.locator(".pfocus")).toBeVisible()
    const t = await page.evaluate(() => {
      const w = window as unknown as { __commitAt: number | null; __focusAt: number | null }
      return { commitAt: w.__commitAt, focusAt: w.__focusAt }
    })
    expect(t.commitAt).toBeNull()
    expect(t.focusAt).not.toBeNull()
    await page.keyboard.press("Escape")
    await expect(page.locator(".pfocus")).toHaveCount(0)

    // Resize under RM: still an instant snap onto the same card.
    await page.setViewportSize({ width: 1280, height: 900 })
    await expect(grid.locator(".bws-card")).toHaveCount(27, { timeout: 15000 })
    await expectRingOn(page, ".bws-card", 4)
  })
})

/* ── Ticket 03: rail page controls (QUERY / SORT / FILTERS / 18+) ── */

test.describe("Browse rail controls (ticket 03)", () => {
  test("QUERY/SORT/FILTERS live in the rail; ⌘K only focuses the query input", async ({
    page,
  }) => {
    await bootBrowse(page)
    const rail = page.locator(".rail-controls")

    // QUERY with the ⌘K hint chip; no separate command palette exists.
    await expect(rail.locator("#bws-q")).toBeVisible()
    await expect(rail.getByText("⌘K")).toBeVisible()
    // The interim content-column controls are gone.
    await expect(page.locator(".bws .command-bar")).toHaveCount(0)
    await expect(page.locator(".bws .filter-stack")).toHaveCount(0)

    // SORT: the three-way selection row set.
    await expect(rail.getByRole("button", { name: /Trending/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    await expect(rail.getByRole("button", { name: /Rating/ })).toBeVisible()
    await expect(rail.getByRole("button", { name: /Recent/ })).toBeVisible()

    // FILTERS groups: AGE flat (Everyone only at rest), RESOLUTION open,
    // GENRE collapsed by default.
    await expect(rail.getByRole("button", { name: /Everyone/ })).toBeVisible()
    await expect(rail.getByRole("button", { name: /Questionable/ })).toHaveCount(0)
    await expect(
      rail.getByRole("button", { name: "RESOLUTION", exact: true })
    ).toBeVisible()
    await expect(rail.getByRole("button", { name: /1920x1080/ })).toBeVisible()
    await expect(rail.getByRole("button", { name: "GENRE", exact: true })).toHaveAttribute(
      "aria-expanded",
      "false"
    )
    await expect(rail.getByRole("button", { name: /Anime/ })).toHaveCount(0)

    // ⌘K / Ctrl-K focuses and selects the rail query — no palette opens.
    await page.keyboard.press("Control+k")
    await expect(rail.locator("#bws-q")).toBeFocused()
    await rail.locator("#bws-q").fill("neon")
    await page.keyboard.press("Control+k")
    await expect(rail.locator("#bws-q")).toBeFocused()
  })

  test("SORT rows drive the URL; Rating reaches the backend as sort=rating", async ({
    page,
  }) => {
    const seenSorts: string[] = []
    await page.setViewportSize({ width: 1600, height: 900 })
    await mockAllEndpoints(page, (r) => {
      seenSorts.push(new URL(r.request().url()).searchParams.get("sort") ?? "trend")
      pagedSearch(200)(r)
    })
    await page.goto("/browse?q=test", { waitUntil: "networkidle" })
    await expect(page.locator(".bws-grid .bws-card")).toHaveCount(28, { timeout: 15000 })

    const rail = page.locator(".rail-controls")
    await rail.getByRole("button", { name: /Rating/ }).click()
    await expect(page).toHaveURL(/sort=rating/)
    await expect(page.locator(".bws-title")).toHaveText("Results / Rating")
    await expect(rail.getByRole("button", { name: /Rating/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    await expect.poll(() => seenSorts).toContain("rating")

    await rail.getByRole("button", { name: /Recent/ }).click()
    await expect(page).toHaveURL(/sort=recent/)
    await expect(page.locator(".bws-title")).toHaveText("Results / Recent")
  })

  test("filter rows toggle tags, the section head counts and clears them", async ({
    page,
  }) => {
    await bootBrowse(page)
    const rail = page.locator(".rail-controls")

    await rail.getByRole("button", { name: /Everyone/ }).click()
    await expect(page).toHaveURL(/tags=Everyone/)
    await expect(rail.getByRole("button", { name: /1 ACTIVE — CLEAR/ })).toBeVisible()

    // GENRE expands, takes a second tag, and keeps the count while collapsed.
    await rail.getByRole("button", { name: "GENRE" }).click()
    await rail.getByRole("button", { name: /Anime/ }).click()
    await expect(page).toHaveURL(/tags=Everyone%2CAnime|tags=Everyone,Anime/)
    await expect(rail.getByRole("button", { name: /2 ACTIVE — CLEAR/ })).toBeVisible()
    await rail.getByRole("button", { name: /GENRE — 1/ }).click()
    await expect(rail.getByRole("button", { name: /Anime/ })).toHaveCount(0)
    await expect(rail.getByRole("button", { name: /GENRE — 1/ })).toBeVisible()

    await rail.getByRole("button", { name: /2 ACTIVE — CLEAR/ }).click()
    await expect(page).not.toHaveURL(/tags=/)
    await expect(rail.getByRole("button", { name: /ACTIVE — CLEAR/ })).toHaveCount(0)
  })

  test("18+ entry: dots at rest, reveals ● 18+ and the adult age rows on click", async ({
    page,
  }) => {
    await bootBrowse(page)
    const rail = page.locator(".rail-controls")

    // At rest: two faint dots, no 18+ label or adult rows anywhere.
    await expect(rail.getByRole("button", { name: "Toggle adult age ratings" })).toHaveText("••")
    await expect(rail.getByRole("button", { name: /18\+/ })).toHaveCount(0)
    await expect(rail.getByRole("button", { name: /Mature/ })).toHaveCount(0)

    await rail.getByRole("button", { name: "Toggle adult age ratings" }).click()
    await expect(
      rail.getByRole("button", { name: "Toggle adult age ratings" })
    ).toHaveText("● 18+")
    await expect(rail.getByRole("button", { name: /Questionable/ })).toBeVisible()
    await expect(rail.getByRole("button", { name: /Mature/ })).toBeVisible()

    // Hiding again strips a selected adult tag from the URL.
    await rail.getByRole("button", { name: /Questionable/ }).click()
    await expect(page).toHaveURL(/tags=Questionable/)
    await rail.getByRole("button", { name: "Toggle adult age ratings" }).click()
    await expect(page).not.toHaveURL(/tags=/)
    await expect(rail.getByRole("button", { name: /Questionable/ })).toHaveCount(0)
  })
})

/* ── Functional scrollbar (ticket 07, spec §2.3) ─────────────────── */

/** Boot Browse with a long mocked result set (240 total, endless pages),
 *  load `pages` pages via the sentinel, return to the top, and wait for the
 *  scrollbar's rAF loop to park (data-raf="off"). */
const bootScrollbarGrid = async (page: Page, pages = 3) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockAllEndpoints(page, pagedSearch(240))
  await page.goto("/browse?q=test", { waitUntil: "networkidle" })
  const cards = page.locator(".bws-card")
  const pageSize = Math.ceil(25 / computeColumns(1440)) * computeColumns(1440)
  await expect(cards).toHaveCount(pageSize, { timeout: 15000 })
  for (let p = 1; p < pages; p++) {
    await page.locator(".main").evaluate((el) => el.scrollTo(0, el.scrollHeight))
    await expect(cards).toHaveCount(pageSize * (p + 1), { timeout: 15000 })
  }
  await page.locator(".main").evaluate((el) => el.scrollTo(0, 0))
  await expect(page.locator(".fbar")).toHaveAttribute("data-raf", "off", { timeout: 8000 })
  return { pageSize }
}

interface BarGeometry {
  top: number
  left: number
  width: number
  H: number
  ms: number
  len: number
  y: number
}

/** Track geometry + the LOGICAL thumb rect (what the hit-test uses), mirroring
 *  the component's measure(): len = max(28, clientH/docH * H), y from the
 *  current scroll fraction. Only valid once the rAF loop has parked. */
const barGeometry = (page: Page): Promise<BarGeometry> =>
  page.evaluate(() => {
    const scroller = document.querySelector(".main") as HTMLElement
    const track = document.querySelector(".fbar") as HTMLElement
    const rect = track.getBoundingClientRect()
    const H = rect.height
    const ms = scroller.scrollHeight - scroller.clientHeight
    const len = Math.max(28, (scroller.clientHeight / scroller.scrollHeight) * H)
    const y = ms > 0 ? (scroller.scrollTop / ms) * (H - len) : 0
    return { top: rect.top, left: rect.left, width: rect.width, H, ms, len, y }
  })

test.describe("Browse functional scrollbar (ticket 07)", () => {
  test("drag syncs the scroll position with zero damping; the chip reads n / total", async ({
    page,
  }) => {
    await bootScrollbarGrid(page, 4)
    const geo = await barGeometry(page)
    const cx = geo.left + geo.width - 6.5 // thumb lane center (right: 4px, w 5px)
    const grabY = geo.top + geo.y + geo.len / 2

    await page.mouse.move(cx, grabY) // proximity wakes the bar
    await expect(page.locator(".fbar")).toHaveClass(/is-on/)
    await page.mouse.down()
    const targetY = geo.top + geo.H * 0.6
    await page.mouse.move(cx, targetY, { steps: 10 })

    // Zero damping: the scroll position is already there before mouse-up.
    // Poll instead of reading once — under suite load the drag's final rAF
    // update can land after the mouse.move roundtrip returns.
    const expectedFrac = (geo.H * 0.6 - geo.len / 2) / (geo.H - geo.len)
    await expect
      .poll(async () => {
        const scrollTop = await page.locator(".main").evaluate((el) => el.scrollTop)
        return Math.abs(scrollTop - expectedFrac * geo.ms)
      })
      .toBeLessThanOrEqual(3)

    // The thumb follows the pointer exactly (no LERP while dragging).
    await expect
      .poll(async () => {
        const thumbY = await page
          .locator(".fbar-thumb")
          .evaluate((el) => parseFloat(/translateY\(([\d.]+)px\)/.exec(el.style.transform)?.[1] ?? "NaN"))
        return Math.abs(thumbY - (geo.H * 0.6 - geo.len / 2))
      })
      .toBeLessThanOrEqual(2)

    // Hot zone: the thumb widened 5px → ~11px.
    const thumbW = await page
      .locator(".fbar-thumb")
      .evaluate((el) => parseFloat(el.style.width))
    expect(thumbW).toBeGreaterThan(9)

    // The chip reads current / total from the live scroll fraction.
    const expectedChip = await page.evaluate(() => {
      const s = document.querySelector(".main") as HTMLElement
      const ms = s.scrollHeight - s.clientHeight
      return `${Math.min(240, Math.floor((s.scrollTop / ms) * 240) + 1)} / 240`
    })
    await expect(page.locator(".fbar-chip")).toHaveClass(/is-on/)
    await expect(page.locator(".fbar-chip")).toHaveText(expectedChip)

    await page.mouse.up()
    await expect(page.locator(".fbar-chip")).not.toHaveClass(/is-on/)
  })

  test("clicking the track jumps so the thumb centers on the click", async ({ page }) => {
    await bootScrollbarGrid(page, 3)
    const geo = await barGeometry(page)
    const cx = geo.left + geo.width - 6.5
    const clickY = geo.top + geo.H * 0.55

    await page.mouse.move(cx, clickY) // wake before the click
    await expect(page.locator(".fbar")).toHaveClass(/is-on/)
    await page.mouse.click(cx, clickY)

    const expectedFrac = (geo.H * 0.55 - geo.len / 2) / (geo.H - geo.len)
    const target = expectedFrac * geo.ms
    // lenis glides to the target — poll until it lands.
    await expect
      .poll(
        async () => {
          const y = await page.locator(".main").evaluate((el) => el.scrollTop)
          return Math.abs(y - target)
        },
        { timeout: 8000 }
      )
      .toBeLessThanOrEqual(12)
  })

  test("idle ~1.4s auto-hides; scrolling or pointer near the right edge fades in", async ({
    page,
  }) => {
    await bootScrollbarGrid(page, 3)
    const bar = page.locator(".fbar")

    // The boot wake shows the bar; after the idle window it fades out.
    await expect(bar).not.toHaveClass(/is-on/, { timeout: 4000 })

    // Scrolling fades it back in…
    await page.mouse.move(720, 450)
    await page.mouse.wheel(0, 600)
    await expect(bar).toHaveClass(/is-on/)
    await page.waitForTimeout(1600)
    await expect(bar).not.toHaveClass(/is-on/)

    // …as does the pointer approaching the right edge.
    await page.mouse.move(1439, 450)
    await expect(bar).toHaveClass(/is-on/)
  })

  test("an infinite-scroll append shrinks the thumb smoothly, never in one jump", async ({
    page,
  }) => {
    const { pageSize } = await bootScrollbarGrid(page, 1)
    const heightOf = () =>
      page.locator(".fbar-thumb").evaluate((el) => parseFloat(el.style.height))
    const before = await heightOf()

    // Append page 2 via the sentinel, then sample the thumb height per frame.
    await page.locator(".main").evaluate((el) => el.scrollTo(0, el.scrollHeight))
    await expect(page.locator(".bws-card")).toHaveCount(pageSize * 2, { timeout: 15000 })
    const samples = await page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const thumb = document.querySelector(".fbar-thumb") as HTMLElement
          const out: number[] = []
          const tick = () => {
            out.push(parseFloat(thumb.style.height))
            if (out.length >= 26) resolve(out)
            else requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
    )

    const first = samples[0]
    const last = samples[samples.length - 1]
    expect(last).toBeLessThan(before - 2) // the append really shrank it
    expect(first).toBeGreaterThan(last + 2) // …and it didn't jump straight there
    // Smooth glide: many intermediate values, monotonically non-increasing.
    expect(new Set(samples.map((v) => v.toFixed(1))).size).toBeGreaterThan(4)
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeLessThanOrEqual(samples[i - 1] + 0.6)
    }
    // Converged to the new logical length.
    const expected = await page.evaluate(() => {
      const s = document.querySelector(".main") as HTMLElement
      const track = document.querySelector(".fbar") as HTMLElement
      return Math.max(28, (s.clientHeight / s.scrollHeight) * track.getBoundingClientRect().height)
    })
    expect(Math.abs(last - expected)).toBeLessThanOrEqual(2)
  })

  test("PAGE graduations are etched on the canvas layer, one per loaded page", async ({
    page,
  }) => {
    await bootScrollbarGrid(page, 3)
    await expect(page.locator(".fbar-canvas")).toHaveCount(1)
    await expect(page.locator(".fbar")).toHaveAttribute("data-ticks", "3")
  })

  test("the rAF loop parks 300ms after rest and wakes on scroll (spec §5 F8)", async ({
    page,
  }) => {
    await bootScrollbarGrid(page, 3) // returns with the loop parked
    const bar = page.locator(".fbar")
    await expect(bar).toHaveAttribute("data-raf", "off")

    await page.mouse.move(720, 450)
    await page.mouse.wheel(0, 400)
    await expect(bar).toHaveAttribute("data-raf", "on")
    await expect(bar).toHaveAttribute("data-raf", "off", { timeout: 8000 })
  })

  test("the glass thumb is real backdrop-filter material, in both themes", async ({ page }) => {
    await bootScrollbarGrid(page, 1)
    const thumb = page.locator(".fbar-thumb")
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark"
    })
    const darkFilter = await thumb.evaluate((el) => getComputedStyle(el).backdropFilter)
    expect(darkFilter).toContain("blur(28px)")
    expect(darkFilter).toContain("saturate(1.8)")
    expect(darkFilter).toContain("brightness(1.12)")
    const darkFill = await thumb.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(darkFill).toBe("rgba(255, 255, 255, 0.07)")

    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light"
    })
    const lightFill = await thumb.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(lightFill).toBe("rgba(255, 255, 255, 0.32)")
  })
})

test.describe("Browse functional scrollbar: reduced motion (ticket 07)", () => {
  test.use({ reducedMotion: "reduce" })

  test("falls back to the native thin scrollbar — no overlay, nothing hidden", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await mockAllEndpoints(page, pagedSearch(240))
    await page.goto("/browse?q=test", { waitUntil: "networkidle" })
    const pageSize = Math.ceil(25 / computeColumns(1440)) * computeColumns(1440)
    await expect(page.locator(".bws-card")).toHaveCount(pageSize, { timeout: 15000 })

    await expect(page.locator(".fbar")).toHaveCount(0)
    await expect(page.locator("html")).not.toHaveClass(/pt-fbar/)
    const scrollbarWidth = await page
      .locator(".main")
      .evaluate((el) => getComputedStyle(el).scrollbarWidth)
    expect(scrollbarWidth).toBe("thin")
  })
})
