import { expect, test } from "playwright/test"
import type { Page } from "playwright"
import type { ActivityTask } from "@pwe/shared"
import { mockSystemSummary } from "./fixtures.js"

const summary = mockSystemSummary()

const mockStorage = (
  page: Page,
  migration: { state: "running" | "done" | "failed"; moved_bytes: number; total_bytes: number; error: string | null } | null = null
) =>
  page.route("**/api/storage", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: true,
        data_root: "/mock/data",
        default_root: "/mock/data",
        using_default: true,
        last_error: null,
        migration,
      }),
    })
  )

/** Boot the minimal mocks needed to render the app shell on the Activity page. */
const mockShellEndpoints = async (
  page: Page,
  { mockTasks = true }: { mockTasks?: boolean } = {}
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
  await mockStorage(page)
  if (mockTasks) {
    await page.route("**/api/download/tasks**", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], total: 0 }) })
    )
  }
}

test.describe("Activity routing", () => {
  test("canonical route is /activity", async ({ page }) => {
    await mockShellEndpoints(page)
    await page.goto("/activity", { waitUntil: "networkidle" })
    await expect(page).toHaveURL(/\/activity$/)
    await expect(page.locator("h1.act-title")).toContainText("Activity")
    await expect(page.locator(".rail-nav-link", { hasText: "Activity" })).toHaveClass(/is-here/)
  })

  test("legacy /downloads redirects to /activity", async ({ page }) => {
    await mockShellEndpoints(page)
    await page.goto("/downloads", { waitUntil: "networkidle" })
    await expect(page).toHaveURL(/\/activity$/)
    await expect(page.locator("h1.act-title")).toContainText("Activity")
  })

  test("legacy /transcode redirects to /activity", async ({ page }) => {
    await mockShellEndpoints(page)
    await page.goto("/transcode", { waitUntil: "networkidle" })
    await expect(page).toHaveURL(/\/activity$/)
    await expect(page.locator("h1.act-title")).toContainText("Activity")
  })
})

const mockTask = (overrides: Partial<ActivityTask> = {}): ActivityTask => ({
  task_id: "task-1",
  task_type: "transcode",
  workshop_id: "1693728660",
  title: "Love Death Robots",
  preview_url: "",
  content_rating: "Everyone",
  rating_sex: null,
  adult_hint: 0,
  stage: "running",
  message: "",
  started_at: Date.now() - 60_000,
  finished_at: null,
  percent: 50,
  bytes_done: null,
  bytes_total: null,
  ...overrides,
})

/** Serve tasks from mutable lists: the active page polls `active=1` every
 *  second, so reassigning `getActive`/`getHistory` between assertions drives
 *  stage transitions the same way the real backend does. */
const mockTaskQueues = (
  page: Page,
  queues: { getActive: () => ActivityTask[]; getHistory: () => ActivityTask[]; activeTotal?: number }
) =>
  page.route("**/api/download/tasks**", (route) => {
    if (route.request().method() !== "GET") return route.fallback()
    const active = new URL(route.request().url()).searchParams.get("active") === "1"
    const items = active ? queues.getActive() : queues.getHistory()
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items,
        total: active ? (queues.activeTotal ?? items.length) : items.length,
      }),
    })
  })

const activeSection = (page: Page) => page.getByRole("region", { name: "Active tasks" })
const finishedSection = (page: Page) => page.getByRole("region", { name: "Finished tasks" })

test("active summary uses the unpaginated total", async ({ page }) => {
  await mockShellEndpoints(page, { mockTasks: false })

  const activeItems = Array.from({ length: 50 }, (_, index) =>
    mockTask({
      task_id: `task-${index}`,
      workshop_id: String(1_000_000 + index),
      title: `Wallpaper ${index}`,
      content_rating: index < 8 ? "Mature" : "Everyone",
    })
  )
  await page.route("**/api/download/tasks**", (route) => {
    const active = new URL(route.request().url()).searchParams.get("active") === "1"
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(active ? { items: activeItems, total: 65 } : { items: [], total: 0 }),
    })
  })

  await page.goto("/activity")

  // The header ACTIVE count is the server's unpaginated total (65), while
  // the section renders the first page (50) minus the safe-filtered (8).
  await expect(page.locator(".act-count")).toHaveText("65 ACTIVE — 0 FINISHED — 0 FAILED")
  await expect(activeSection(page).locator(".act-row")).toHaveCount(42)
})

test.describe("Activity resilience to aborted fetches", () => {
  // iOS Safari aborts in-flight fetches when the page is backgrounded. When
  // the user returns, that rejection lands in SWR as an error — the page must
  // keep rendering the cached task list, not replace it with an error state.
  test("an aborted history fetch does not blow away the rendered list", async ({ page }) => {
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
    await mockStorage(page)

    let activeItems: ActivityTask[] = [mockTask()]
    let abortNextHistory = false
    let historyAborted: (() => void) | undefined
    const abortHappened = new Promise<void>((res) => {
      historyAborted = res
    })

    await page.route("**/api/download/tasks**", (route) => {
      const url = new URL(route.request().url())
      if (url.searchParams.get("active") === "1") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: activeItems, total: activeItems.length }),
        })
      }
      if (abortNextHistory) {
        abortNextHistory = false
        historyAborted?.()
        return route.abort("aborted")
      }
      const items = [mockTask({ stage: activeItems.length ? "running" : "complete", finished_at: activeItems.length ? null : Date.now() })]
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items, total: items.length }),
      })
    })

    await page.goto("/activity")
    await expect(page.getByText("Love Death Robots")).toBeVisible()

    // The task reaches a terminal stage while the next history revalidation
    // gets aborted — the same shape as a Safari background/foreground cycle.
    abortNextHistory = true
    activeItems = []
    await abortHappened

    // Give the poll + revalidation cycle time to settle, then assert the list
    // survived: cached data stays on screen, no full-page error.
    await page.waitForTimeout(1500)
    await expect(page.getByText("Love Death Robots")).toBeVisible()
    await expect(page.locator(".bws-state-error")).toHaveCount(0)
  })
})

test.describe("Activity page (ticket 09)", () => {
  test("header counts, two sections, and full row anatomy", async ({ page }) => {
    await mockShellEndpoints(page, { mockTasks: false })
    const active = [
      mockTask({
        task_id: "dl-1",
        task_type: "download",
        title: "Neon Drive",
        stage: "downloading",
        percent: 42.4,
        bytes_done: 420_000_000,
        bytes_total: 1_000_000_000,
      }),
    ]
    const history = [
      mockTask({
        task_id: "dl-2",
        task_type: "download",
        title: "Done Paper",
        stage: "complete",
        finished_at: Date.now() - 30_000,
        percent: 100,
      }),
      mockTask({
        task_id: "tc-1",
        task_type: "transcode",
        title: "Broken Paper",
        stage: "failed",
        message: "ffmpeg exited 1",
        finished_at: Date.now() - 20_000,
        percent: null,
      }),
    ]
    await mockTaskQueues(page, { getActive: () => active, getHistory: () => history })

    await page.goto("/activity")

    await expect(page.locator(".act-count")).toHaveText("1 ACTIVE — 2 FINISHED — 1 FAILED")
    await expect(activeSection(page).locator(".act-sec-head")).toContainText("ACTIVE")
    await expect(finishedSection(page).locator(".act-sec-head")).toContainText("FINISHED")

    const row = activeSection(page).locator(".act-row", { hasText: "Neon Drive" })
    await expect(row.locator(".act-thumb")).toBeVisible()
    await expect(row.locator(".act-row-title")).toHaveText("Neon Drive")
    await expect(row.locator(".act-type")).toHaveText("DOWNLOAD")
    await expect(row.locator(".act-stage")).toHaveText("DOWNLOADING")
    await expect(row.locator(".act-line2")).toContainText("ID 1693728660")
    await expect(row.locator(".act-line2")).toContainText("42%")
    await expect(row.locator(".act-bar")).toHaveAttribute("role", "progressbar")
    await expect(row.locator(".act-bar")).toHaveAttribute("aria-valuenow", "42.4")
    // Determinate progress fills via transform, never width (spec §5 F8).
    const fill = row.locator(".act-bar-fill")
    const transform = await fill.evaluate((el) => el.style.transform)
    expect(transform).toMatch(/^scaleX\(/)
    const origin = await fill.evaluate((el) => getComputedStyle(el).transformOrigin)
    expect(origin.startsWith("0px")).toBe(true)
  })

  test("indeterminate rows run the scan segment instead of a fill", async ({ page }) => {
    await mockShellEndpoints(page, { mockTasks: false })
    const active = [
      mockTask({ task_id: "dl-3", task_type: "download", title: "Idle Paper", stage: "starting", percent: null }),
    ]
    await mockTaskQueues(page, { getActive: () => active, getHistory: () => [] })

    await page.goto("/activity")
    const idleRow = activeSection(page).locator(".act-row", { hasText: "Idle Paper" })
    await expect(idleRow.locator(".act-bar-indet")).toBeVisible()
    await expect(idleRow.locator(".act-bar-fill")).toHaveCount(0)
    await expect(idleRow.locator(".act-bar")).not.toHaveAttribute("aria-valuenow", /.+/)
  })

  test("stage pill remounts and plays the 300ms flip-in on stage change", async ({ page }) => {
    await mockShellEndpoints(page, { mockTasks: false })
    let active = [
      mockTask({ task_id: "dl-1", task_type: "download", title: "Flip Paper", stage: "downloading" }),
    ]
    await mockTaskQueues(page, { getActive: () => active, getHistory: () => [] })

    await page.goto("/activity")
    const pill = activeSection(page).locator(".act-row .act-stage")
    await expect(pill).toHaveText("DOWNLOADING")

    // The app's SWRConfig dedupes the 1s poll into ~10s network refreshes;
    // the stage flip lands on the next refresh window.
    active = [mockTask({ task_id: "dl-1", task_type: "download", title: "Flip Paper", stage: "finalizing" })]
    // Check in the same frame the text flips: the pill remounts on stage
    // change, so its 300ms entrance animation must be running right then.
    const flip = await page.waitForFunction(
      () => {
        const el = document.querySelector(".act-row .act-stage")
        if (!el || el.textContent !== "FINALIZING") return false
        return el.getAnimations().length > 0 ? "animating" : "not-animating"
      },
      undefined,
      { timeout: 15000, polling: "raf" }
    )
    expect(await flip.jsonValue()).toBe("animating")
    await expect(pill).toHaveCSS("animation-duration", "0.3s")
  })

  test("settle beat: terminal row holds in ACTIVE ~1.4s, COMPLETE pill flashes twice, then drops to FINISHED", async ({
    page,
  }) => {
    await mockShellEndpoints(page, { mockTasks: false })
    let active: ActivityTask[] = [
      mockTask({ task_id: "dl-1", task_type: "download", title: "Settle Paper", stage: "downloading" }),
    ]
    let history: ActivityTask[] = []
    await mockTaskQueues(page, { getActive: () => active, getHistory: () => history })

    await page.goto("/activity")
    await expect(activeSection(page).locator(".act-row", { hasText: "Settle Paper" })).toHaveCount(1)

    // The task lands: it leaves the active set, history reports COMPLETE.
    active = []
    history = [
      mockTask({
        task_id: "dl-1",
        task_type: "download",
        title: "Settle Paper",
        stage: "complete",
        finished_at: Date.now(),
        percent: 100,
      }),
    ]

    const pill = page.locator(".act-row", { hasText: "Settle Paper" }).locator(".act-stage")
    // The app's SWRConfig dedupes the 1s poll into ~10s network refreshes;
    // the terminal stage lands on the next refresh window.
    await expect(pill).toHaveText("COMPLETE", { timeout: 15000 })
    const detectedAt = Date.now()

    // The row is pinned in ACTIVE with the settle class; the pill flashes
    // inverse twice at 700ms per iteration (§5 exception 700×2+1400).
    const row = page.locator(".act-row", { hasText: "Settle Paper" })
    await expect(row).toHaveClass(/act-settle/)
    await expect(activeSection(page).locator(".act-row", { hasText: "Settle Paper" })).toHaveCount(1)
    await expect(pill).toHaveCSS("animation-name", "act-flash")
    await expect(pill).toHaveCSS("animation-duration", "0.7s")
    await expect(pill).toHaveCSS("animation-iteration-count", "2")

    // After the ~1.4s hold the row drops into FINISHED.
    await expect(finishedSection(page).locator(".act-row", { hasText: "Settle Paper" })).toHaveCount(1, {
      timeout: 6000,
    })
    expect(Date.now() - detectedAt).toBeGreaterThan(1000)
    await expect(activeSection(page).locator(".act-row")).toHaveCount(0)
  })

  test("failed rows expand a red mono ERR line with RETRY + DISMISS", async ({ page }) => {
    await mockShellEndpoints(page, { mockTasks: false })
    const history = [
      mockTask({
        task_id: "dl-err",
        task_type: "download",
        title: "Failed Paper",
        stage: "error",
        message: "Disk full",
        finished_at: Date.now() - 10_000,
        percent: null,
      }),
    ]
    await mockTaskQueues(page, { getActive: () => [], getHistory: () => history })

    await page.goto("/activity")
    const row = finishedSection(page).locator(".act-row", { hasText: "Failed Paper" })
    await expect(row.locator(".act-errline")).toHaveText("ERR — Disk full")
    // Error red comes from --pt-danger; compare against the FAILED pill
    // (same token) so the assertion holds in both themes.
    const errColor = await row.locator(".act-errline").evaluate((el) => getComputedStyle(el).color)
    const pillColor = await row.locator(".act-stage").evaluate((el) => getComputedStyle(el).color)
    expect(errColor).toBe(pillColor)
    await expect(row.locator(".act-stage")).toHaveText("FAILED")
    await expect(row.getByRole("button", { name: "RETRY" })).toBeVisible()
    await expect(row.getByRole("button", { name: "DISMISS" })).toBeVisible()
  })

  test("row actions: downloads can be cancelled, transcodes cannot (production parity)", async ({
    page,
  }) => {
    await mockShellEndpoints(page, { mockTasks: false })
    let cancelledId: string | null = null
    await page.route("**/api/download/*/cancel", (route) => {
      cancelledId = new URL(route.request().url()).pathname.split("/")[3] ?? null
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      })
    })
    const active = [
      mockTask({ task_id: "dl-1", task_type: "download", title: "DL Paper", stage: "downloading" }),
      mockTask({ task_id: "tc-1", task_type: "transcode", title: "TX Paper", stage: "running" }),
    ]
    await mockTaskQueues(page, { getActive: () => active, getHistory: () => [] })

    await page.goto("/activity")
    const dlRow = activeSection(page).locator(".act-row", { hasText: "DL Paper" })
    const tcRow = activeSection(page).locator(".act-row", { hasText: "TX Paper" })
    await expect(dlRow.getByRole("button", { name: "CANCEL" })).toBeVisible()
    await expect(tcRow.getByRole("button", { name: "CANCEL" })).toHaveCount(0)

    await dlRow.getByRole("button", { name: "CANCEL" }).click()
    await expect.poll(() => cancelledId).toBe("1693728660")
  })

  test("migration row: COPY → VERIFY → SWITCH → CLEANUP phases and CANCEL", async ({ page }) => {
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
    await mockTaskQueues(page, { getActive: () => [], getHistory: () => [] })

    let migration: { state: "running" | "done" | "failed"; moved_bytes: number; total_bytes: number; error: string | null } | null =
      { state: "running", moved_bytes: 400_000_000, total_bytes: 1_000_000_000, error: null }
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
          migration,
        }),
      })
    )
    let cancelHits = 0
    await page.route("**/api/storage/cancel", (r) => {
      cancelHits += 1
      migration = null
      return r.fulfill({
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
    })

    await page.goto("/activity")
    const row = activeSection(page).locator(".act-row", { hasText: "Storage migration" })
    await expect(row).toBeVisible()
    await expect(row.locator(".act-type")).toHaveText("MIGRATION")
    await expect(row.locator(".act-stage")).toHaveText("RUNNING")
    // Bytes still moving → COPY is the current phase, the rest unreached.
    await expect(row.locator(".act-phases")).toContainText("◉ COPY")
    await expect(row.locator(".act-phases")).toContainText("○ VERIFY")
    await expect(row.locator(".act-phases")).toContainText("○ SWITCH")
    await expect(row.locator(".act-phases")).toContainText("○ CLEANUP")
    // The migration row counts toward the header's ACTIVE total.
    await expect(page.locator(".act-count")).toHaveText("1 ACTIVE — 0 FINISHED — 0 FAILED")

    // All bytes landed → COPY done, VERIFY current (switch/cleanup are
    // uninterruptible and only ever surface as reached at DONE).
    migration = { state: "running", moved_bytes: 1_000_000_000, total_bytes: 1_000_000_000, error: null }
    await expect(row.locator(".act-phases")).toContainText("● COPY", { timeout: 15000 })
    await expect(row.locator(".act-phases")).toContainText("◉ VERIFY")

    await row.getByRole("button", { name: "CANCEL" }).click()
    await expect.poll(() => cancelHits).toBe(1)
    await expect(activeSection(page).locator(".act-row")).toHaveCount(0)
  })

  test("rail HOUSEKEEPING: clear completed / clear failed / retry failed transcodes", async ({
    page,
  }) => {
    await mockShellEndpoints(page, { mockTasks: false })
    await mockTaskQueues(page, { getActive: () => [], getHistory: () => [] })
    const deletes: string[] = []
    await page.route("**/api/download/tasks**", (route) => {
      if (route.request().method() !== "DELETE") return route.fallback()
      deletes.push(new URL(route.request().url()).search)
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) })
    })
    let retryAllHits = 0
    await page.route("**/api/library/transcode/retry-all", (route) => {
      retryAllHits += 1
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, queued: 0, skipped: 0, invalid: 0 }),
      })
    })

    await page.goto("/activity")
    const rail = page.locator(".rail")
    await expect(rail.locator(".lib-rc-title", { hasText: "HOUSEKEEPING" })).toBeVisible()

    await rail.getByRole("button", { name: /Clear completed/ }).click()
    await expect.poll(() => deletes).toContain("?stage=complete")

    await rail.getByRole("button", { name: /Clear failed/ }).click()
    await expect.poll(() => deletes).toContain("?stage=error")

    await rail.getByRole("button", { name: /Retry failed transcodes/ }).click()
    await expect.poll(() => retryAllHits).toBe(1)
  })

  test("reduced motion: no settle hold or flash, terminal rows drop straight to FINISHED with no information lost", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" })
    await mockShellEndpoints(page, { mockTasks: false })
    let active: ActivityTask[] = [
      mockTask({ task_id: "dl-1", task_type: "download", title: "RM Paper", stage: "downloading" }),
    ]
    let history: ActivityTask[] = [
      mockTask({
        task_id: "dl-err",
        task_type: "download",
        title: "RM Failed",
        stage: "error",
        message: "Disk full",
        finished_at: Date.now() - 10_000,
        percent: null,
      }),
    ]
    await mockTaskQueues(page, { getActive: () => active, getHistory: () => history })

    await page.goto("/activity")
    await expect(activeSection(page).locator(".act-row", { hasText: "RM Paper" })).toHaveCount(1)

    active = []
    history = [
      ...history,
      mockTask({
        task_id: "dl-1",
        task_type: "download",
        title: "RM Paper",
        stage: "complete",
        finished_at: Date.now(),
        percent: 100,
      }),
    ]

    // No settle beat: the row lands directly in FINISHED once the next
    // refresh window reports the terminal stage (SWR dedupe makes that
    // window ~10s), and the settle class never appears.
    const landed = finishedSection(page).locator(".act-row", { hasText: "RM Paper" })
    await expect(landed.locator(".act-stage")).toHaveText("COMPLETE", { timeout: 15000 })
    await expect(activeSection(page).locator(".act-row", { hasText: "RM Paper" })).toHaveCount(0)
    await expect(page.locator(".act-settle")).toHaveCount(0)
    // Terminal state, error line and header counts are all still rendered.
    await expect(finishedSection(page).locator(".act-stage", { hasText: "COMPLETE" })).toHaveCount(1)
    await expect(finishedSection(page).locator(".act-errline")).toHaveText("ERR — Disk full")
    await expect(page.locator(".act-count")).toHaveText("0 ACTIVE — 2 FINISHED — 1 FAILED")
  })
})
