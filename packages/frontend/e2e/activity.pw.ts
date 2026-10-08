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
    // The ~10s SWR refresh window plus the 1.4s beat stack up; under suite
    // load expect polling adds seconds more than the 30s default allows.
    test.setTimeout(60_000)
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
    // Measure the beat IN PAGE with a MutationObserver: under suite load the
    // expect polling cadence can land after the whole ~1.4s settle window
    // (the poll first sees COMPLETE once the row has already dropped), so
    // every mid-window fact — settle class, pill text, flash animation — is
    // recorded in the same observer callback that first sees the class flip.
    // (Earlier round: a wall-clock delta from the poll moment misread the
    // hold as ~0.4s — observed 441ms vs the >1000 assertion.)
    const beatPromise = page.evaluate(
      () =>
        new Promise<{
          holdMs: number
          pillText: string
          animName: string
          animDur: string
          animIter: string
        }>((resolve) => {
          const active = document.querySelector('section[aria-label="Active tasks"]')!
          const finished = document.querySelector('section[aria-label="Finished tasks"]')!
          let settleAt = -1
          let pillText = ""
          let animName = ""
          let animDur = ""
          let animIter = ""
          const obs = new MutationObserver(() => {
            const row = [...active.querySelectorAll(".act-row")].find((r) =>
              r.textContent?.includes("Settle Paper")
            )
            if (settleAt < 0) {
              if (row?.classList.contains("act-settle")) {
                settleAt = performance.now()
                const pillEl = row.querySelector(".act-stage")
                pillText = pillEl?.textContent ?? ""
                const cs = pillEl ? getComputedStyle(pillEl) : null
                animName = cs?.animationName ?? ""
                animDur = cs?.animationDuration ?? ""
                animIter = cs?.animationIterationCount ?? ""
              }
            } else if (!row && finished.textContent?.includes("Settle Paper")) {
              obs.disconnect()
              resolve({ holdMs: performance.now() - settleAt, pillText, animName, animDur, animIter })
            }
          })
          obs.observe(document.body, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["class"],
          })
        })
    )
    // The app's SWRConfig dedupes the 1s poll into ~10s network refreshes;
    // the terminal stage lands on the next refresh window.
    await expect(pill).toHaveText("COMPLETE", { timeout: 15000 })

    // After the ~1.4s hold the row drops into FINISHED.
    await expect(finishedSection(page).locator(".act-row", { hasText: "Settle Paper" })).toHaveCount(1, {
      timeout: 15000,
    })
    const beat = await beatPromise

    // While held in ACTIVE the row carried the settle class and the pill
    // flashed inverse twice at 700ms per iteration (§5 exception 700×2+1400).
    expect(beat.pillText).toBe("COMPLETE")
    expect(beat.animName).toBe("act-flash")
    expect(beat.animDur).toBe("0.7s")
    expect(beat.animIter).toBe("2")
    expect(beat.holdMs).toBeGreaterThan(1000)
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

/* ── Mobile Activity (mobile-impl ticket 04, spec §4.3 / §7.3) ────────
   The mobile page runs the SAME lifted queue state machine as desktop:
   storage migration polling + row synthesis + settle beat + done/fail
   sound triggers live in `useActivityQueue`. These assertions pin the
   §4.3 fidelity restorations and the §4.3 correction table. */
test.describe("Mobile Activity (ticket 04)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test("single-slot title, restored header count, and the QUEUE command row", async ({ page }) => {
    await mockShellEndpoints(page, { mockTasks: false })
    const active = [
      mockTask({ task_id: "dl-1", task_type: "download", title: "Neon Drive", stage: "downloading" }),
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
    await expect(page.locator(".mobile-shell")).toBeVisible()

    // §4.3 correction: the title is a single slot — "Activity" only, the
    // desktop rail chrome "/ Queue" does not render on touch.
    const title = page.locator("h1.act-title")
    await expect(title).toHaveText("Activity")

    // §4.3 restoration: the count readout renders `n ACTIVE — m FINISHED — k FAILED`.
    await expect(page.locator(".act-count")).toHaveText("1 ACTIVE — 2 FINISHED — 1 FAILED")

    // §4.3 correction: QUEUE… moved from the header's right edge to a
    // command row UNDER the header (44px touch target).
    const queue = page.getByRole("button", { name: "QUEUE…", exact: true })
    await expect(queue).toBeVisible()
    await expect(page.locator(".act-head", { has: queue })).toHaveCount(0)
    const head = page.locator(".act-head")
    const headBox = (await head.boundingBox())!
    const queueBox = (await queue.boundingBox())!
    expect(queueBox.y).toBeGreaterThanOrEqual(headBox.y + headBox.height)
    expect(queueBox.height).toBeGreaterThanOrEqual(44)
  })

  test("mobile settle beat: 1.4s dwell, COMPLETE pill flashes inverse ×2, then drops to FINISHED", async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await mockShellEndpoints(page, { mockTasks: false })
    let active: ActivityTask[] = [
      mockTask({ task_id: "dl-1", task_type: "download", title: "Settle Paper", stage: "downloading" }),
    ]
    let history: ActivityTask[] = []
    await mockTaskQueues(page, { getActive: () => active, getHistory: () => history })

    await page.goto("/activity")
    await expect(activeSection(page).locator(".act-row", { hasText: "Settle Paper" })).toHaveCount(1)

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
    // In-page MutationObserver records every mid-window fact the frame the
    // settle class lands (the desktop settle test registers why expect
    // polling alone is too coarse under suite load).
    const beatPromise = page.evaluate(
      () =>
        new Promise<{
          holdMs: number
          pillText: string
          animName: string
          animDur: string
          animIter: string
        }>((resolve) => {
          const active = document.querySelector('section[aria-label="Active tasks"]')!
          const finished = document.querySelector('section[aria-label="Finished tasks"]')!
          let settleAt = -1
          let pillText = ""
          let animName = ""
          let animDur = ""
          let animIter = ""
          const obs = new MutationObserver(() => {
            const row = [...active.querySelectorAll(".act-row")].find((r) =>
              r.textContent?.includes("Settle Paper")
            )
            if (settleAt < 0) {
              if (row?.classList.contains("act-settle")) {
                settleAt = performance.now()
                const pillEl = row.querySelector(".act-stage")
                pillText = pillEl?.textContent ?? ""
                const cs = pillEl ? getComputedStyle(pillEl) : null
                animName = cs?.animationName ?? ""
                animDur = cs?.animationDuration ?? ""
                animIter = cs?.animationIterationCount ?? ""
              }
            } else if (!row && finished.textContent?.includes("Settle Paper")) {
              obs.disconnect()
              resolve({ holdMs: performance.now() - settleAt, pillText, animName, animDur, animIter })
            }
          })
          obs.observe(document.body, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["class"],
          })
        })
    )
    await expect(pill).toHaveText("COMPLETE", { timeout: 15000 })
    await expect(finishedSection(page).locator(".act-row", { hasText: "Settle Paper" })).toHaveCount(1, {
      timeout: 15000,
    })
    const beat = await beatPromise
    expect(beat.pillText).toBe("COMPLETE")
    expect(beat.animName).toBe("act-flash")
    expect(beat.animDur).toBe("0.7s")
    expect(beat.animIter).toBe("2")
    expect(beat.holdMs).toBeGreaterThan(1000)
    await expect(activeSection(page).locator(".act-row")).toHaveCount(0)
  })

  test("mobile migration row: four-phase readout, hidden during the settle dwell, counts as ACTIVE", async ({
    page,
  }) => {
    test.setTimeout(60_000)
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

    let migration: {
      state: "running" | "done" | "failed"
      moved_bytes: number
      total_bytes: number
      error: string | null
    } | null = { state: "running", moved_bytes: 400_000_000, total_bytes: 1_000_000_000, error: null }
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

    await page.goto("/activity")
    await expect(page.locator(".mobile-shell")).toBeVisible()
    const row = activeSection(page).locator(".act-row", { hasText: "Storage migration" })
    await expect(row).toBeVisible()
    await expect(row.locator(".act-type")).toHaveText("MIGRATION")
    // The four-phase readout is restored on mobile: COPY current, the rest
    // unreached while bytes are still moving.
    await expect(row.locator(".act-phases")).toContainText("◉ COPY")
    await expect(row.locator(".act-phases")).toContainText("○ VERIFY")
    await expect(row.locator(".act-phases")).toContainText("○ SWITCH")
    await expect(row.locator(".act-phases")).toContainText("○ CLEANUP")
    await expect(page.locator(".act-count")).toHaveText("1 ACTIVE — 0 FINISHED — 0 FAILED")

    // Land the migration: the row starts the settle dwell, and the phase
    // readout is hidden during it (desktop parity: phases render only
    // while !terminal).
    migration = { state: "done", moved_bytes: 1_000_000_000, total_bytes: 1_000_000_000, error: null }
    const settleRow = page.locator(".act-row", { hasText: "Storage migration" })
    await expect(settleRow).toHaveClass(/act-settle/, { timeout: 15000 })
    await expect(settleRow.locator(".act-stage")).toHaveText("COMPLETE")
    await expect(settleRow.locator(".act-phases")).toHaveCount(0)

    await expect(finishedSection(page).locator(".act-row", { hasText: "Storage migration" })).toHaveCount(1, {
      timeout: 15000,
    })
  })

  test("mobile row actions: downloads cancel, transcodes cannot (production parity)", async ({ page }) => {
    await mockShellEndpoints(page, { mockTasks: false })
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

    // §4.3 correction: mono 10px copied from the desktop .act-act slot.
    const cancel = dlRow.getByRole("button", { name: "CANCEL" })
    expect(await cancel.evaluate((el) => getComputedStyle(el).fontSize)).toBe("10px")
    expect((await cancel.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    // Press vocabulary: the dither band + carved window replace any
    // :active flat-fill on the shell.
    await expect(cancel).toHaveAttribute("data-press", "cmd")
  })

  test("mobile row action press: drag-away cancels the commit", async ({ page }) => {
    await mockShellEndpoints(page, { mockTasks: false })
    const active = [
      mockTask({ task_id: "dl-1", task_type: "download", title: "DL Paper", stage: "downloading" }),
    ]
    await mockTaskQueues(page, { getActive: () => active, getHistory: () => [] })
    let cancelHits = 0
    await page.route("**/api/download/*/cancel", (route) => {
      cancelHits += 1
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) })
    })

    await page.goto("/activity")
    const cancel = activeSection(page)
      .locator(".act-row", { hasText: "DL Paper" })
      .getByRole("button", { name: "CANCEL" })
    await expect(cancel).toBeVisible()

    // press → dither on → drag past the 10px slop → release outside: no
    // commit fires (the press vocabulary's drag-away cancel).
    const box = (await cancel.boundingBox())!
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await expect(cancel).toHaveClass(/pressing/)
    await page.mouse.move(cx + 30, cy + 30, { steps: 4 })
    await page.mouse.up()
    await expect(cancel).not.toHaveClass(/pressing/)
    await page.waitForTimeout(200)
    expect(cancelHits).toBe(0)

    // And a clean press still commits.
    await cancel.click()
    await expect.poll(() => cancelHits).toBe(1)
  })

  test("housekeeping sheet: auto detent, 52px ledger command rows, Safe/All segmented", async ({
    page,
  }) => {
    await mockShellEndpoints(page, { mockTasks: false })
    const active = [
      mockTask({
        task_id: "dl-adult",
        task_type: "download",
        title: "Adult Paper",
        stage: "downloading",
        content_rating: "Mature",
      }),
    ]
    await mockTaskQueues(page, { getActive: () => active, getHistory: () => [] })
    const deletes: string[] = []
    await page.route("**/api/download/tasks**", (route) => {
      if (route.request().method() !== "DELETE") return route.fallback()
      deletes.push(new URL(route.request().url()).search)
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) })
    })

    await page.goto("/activity")
    await page.getByRole("button", { name: "QUEUE…", exact: true }).tap()
    const sheet = page.locator(".mobile-sheet.open")
    await expect(sheet.locator(".mobile-sheet-title")).toHaveText("Queue")

    // §4.3: HOUSEKEEPING section head (9px mono) + three 52px ledger
    // command rows (mono name left, dotted leader, → right anchor).
    await expect(sheet.locator(".actm-sec", { hasText: "HOUSEKEEPING" })).toBeVisible()
    const rows = sheet.locator(".actm-ledger")
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0)).toContainText("Clear completed")
    await expect(rows.nth(1)).toContainText("Clear failed")
    await expect(rows.nth(2)).toContainText("Retry failed transcodes")
    for (const name of ["Clear completed", "Clear failed", "Retry failed transcodes"]) {
      const box = (await sheet.getByRole("button", { name: `${name} →` }).boundingBox())!
      expect(box.height).toBeGreaterThanOrEqual(52)
    }

    // §4.3: SAFE QUEUE section + note + Safe/All segmented (aria-pressed
    // assertion surface unchanged from §7.3).
    await expect(sheet.locator(".actm-sec", { hasText: "SAFE QUEUE" })).toBeVisible()
    await expect(sheet.locator(".actm-privacy-note")).toContainText("1 mature task hidden")
    const all = sheet.getByRole("button", { name: "All", exact: true })
    const safe = sheet.getByRole("button", { name: "Safe", exact: true })
    await expect(safe).toHaveAttribute("aria-pressed", "true")
    await expect(all).toHaveAttribute("aria-pressed", "false")

    // The 18+ row is filtered at rest; All reveals it in this session.
    await expect(page.locator(".act-row", { hasText: "Adult Paper" })).toHaveCount(0)
    await all.tap()
    await expect(all).toHaveAttribute("aria-pressed", "true")
    await expect(page.locator(".act-row", { hasText: "Adult Paper" })).toHaveCount(1)

    // Ledger rows execute on release commit.
    await sheet.getByRole("button", { name: "Clear completed →" }).tap()
    await expect.poll(() => deletes).toContain("?stage=complete")
  })

  test("§4.3 correction table: 16 / 32 / 56×35 / 9px / 16 sheet margins", async ({ page }) => {
    await mockShellEndpoints(page, { mockTasks: false })
    const active = [
      mockTask({
        task_id: "dl-1",
        task_type: "download",
        title: "Neon Drive",
        stage: "downloading",
        preview_url: "https://example.com/p.jpg",
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
    ]
    await mockTaskQueues(page, { getActive: () => active, getHistory: () => history })

    await page.goto("/activity")

    // Header → content 16px (§6 D5).
    expect(await page.locator(".act-head").evaluate((el) => getComputedStyle(el).marginBottom)).toBe("16px")
    // Section gap 32px (§6 D5).
    expect(
      await page.locator(".act-sec-finished").evaluate((el) => getComputedStyle(el).marginTop)
    ).toBe("32px")
    // Thumb 56×35 = 16:10 (§6 D2).
    const thumb = (await activeSection(page).locator(".act-thumb").first().boundingBox())!
    expect(thumb.width).toBe(56)
    expect(thumb.height).toBe(35)
    // TYPE pill 9px (§6 D6 floor).
    expect(
      await activeSection(page).locator(".act-type").first().evaluate((el) => getComputedStyle(el).fontSize)
    ).toBe("9px")

    // Sheet body margins 16px.
    await page.getByRole("button", { name: "QUEUE…", exact: true }).tap()
    const body = page.locator(".mobile-sheet.open .mobile-sheet-body .actm-sheet-body")
    expect(await body.evaluate((el) => getComputedStyle(el).paddingLeft)).toBe("16px")
    expect(await body.evaluate((el) => getComputedStyle(el).paddingRight)).toBe("16px")
  })

  test("mobile reduced motion: settle skips the dwell, terminal rows drop straight to FINISHED", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" })
    await mockShellEndpoints(page, { mockTasks: false })
    let active: ActivityTask[] = [
      mockTask({ task_id: "dl-1", task_type: "download", title: "RM Paper", stage: "downloading" }),
    ]
    let history: ActivityTask[] = []
    await mockTaskQueues(page, { getActive: () => active, getHistory: () => history })

    await page.goto("/activity")
    await expect(activeSection(page).locator(".act-row", { hasText: "RM Paper" })).toHaveCount(1)

    active = []
    history = [
      mockTask({
        task_id: "dl-1",
        task_type: "download",
        title: "RM Paper",
        stage: "complete",
        finished_at: Date.now(),
        percent: 100,
      }),
    ]

    // §5.1 table: the TS layer skips the dwell entirely — the row lands in
    // FINISHED on the next refresh window and the settle class never mounts.
    const landed = finishedSection(page).locator(".act-row", { hasText: "RM Paper" })
    await expect(landed.locator(".act-stage")).toHaveText("COMPLETE", { timeout: 15000 })
    await expect(activeSection(page).locator(".act-row", { hasText: "RM Paper" })).toHaveCount(0)
    await expect(page.locator(".act-settle")).toHaveCount(0)
    await expect(page.locator(".act-count")).toHaveText("0 ACTIVE — 1 FINISHED — 0 FAILED")
  })
})
