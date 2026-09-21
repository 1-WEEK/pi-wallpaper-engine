import { expect, test } from "playwright/test"
import type { Page } from "playwright"
import { mockAuthDisabled, mockLibraryList, mockSummary } from "./helpers.js"
import { mockSystemSummary } from "./fixtures.js"

const GB = 2 ** 30

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
      postedSeconds = (r.request().postDataJSON() as { seconds: number }).seconds
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
