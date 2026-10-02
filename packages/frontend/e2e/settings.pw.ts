import { expect, test } from "playwright/test"
import type { Page } from "playwright"
import { mockAuthDisabled, mockLibraryList, mockSummary } from "./helpers.js"
import { mockSystemSummary } from "./fixtures.js"

const GB = 2 ** 30

/** Mock route bodies are attacker-shaped JSON until proven otherwise; this is
 *  the one place a test reads a posted field, so it narrows before trusting. */
const postedField = (body: unknown, key: string): unknown => {
  if (body === null || typeof body !== "object" || !(key in body)) return undefined
  // The `in` check proves the key exists but not its type, and a request body
  // has no schema here; a record view is the honest shape for one field read.
  const record = body as Record<string, unknown>
  return record[key]
}

const baseSummary = () => {
  const summary = mockSystemSummary()
  summary.status.player.rotation_interval_sec = 300
  return summary
}

const mockStorageStatus = () => ({
  available: true,
  data_root: "/mock/data",
  default_root: "/mock/data",
  using_default: true,
  last_error: null,
  migration: null,
})

const mockBase = async (page: Page, summary = baseSummary()) => {
  await mockAuthDisabled(page)
  await mockSummary(page, summary)
  await mockLibraryList(page, [])
  await page.route("**/api/storage", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mockStorageStatus()),
    })
  )
}

test.describe("Settings page", () => {
  test("defaults to playback and navigates sections via ?sec= with back support", async ({
    page,
  }) => {
    await mockBase(page)
    await page.goto("/settings")

    await expect(page.locator(".set-title")).toHaveText(/Settings \/ Playback/)
    await expect(page.getByText("Duration per wallpaper")).toBeVisible()

    await page.locator(".set-rc-row", { hasText: "Storage" }).click()
    await expect(page).toHaveURL(/\/settings\?sec=storage/)
    await expect(page.locator(".set-title")).toHaveText(/Settings \/ Storage/)
    await expect(page.getByText("Media directory", { exact: true })).toBeVisible()

    await page.locator(".set-rc-row", { hasText: "Access & Security" }).click()
    await expect(page).toHaveURL(/\/settings\?sec=access/)
    await expect(page.locator(".set-title")).toHaveText(/Settings \/ Access/)

    await page.goBack()
    await expect(page).toHaveURL(/\/settings\?sec=storage/)
    await expect(page.locator(".set-title")).toHaveText(/Settings \/ Storage/)
    await page.goBack()
    await expect(page.locator(".set-title")).toHaveText(/Settings \/ Playback/)
  })

  test("direct ?sec= link lands on the section", async ({ page }) => {
    await mockBase(page)
    await page.goto("/settings?sec=system")
    await expect(page.locator(".set-title")).toHaveText(/Settings \/ System/)
  })

  test("duration segmented control commits immediately", async ({ page }) => {
    await mockBase(page)

    let postedSeconds: number | null = null
    await page.route("**/api/player/interval", (r) => {
      const seconds = postedField(r.request().postDataJSON(), "seconds")
      if (typeof seconds === "number") postedSeconds = seconds
      return r.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })

    await page.goto("/settings")
    const seg = page.getByRole("radiogroup", { name: "Duration per wallpaper" })
    await expect(seg.getByRole("radio", { name: "5M" })).toHaveAttribute("aria-checked", "true")

    await seg.getByRole("radio", { name: "10M" }).click()
    await expect.poll(() => postedSeconds).toBe(600)
    await expect(seg.getByRole("radio", { name: "10M" })).toHaveAttribute("aria-checked", "true")
  })

  test("failed commit reverts to the server value", async ({ page }) => {
    await mockBase(page)
    await page.route("**/api/player/interval", (r) =>
      r.fulfill({ status: 500, contentType: "application/json", body: '{"error":"mpv gone"}' })
    )

    await page.goto("/settings")
    const seg = page.getByRole("radiogroup", { name: "Duration per wallpaper" })
    await seg.getByRole("radio", { name: "10M" }).click()

    await expect(page.getByText(/COMMIT FAILED/)).toBeVisible()
    await expect(seg.getByRole("radio", { name: "10M" })).toHaveAttribute("aria-checked", "false")
    await expect(seg.getByRole("radio", { name: "5M" })).toHaveAttribute("aria-checked", "true")
  })

  test("play limit row commits immediately and shows the live auto-stop countdown", async ({
    page,
  }) => {
    const summary = baseSummary()
    // A limit is already set and a session is counting down: 90 minutes left.
    summary.status.play_limit = { minutes: 60, once: false, deadline: Date.now() + 90 * 60_000 }
    await mockBase(page, summary)

    let postedMinutes: number | null = null
    await page.route("**/api/player/play-limit", (r) => {
      const minutes = postedField(r.request().postDataJSON(), "minutes")
      if (typeof minutes === "number") postedMinutes = minutes
      return r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ minutes, once: false, deadline: null }),
      })
    })

    await page.goto("/settings")
    const seg = page.getByRole("radiogroup", { name: "Stop playback after" })
    await expect(seg.getByRole("radio", { name: "1H" })).toHaveAttribute("aria-checked", "true")

    // The armed session's remaining time is read from the summary deadline.
    await expect(page.getByText(/AUTO-STOP IN 1:2\d:\d\d/)).toBeVisible()

    await seg.getByRole("radio", { name: "2H" }).click()
    await expect.poll(() => postedMinutes).toBe(120)
    await expect(seg.getByRole("radio", { name: "2H" })).toHaveAttribute("aria-checked", "true")
  })

  test("play limit off reads as no limit and a failed commit reverts", async ({ page }) => {
    await mockBase(page)
    await page.route("**/api/player/play-limit", (r) =>
      r.fulfill({ status: 500, contentType: "application/json", body: '{"error":"db locked"}' })
    )

    await page.goto("/settings")
    const seg = page.getByRole("radiogroup", { name: "Stop playback after" })
    // Off is distinguished from "set but not yet armed".
    await expect(seg.getByRole("radio", { name: "OFF" })).toHaveAttribute("aria-checked", "true")
    await expect(page.getByText(/NO LIMIT — PLAYBACK RUNS UNTIL YOU STOP IT/)).toBeVisible()

    await seg.getByRole("radio", { name: "30M" }).click()
    await expect(page.getByText(/COMMIT FAILED/)).toBeVisible()
    await expect(seg.getByRole("radio", { name: "30M" })).toHaveAttribute("aria-checked", "false")
    await expect(seg.getByRole("radio", { name: "OFF" })).toHaveAttribute("aria-checked", "true")
  })

  test("interface sounds switch persists across reload", async ({ page }) => {
    await mockBase(page)
    await page.goto("/settings")

    const seg = page.getByRole("radiogroup", { name: "Interface sounds" })
    await expect(seg.getByRole("radio", { name: "OFF" })).toHaveAttribute("aria-checked", "true")

    await seg.getByRole("radio", { name: "ON" }).click()
    await expect(seg.getByRole("radio", { name: "ON" })).toHaveAttribute("aria-checked", "true")

    await page.reload()
    await expect(
      page.getByRole("radiogroup", { name: "Interface sounds" }).getByRole("radio", { name: "ON" })
    ).toHaveAttribute("aria-checked", "true")
  })

  test("storage: directory-change focused flow validates, confirms and locks", async ({
    page,
  }) => {
    await mockBase(page)

    await page.route("**/api/storage/locations", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { id: "default", label: "Default", path: "/mock/data", display_path: "/mock/data" },
          { id: "nas", label: "NAS", path: "/mnt/nas", display_path: "/mnt/nas" },
        ]),
      })
    )
    await page.route("**/api/storage/directories*", (r) => {
      const url = new URL(r.request().url())
      const path = url.searchParams.get("path") ?? "/mnt/nas"
      return r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ path, display_path: path, entries: [] }),
      })
    })
    await page.route("**/api/storage/validate-target", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          path: "/mnt/nas",
          display_path: "/mnt/nas",
          free_bytes: 84 * GB,
          total_bytes: 460 * GB,
          used_bytes: 376 * GB,
          is_empty: true,
          has_source: false,
          has_optimized: false,
          message: "ok",
        }),
      })
    )
    await page.route("**/api/storage/root", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...mockStorageStatus(),
          data_root: "/mock/data",
          migration: { state: "running", moved_bytes: 0, total_bytes: 1000, error: null },
        }),
      })
    )

    await page.goto("/settings?sec=storage")
    await expect(page.getByText("/mock/data")).toBeVisible()
    await expect(page.locator(".set-default")).toHaveText("DEFAULT")

    await page.getByRole("button", { name: /Change directory/ }).click()
    const dialog = page.getByRole("dialog", { name: "Change media directory" })
    await expect(dialog).toBeVisible()

    // Location list → drill into the NAS location.
    await dialog.getByRole("button", { name: /NAS/ }).click()
    await expect(dialog.getByText("NO SUBDIRECTORIES")).toBeVisible()
    await dialog.getByRole("button", { name: "USE THIS DIRECTORY" }).click()

    // Validation lines resolve ◌→✓ one by one, then the impact layer.
    await expect(dialog.locator(".set-check-ok")).toHaveCount(3)
    await expect(dialog.getByText("CONFIRM IMPACT")).toBeVisible()
    await expect(dialog.getByText(/SWITCH MEDIA DIRECTORY → \/mnt\/nas/)).toBeVisible()

    // After confirm the section locks to a summary; the next /api/storage
    // poll keeps reporting the running migration.
    await page.route("**/api/storage", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...mockStorageStatus(),
          migration: { state: "running", moved_bytes: 400, total_bytes: 1000, error: null },
        }),
      })
    )
    await dialog.getByRole("button", { name: "CONFIRM SWITCH" }).click()

    await expect(dialog).toBeHidden()
    await expect(page.getByText("MIGRATION — DIRECTORY LOCKED")).toBeVisible()
    await expect(page.getByRole("link", { name: /View in Activity/ })).toBeVisible()
    await expect(page.getByText("→ /mnt/nas")).toBeVisible()
  })

  test("access: passkey cap shows n/cap and removal is a two-step named chip", async ({
    page,
  }) => {
    await page.route("**/api/auth/setup-state", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ enabled: true, setup_complete: true, max_passkeys: 2 }),
      })
    )
    await page.route("**/api/auth/get-session", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: { id: "u1", email: "a@b.c", name: "Admin" },
          session: { id: "s1", token: "t", userId: "u1" },
        }),
      })
    )
    await page.route("**/api/auth/passkey/list-user-passkeys", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { id: "pk1", name: "MacBook Pro", createdAt: "2026-05-12T00:00:00.000Z" },
          { id: "pk2", name: "YubiKey 5C", createdAt: "2026-06-03T00:00:00.000Z" },
        ]),
      })
    )
    let deletedId: string | null = null
    await page.route("**/api/auth/passkey/delete-passkey", (r) => {
      deletedId = (r.request().postDataJSON() as { id: string }).id
      return r.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })
    await mockSummary(page, baseSummary())
    await mockLibraryList(page, [])
    await page.route("**/api/storage", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockStorageStatus()),
      })
    )

    await page.goto("/settings?sec=access")

    await expect(page.getByText("ENABLED — PASSKEY")).toBeVisible()
    await expect(page.getByText("PASSKEYS — 2/2")).toBeVisible()
    // At the cap the block-head command reads LIMIT REACHED and is disabled.
    await expect(page.getByRole("button", { name: "LIMIT REACHED" })).toBeDisabled()

    const row = page.locator(".set-row", { hasText: "MacBook Pro" })
    const chip = row.getByRole("button", { name: "REMOVE", exact: true })
    await chip.click()
    await expect(row.getByRole("button", { name: "REMOVE MACBOOK PRO?" })).toBeVisible()
    expect(deletedId).toBeNull()
    await row.getByRole("button", { name: "REMOVE MACBOOK PRO?" }).click()
    await expect.poll(() => deletedId).toBe("pk1")
  })

  test("access: the last passkey cannot be removed", async ({ page }) => {
    await page.route("**/api/auth/setup-state", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ enabled: true, setup_complete: true, max_passkeys: 8 }),
      })
    )
    await page.route("**/api/auth/get-session", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: { id: "u1", email: "a@b.c", name: "Admin" },
          session: { id: "s1", token: "t", userId: "u1" },
        }),
      })
    )
    await page.route("**/api/auth/passkey/list-user-passkeys", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { id: "pk1", name: "MacBook Pro", createdAt: "2026-05-12T00:00:00.000Z" },
        ]),
      })
    )
    await mockSummary(page, baseSummary())
    await mockLibraryList(page, [])
    await page.route("**/api/storage", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockStorageStatus()),
      })
    )

    await page.goto("/settings?sec=access")

    await expect(page.getByText("PASSKEYS — 1/8")).toBeVisible()
    await expect(page.getByText("LAST PASSKEY CANNOT BE REMOVED")).toBeVisible()
    await expect(
      page.locator(".set-row", { hasText: "MacBook Pro" }).getByRole("button", { name: "REMOVE" })
    ).toHaveCount(0)
  })

  test("system: warned health rows auto-expand with the amber reason first", async ({
    page,
  }) => {
    const summary = baseSummary()
    summary.status.display.configured = false
    await mockBase(page, summary)

    await page.goto("/settings?sec=system")

    // The display row warns and is auto-expanded: amber reason ahead of the
    // technical parameters.
    await expect(page.getByText(/ON\/OFF COMMANDS NOT CONFIGURED/)).toBeVisible()
    await expect(page.getByText(/SCREEN 1920×1080 · FILL/)).toBeVisible()
    const displayRow = page.locator(".set-row", { hasText: "Display control" })
    await expect(displayRow.locator(".set-row-val")).toHaveText("WARN")

    // The rail's secondary System entry carries the attention badge.
    await expect(page.locator(".set-rc-sys .set-rc-attn")).toHaveText("!")

    // Healthy rows stay collapsed until clicked.
    const steamRow = page.locator(".set-row", { hasText: "Steam connection" })
    await expect(steamRow.locator(".set-row-val")).toHaveText("OK")
    await expect(page.getByText("WEB API KEY abc***")).toBeHidden()
    await steamRow.click()
    await expect(page.getByText("WEB API KEY abc***")).toBeVisible()
  })
})

test.describe("Settings mobile (ticket 14)", () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test("play limit has touch-sized controls, commits, and reverts a failed change", async ({ page }) => {
    const summary = baseSummary()
    await mockBase(page, summary)
    let postedLimit: { minutes: unknown; once: unknown } | undefined
    let failCommit = false
    await page.route("**/api/player/play-limit", (route) => {
      const body: unknown = route.request().postDataJSON()
      const minutes = postedField(body, "minutes")
      const once = postedField(body, "once")
      postedLimit = { minutes, once }
      if (failCommit) {
        return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"db locked"}' })
      }
      if (typeof minutes === "number" && typeof once === "boolean") {
        summary.status.play_limit = { minutes, once, deadline: Date.now() + minutes * 60_000 }
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(summary.status.play_limit),
      })
    })

    await page.goto("/settings")
    await page.locator(".setm-row", { hasText: "Playback" }).click()
    const segment = page.getByRole("radiogroup", { name: "Stop playback after" })
    const modes = page.getByRole("radiogroup", { name: "Play limit repeat mode" })
    await expect(segment.getByRole("radio", { name: "OFF" })).toHaveAttribute("aria-checked", "true")
    await expect(modes.getByRole("radio", { name: "ALWAYS" })).toHaveAttribute("aria-checked", "true")
    for (const control of [segment, modes]) {
      for (const radio of await control.getByRole("radio").all()) {
        const box = await radio.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.height).toBeGreaterThanOrEqual(44)
        expect(box!.width).toBeGreaterThanOrEqual(44)
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(390)
      }
    }

    await segment.getByRole("radio", { name: "30M" }).click()
    await expect.poll(() => postedLimit).toEqual({ minutes: 30, once: false })
    await expect(segment.getByRole("radio", { name: "30M" })).toHaveAttribute("aria-checked", "true")
    await expect(page.getByText(/AUTO-STOP IN/)).toBeVisible()
    await modes.getByRole("radio", { name: "ONCE" }).click()
    await expect.poll(() => postedLimit).toEqual({ minutes: 30, once: true })
    await expect(modes.getByRole("radio", { name: "ONCE" })).toHaveAttribute("aria-checked", "true")
    failCommit = true
    await modes.getByRole("radio", { name: "ALWAYS" }).click()
    await expect.poll(() => postedLimit).toEqual({ minutes: 30, once: false })
    await expect(page.getByText(/COMMIT FAILED/)).toBeVisible()
    await expect(modes.getByRole("radio", { name: "ONCE" })).toHaveAttribute("aria-checked", "true")
    await expect(modes.getByRole("radio", { name: "ALWAYS" })).toHaveAttribute("aria-checked", "false")
    await segment.getByRole("radio", { name: "1H" }).click()
    await expect.poll(() => postedLimit).toEqual({ minutes: 60, once: true })
    await expect(page.getByText(/COMMIT FAILED/)).toBeVisible()
    await expect(segment.getByRole("radio", { name: "30M" })).toHaveAttribute("aria-checked", "true")
    await expect(segment.getByRole("radio", { name: "1H" })).toHaveAttribute("aria-checked", "false")
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  })

  test("degrades to a section list → detail two-layer flow", async ({ page }) => {
    await mockBase(page)
    await page.goto("/settings")

    // Layer one: the section list with mono live readings; the desktop rail
    // navigation and page title are absent.
    await expect(page.locator(".set-rc")).toHaveCount(0)
    await expect(page.locator(".setm-title")).toHaveText("Settings")
    const rows = page.locator(".setm-row")
    await expect(rows).toHaveCount(4)
    await expect(rows.nth(0)).toContainText("Playback")
    await expect(rows.nth(0)).toContainText("MODE — SINGLE")
    await expect(rows.nth(1)).toContainText("Storage")
    await expect(rows.nth(1)).toContainText("954 MB FREE")
    // Every list row is a ≥44px touch target.
    for (const row of await rows.all()) {
      expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    }

    // Layer two: a row opens its section, URL-addressable for back support.
    await rows.nth(0).click()
    await expect(page).toHaveURL(/\/settings\?sec=playback/)
    await expect(page.locator(".setm-back")).toBeVisible()
    await expect(page.getByText("Duration per wallpaper")).toBeVisible()
    await expect(page.locator(".setm-list")).toHaveCount(0)

    await page.goBack()
    await expect(page).toHaveURL(/\/settings$/)
    await expect(page.locator(".setm-list")).toBeVisible()

    // The same shared section bodies render in the detail layer.
    await page.locator(".setm-row", { hasText: "System" }).click()
    await expect(page.getByText("Steam connection")).toBeVisible()
  })

  test("detail layer keeps the glass directory-change focused flow", async ({ page }) => {
    await mockBase(page)
    await page.route("**/api/storage/locations", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { id: "default", label: "Default", path: "/mock/data", display_path: "/mock/data" },
        ]),
      })
    )

    await page.goto("/settings?sec=storage")
    await page.getByRole("button", { name: /Change directory/ }).click()

    const dialog = page.getByRole("dialog", { name: "Change media directory" })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole("button", { name: /Default/ })).toBeVisible()
    // Glass on mobile too: the focused overlay keeps the §2.4 recipe.
    const backdrop = await dialog.evaluate((el) => getComputedStyle(el).backdropFilter)
    expect(backdrop).toContain("blur(28px)")
    // The sheet close is a ≥44px touch target on mobile.
    const close = await dialog.page().locator(".set-sheet-close").boundingBox()
    expect(close!.width).toBeGreaterThanOrEqual(44)
  })
})
