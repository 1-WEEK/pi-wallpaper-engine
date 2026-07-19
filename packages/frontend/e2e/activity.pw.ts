import { expect, test } from "playwright/test"
import type { ActivityTask } from "@pwe/shared"
import { mockSystemSummary } from "./fixtures.js"

const summary = mockSystemSummary()

/** Boot the minimal mocks needed to render the app shell on the Activity page. */
const mockShellEndpoints = async (
  page: import("playwright").Page,
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
    await expect(page.locator("h1.page-title")).toHaveText("Activity")
    await expect(page.locator(".sidebar-link", { hasText: "Activity" })).toHaveClass(/active/)
  })

  test("legacy /downloads redirects to /activity", async ({ page }) => {
    await mockShellEndpoints(page)
    await page.goto("/downloads", { waitUntil: "networkidle" })
    await expect(page).toHaveURL(/\/activity$/)
    await expect(page.locator("h1.page-title")).toHaveText("Activity")
  })

  test("legacy /transcode redirects to /activity", async ({ page }) => {
    await mockShellEndpoints(page)
    await page.goto("/transcode", { waitUntil: "networkidle" })
    await expect(page).toHaveURL(/\/activity$/)
    await expect(page.locator("h1.page-title")).toHaveText("Activity")
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

  const activeSummary = page.locator(".summary-stat.compact", { hasText: "active" })
  await expect(activeSummary.locator("strong")).toHaveText("65")
  await expect(page.locator(".task-list > li")).toHaveCount(42)
})

test.describe("Activity resilience to aborted fetches", () => {
  // iOS Safari aborts in-flight fetches when the page is backgrounded. When
  // the user returns, that rejection lands in SWR as an error — the page must
  // keep rendering the cached task list, not replace it with "Fetch is aborted".
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
      const items = [mockTask({ stage: activeItems.length ? "running" : "complete" })]
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
    await expect(page.locator("div.error")).toHaveCount(0)
  })
})
