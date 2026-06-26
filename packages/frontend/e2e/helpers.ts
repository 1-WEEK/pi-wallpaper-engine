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

/** Quick helper to mock the system summary endpoint. */
export const mockSummary = (
  page: Page,
  summary?: SystemSummary
) => {
  const body = summary ?? mockSystemSummary()
  void page.route("**/api/system/summary", (r) => {
    void r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    })
  })
}

/** Quick helper to mock the library list endpoint. */
export const mockLibraryList = (page: Page, items: unknown[]) => {
  void page.route("**/api/library", (r) => {
    void r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(items),
    })
  })
}

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

/** Compute how many grid columns fit at the current viewport width.
 *  Mirrors computeFitColumns from useColumnsPerRow.ts. */
export const computeColumns = (viewportWidth: number): number => {
  // .app grid: 228px sidebar + 1fr content
  // .main padding: 18px 20px, so 20px left + 20px right
  const contentWidth = viewportWidth - 228 - 40
  return Math.max(1, Math.floor((contentWidth + 14) / (248 + 14)))
}
