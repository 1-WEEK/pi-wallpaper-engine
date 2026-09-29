import type { Page } from "playwright"
import type { WorkshopItem, WorkshopSearchResult, SystemSummary } from "@pwe/shared"
import { mockSearchResult, mockSystemSummary } from "./fixtures.js"

/**
 * Register mock route handlers for a page. Each route specifies a method,
 * path pattern (URL fragment), and a handler that returns a mock body.
 */
export const setupApiRoutes = (
  page: Page,
  routes: Array<{
    method: string
    path: string
    handler: () => unknown
  }>
) => {
  for (const route of routes) {
    void page.route(`**${route.path}`, (r) => {
      if (r.request().method() !== route.method) {
        void r.fallback()
        return
      }
      void r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(route.handler()),
      })
    })
  }
}

/** Quick helper to mock the workshop search endpoint. */
export const mockWorkshopSearch = (
  page: Page,
  items: WorkshopItem[],
  total: number,
  nextCursor?: string
) => {
  const result = mockSearchResult(items, total, nextCursor)
  void page.route("**/api/workshop/search*", (r) => {
    void r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(result),
    })
  })
}

/** Auth disabled: the AuthGate resolves straight to the app shell.
 *  Await this (and the mocks below) before page.goto — an unregistered route
 *  lets the request through to the dev proxy, which hangs without a backend. */
export const mockAuthDisabled = (page: Page): Promise<void> =>
  page.route("**/api/auth/setup-state", (r) => {
    void r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ enabled: false, setup_complete: true }),
    })
  })

/** Quick helper to mock the system summary endpoint. */
export const mockSummary = (
  page: Page,
  summary?: SystemSummary
): Promise<void> => {
  const body = summary ?? mockSystemSummary()
  return page.route("**/api/system/summary", (r) => {
    void r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    })
  })
}

/** Quick helper to mock the library list endpoint. */
export const mockLibraryList = (page: Page, items: unknown[]): Promise<void> =>
  page.route("**/api/library", (r) => {
    void r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(items),
    })
  })

/** Quick helper to mock the download tasks endpoint. */
export const mockDownloadTasks = (page: Page, tasks: unknown[]) => {
  void page.route("**/api/download/tasks", (r) => {
    void r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(tasks),
    })
  })
}

/** Freeze the page's timers so a popover's 150ms exit-beat unmount timer
 *  cannot fire mid-probe (the close handler unmounts on a real setTimeout,
 *  which races any sampling of the exit animation). Install once, then pause
 *  at the page's CURRENT fake time +500ms — pausing at node's Date.now() can
 *  land in the fake clock's past. Call right before triggering the close,
 *  then `page.clock.runFor(...)` to step through the exit. */
export const freezePageClock = async (page: Page): Promise<void> => {
  await page.clock.install()
  const now = await page.evaluate(() => Date.now())
  await page.clock.pauseAt(now + 500)
}

/** Compute how many grid columns fit at the current viewport width.
 *  Mirrors computeFitColumns from useColumnsPerRow.ts. */
export const computeColumns = (viewportWidth: number): number => {
  // .app grid: 300px rail + 1fr content
  // .main padding: 20px per side; .bws contact-sheet padding: 32px per side
  const contentWidth = viewportWidth - 300 - 40 - 64
  return Math.max(1, Math.floor((contentWidth + 16) / (248 + 16)))
}
