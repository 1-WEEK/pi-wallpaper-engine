import { expect, test } from "playwright/test"
import type { Page } from "playwright"
import type { LibraryItem } from "@pwe/shared"
import { mockLibraryItem, mockSystemSummary } from "./fixtures.js"
import { mockAuthDisabled, mockLibraryList, mockSummary } from "./helpers.js"

const mockAllEndpoints = (page: Page, items: LibraryItem[], nowPlayingId?: string) => {
  const summary = mockSystemSummary()
  if (nowPlayingId) summary.status.player.current_workshop_id = nowPlayingId
  return Promise.all([
    mockAuthDisabled(page),
    mockSummary(page, summary),
    mockLibraryList(page, items),
  ])
}

const completed = mockLibraryItem() // Neon City, 500MB → 100MB optimized (↓80%)
const failed = mockLibraryItem({
  workshop_id: "222",
  title: "Rainy Window",
  transcode_status: "failed",
  transcode_progress: 0,
  transcoded_path: null,
  transcoded_resolution: null,
  transcoded_codec: null,
  transcoded_size: null,
  transcode_error: "ffmpeg exited 1",
})
const running = mockLibraryItem({
  workshop_id: "333",
  title: "Morning Fog",
  transcode_status: "running",
  transcode_progress: 40,
  transcoded_path: null,
  transcoded_resolution: null,
  transcoded_codec: null,
  transcoded_size: null,
})
const pending = mockLibraryItem({
  workshop_id: "444",
  title: "Neon Rain",
  transcode_status: "pending",
  transcode_progress: 0,
  transcoded_path: null,
  transcoded_resolution: null,
  transcoded_codec: null,
  transcoded_size: null,
})

/** Hover-action locator for one card. */
const cardActions = (page: Page, title: string) =>
  page.locator(".lib-card", { hasText: title }).locator(".lib-actions")

test.describe("Library contact sheet: grid + occupancy (ticket 08)", () => {
  test("cards carry N° index, transcoded-first meta and non-default state markers", async ({
    page,
  }) => {
    await mockAllEndpoints(page, [completed, failed, running, pending], completed.workshop_id)
    await page.goto("/library")
    const cards = page.locator(".lib-card")
    await expect(cards).toHaveCount(4)

    // Occupancy: NOW PLAYING inverse chip only on the active item. The chip
    // consumes --pt-inv-bg, which flips with the theme (dark by default), so
    // compare against the token's computed value rather than a raw color.
    const playingCard = page.locator(".lib-card", { hasText: "Neon City" })
    await expect(playingCard.locator(".lib-now")).toHaveText("NOW PLAYING")
    const invBg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--pt-inv-bg").trim()
    )
    expect(invBg).not.toBe("")
    await expect(playingCard.locator(".lib-now")).toHaveCSS("background-color", invBg)
    await expect(page.locator(".lib-now")).toHaveCount(1)

    // Caption meta prefers the transcoded readout + the ↓n% savings.
    await expect(playingCard.locator(".lib-caption-meta")).toHaveText(
      "1920x1080 · HEVC · 95.4 MB ↓80%"
    )

    // TX pills mark only non-default transcode states, on a fixed dark scrim.
    await expect(page.locator(".lib-card", { hasText: "Rainy Window" }).locator(".lib-tx"))
      .toHaveText("TX FAILED")
    await expect(page.locator(".lib-card", { hasText: "Morning Fog" }).locator(".lib-tx"))
      .toHaveText("TX 40%")
    await expect(page.locator(".lib-card", { hasText: "Neon Rain" }).locator(".lib-tx"))
      .toHaveText("TX QUEUED")
    await expect(playingCard.locator(".lib-tx")).toHaveCount(0)
    const txBg = await page
      .locator(".lib-card", { hasText: "Rainy Window" })
      .locator(".lib-tx")
      .evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(txBg).toBe("rgba(0, 0, 0, 0.58)")

    // The measured coordinate grid is drawn for the sheet.
    await expect(page.locator(".bws-gl-v")).toHaveCount(2) // 3 columns @1280px
  })

  test("QUERY filters in place; rail SORT/VIEW/STATE rows work", async ({ page }) => {
    await mockAllEndpoints(page, [completed, failed, running])
    await page.goto("/library")
    await expect(page.locator(".lib-card")).toHaveCount(3)

    await page.locator("#lib-q").fill("rainy")
    await expect(page.locator(".lib-card")).toHaveCount(1)
    await expect(page.locator(".lib-card").first()).toContainText("Rainy Window")
    await page.locator("#lib-q").fill("")

    // SORT: Title orders alphabetically.
    await page.locator(".rail-controls").getByRole("button", { name: /Title/ }).click()
    await expect(page.locator(".lib-card").nth(0)).toContainText("Morning Fog")
    await expect(page.locator(".lib-card").nth(2)).toContainText("Rainy Window")

    // STATE filter: Needs attention leaves only the failed item.
    await page
      .locator(".rail-controls")
      .getByRole("button", { name: /Needs attention/ })
      .click()
    await expect(page.locator(".lib-card")).toHaveCount(1)
    await expect(page.locator(".lib-card").first()).toContainText("Rainy Window")
    await expect(
      page.locator(".rail-controls").getByRole("button", { name: /1 ACTIVE — CLEAR/ })
    ).toBeVisible()
    await page.locator(".rail-controls").getByRole("button", { name: /CLEAR/ }).click()
    await expect(page.locator(".lib-card")).toHaveCount(3)
  })
})

test.describe("Library views: ledger list (ticket 08)", () => {
  test("VIEW List switches to ledger rows with TX pill and hover actions", async ({ page }) => {
    await mockAllEndpoints(page, [completed, failed], completed.workshop_id)
    await page.goto("/library")
    await expect(page.locator(".lib-card")).toHaveCount(2)

    await page.locator(".rail-controls").getByRole("button", { name: /List/ }).click()
    await expect(page.locator(".lib-grid")).toHaveCount(0)
    const rows = page.locator(".ledger-row")
    await expect(rows).toHaveCount(2)

    const first = rows.first()
    await expect(first.locator(".ledger-no")).toHaveText("N°001")
    await expect(first.locator(".ledger-title")).toContainText("Neon City")
    await expect(first.locator(".lib-now")).toHaveText("NOW PLAYING")
    await expect(first.locator(".ledger-meta")).toContainText("↓80%")
    await expect(first.locator(".lib-tx-inline")).toHaveCount(0)
    await expect(first.locator(".lib-actions .lib-act-primary")).toHaveText("PLAY")
    // Hairline separators between rows.
    await expect(first).toHaveCSS("border-bottom-width", "1px")

    await expect(rows.nth(1).locator(".lib-tx-inline")).toHaveText("TX FAILED")

    // V key toggles back to the grid.
    await page.keyboard.press("v")
    await expect(page.locator(".lib-card")).toHaveCount(2)
  })
})

test.describe("Library actions: PLAY / PREVIEW / DELETE (ticket 08)", () => {
  test("hover PLAY posts to the player endpoint", async ({ page }) => {
    let played: string | null = null
    await mockAllEndpoints(page, [completed, failed])
    await page.route("**/api/player/play/*", (r) => {
      played = r.request().url()
      void r.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })
    await page.goto("/library")
    const card = page.locator(".lib-card", { hasText: "Rainy Window" })
    await card.hover()
    await card.locator(".lib-act-primary", { hasText: "PLAY" }).click()
    await expect.poll(() => played).toContain("/api/player/play/222")
  })

  test("PREVIEW is offered only for transcoded items and opens the stream player", async ({
    page,
  }) => {
    await mockAllEndpoints(page, [completed, failed])
    await page.route("**/api/library/1693728660/stream", (r) =>
      r.fulfill({ status: 200, contentType: "video/mp4", body: "x" })
    )
    await page.goto("/library")

    await expect(cardActions(page, "Neon City").getByRole("button", { name: "PREVIEW" }))
      .toHaveCount(1)
    await expect(cardActions(page, "Rainy Window").getByRole("button", { name: "PREVIEW" }))
      .toHaveCount(0)

    await cardActions(page, "Neon City").getByRole("button", { name: "PREVIEW" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText("Neon City")).toBeVisible()

    // The player must point at the streaming endpoint. (The Range/206/auth
    // contract of that endpoint is covered by backend route tests; this
    // headless build has no media stack, so it never actually fetches.)
    const video = dialog.locator("video.video-preview-player")
    await expect(video).toHaveAttribute("src", "/api/library/1693728660/stream")

    // Simulate the media error a real browser fires when it can't decode
    // HEVC — the overlay must swap to the polite notice, not crash.
    await video.evaluate((el) => el.dispatchEvent(new Event("error")))
    await expect(dialog.locator(".video-preview-error")).toBeVisible()
    await expect(dialog.locator(".video-preview-error")).toContainText("HEVC")

    await page.getByRole("button", { name: "Close preview" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
  })

  test("DELETE is a two-step SURE? and only the second click deletes", async ({ page }) => {
    const items = [completed, failed]
    let deleted: string | null = null
    await mockAuthDisabled(page)
    await mockSummary(page)
    await page.route("**/api/library", (r) => {
      void r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(items.filter((i) => i.workshop_id !== deleted)),
      })
    })
    await page.route("**/api/library/222", (r) => {
      if (r.request().method() !== "DELETE") {
        void r.fallback()
        return
      }
      deleted = "222"
      void r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
    })
    await page.goto("/library")
    const card = page.locator(".lib-card", { hasText: "Rainy Window" })
    await card.hover()

    const del = card.locator(".lib-act-danger")
    await expect(del).toHaveText("DELETE")
    await del.click()
    await expect(del).toHaveText("SURE?")
    expect(deleted).toBeNull() // first click only arms

    await del.click()
    await expect.poll(() => deleted).toBe("222")
    // The list refetch drops the card.
    await expect(page.locator(".lib-card")).toHaveCount(1)
    await expect(page.locator(".lib-card").first()).toContainText("Neon City")
  })
})

test.describe("Library glass detail popover (ticket 08)", () => {
  test("Enter opens the glass detail with SOURCE/OPTIMIZED specs and five actions", async ({
    page,
  }) => {
    await mockAllEndpoints(page, [completed, failed], completed.workshop_id)
    await page.goto("/library")
    await expect(page.locator(".lib-card")).toHaveCount(2)

    await page.keyboard.press("Enter")
    const detail = page.locator(".ldet-panel")
    await expect(detail).toBeVisible()
    await expect(detail).toHaveAttribute("role", "dialog")

    // The §2.4 glass recipe on the shell.
    const backdrop = await detail.evaluate(
      (el) => getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter
    )
    expect(backdrop).toContain("blur(28px)")

    await expect(detail.locator(".ldet-title")).toHaveText("Neon City")
    await expect(detail.locator(".ldet-now")).toHaveText("NOW PLAYING")
    await expect(detail.locator(".ldet-meta")).toContainText("ID 1693728660")
    await expect(detail.locator(".ldet-specs")).toContainText(
      "SOURCE — 3840x2160 · H264 · 476.8 MB"
    )
    await expect(detail.locator(".ldet-specs")).toContainText(
      "OPTIMIZED — 1920x1080 · HEVC · 95.4 MB · ↓80%"
    )

    // Playback semantics: PLAY primary + PREVIEW/DELETE/STEAM; TRANSCODE is
    // hidden on a completed item.
    await expect(detail.locator(".ldet-play")).toHaveText("PLAY")
    await expect(detail.getByRole("button", { name: "PREVIEW" })).toBeVisible()
    await expect(detail.getByRole("button", { name: "DELETE" })).toBeVisible()
    await expect(detail.locator(".ldet-steam")).toHaveAttribute(
      "href",
      `https://steamcommunity.com/sharedfiles/filedetails/?id=${completed.workshop_id}`
    )
    await expect(detail.getByRole("button", { name: "TRANSCODE" })).toHaveCount(0)

    // ←/→ steps to the failed item, which offers TRANSCODE + FAILED spec.
    await page.keyboard.press("ArrowRight")
    await expect(detail.locator(".ldet-title")).toHaveText("Rainy Window")
    await expect(detail.locator(".ldet-specs")).toContainText("OPTIMIZED — FAILED")
    await expect(detail.getByRole("button", { name: "TRANSCODE" })).toBeVisible()
    await expect(detail.getByRole("button", { name: "PREVIEW" })).toHaveCount(0)

    // Wrap-around back to the first item, then Esc closes.
    await page.keyboard.press("ArrowRight")
    await expect(detail.locator(".ldet-title")).toHaveText("Neon City")
    await page.keyboard.press("Escape")
    await expect(page.locator(".ldet")).toHaveCount(0)
  })

  test("detail DELETE is two-step and closes the popover", async ({ page }) => {
    const items = [completed, failed]
    let deleted: string | null = null
    await mockAuthDisabled(page)
    await mockSummary(page)
    await page.route("**/api/library", (r) => {
      void r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(items.filter((i) => i.workshop_id !== deleted)),
      })
    })
    await page.route("**/api/library/222", (r) => {
      if (r.request().method() !== "DELETE") {
        void r.fallback()
        return
      }
      deleted = "222"
      void r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
    })
    await page.goto("/library")
    await expect(page.locator(".lib-card")).toHaveCount(2)

    // Open the failed item's detail (second card).
    await page.keyboard.press("ArrowRight")
    await page.keyboard.press("Enter")
    const detail = page.locator(".ldet-panel")
    await expect(detail.locator(".ldet-title")).toHaveText("Rainy Window")

    const del = detail.getByRole("button", { name: "DELETE" })
    await del.click()
    await expect(detail.getByRole("button", { name: "SURE?" })).toBeVisible()
    expect(deleted).toBeNull()

    await detail.getByRole("button", { name: "SURE?" }).click()
    await expect.poll(() => deleted).toBe("222")
    await expect(page.locator(".ldet")).toHaveCount(0)
    await expect(page.locator(".lib-card")).toHaveCount(1)
  })
})

test.describe("Library rail QUEUE commands (ticket 08)", () => {
  test("Play all / Shuffle set the rotation mode and play an anchor; Transcode all sweeps", async ({
    page,
  }) => {
    const calls: string[] = []
    await mockAllEndpoints(page, [completed, failed])
    await page.route("**/api/player/mode", (r) => {
      calls.push(`mode:${r.request().postDataJSON()?.mode}`)
      void r.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })
    await page.route("**/api/player/play/*", (r) => {
      calls.push(`play:${r.request().url().split("/").pop()}`)
      void r.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })
    await page.route("**/api/library/transcode/retry-all", (r) => {
      calls.push("retry-all")
      void r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, queued: 1, skipped: 1, invalid: 0 }),
      })
    })
    await page.goto("/library")
    await expect(page.locator(".lib-card")).toHaveCount(2)

    const rail = page.locator(".rail-controls")
    await rail.getByRole("button", { name: /Play all/ }).click()
    await expect
      .poll(() => calls.slice(0, 2))
      .toEqual([`mode:sequential`, `play:${completed.workshop_id}`])

    await rail.getByRole("button", { name: /Shuffle/ }).click()
    await expect.poll(() => calls.includes("mode:shuffle")).toBe(true)

    await rail.getByRole("button", { name: /Transcode all/ }).click()
    await expect.poll(() => calls.includes("retry-all")).toBe(true)
    await expect(page.locator(".info-banner")).toContainText("1 queued, 1 skipped")
  })
})

test.describe("Library focus band: keyboard roaming (ticket 06, same language)", () => {
  test("arrows roam the grid; the 1-bit band hugs the cursor card", async ({ page }) => {
    const items = [completed, failed, running, pending].map((it, i) => ({
      ...it,
      workshop_id: String(1000 + i),
      title: `Wallpaper ${i + 1}`,
    }))
    await mockAllEndpoints(page, items)
    await page.goto("/library")
    const cards = page.locator(".lib-card")
    await expect(cards).toHaveCount(4)

    const ring = page.locator(".focus-ring")
    await expect(ring).toBeVisible()
    await expect(ring.locator(".focus-ring-dither")).toHaveCSS(
      "background-image",
      /data:image\/svg\+xml/
    )
    await expect(ring.locator(".focus-ring-coord")).toHaveText("C1·R1")
    await expect(cards.nth(0)).toHaveClass(/lib-cursor/)

    // The band hugs the cursor card exactly.
    const hug = async (i: number) => {
      const m = await page.evaluate((idx) => {
        const ring = document.querySelector(".focus-ring")
        const card = document.querySelectorAll(".lib-card")[idx]
        if (!ring || !card) return null
        const r = ring.getBoundingClientRect()
        const c = card.getBoundingClientRect()
        return Math.max(
          Math.abs(r.x - c.x),
          Math.abs(r.y - c.y),
          Math.abs(r.width - c.width),
          Math.abs(r.height - c.height)
        )
      }, i)
      expect(m).not.toBeNull()
      expect(m!).toBeLessThanOrEqual(1.5)
    }
    await hug(0)

    // 3 columns @1280px: right steps within the row, down jumps a row.
    await page.keyboard.press("ArrowRight")
    await expect(cards.nth(1)).toHaveClass(/lib-cursor/)
    await expect(ring.locator(".focus-ring-coord")).toHaveText("C2·R1")
    await page.keyboard.press("ArrowDown")
    await expect(cards.nth(3)).toHaveClass(/lib-cursor/) // clamped to last item
    await expect(ring.locator(".focus-ring-coord")).toHaveText("C1·R2")
    // Wait out the 250ms slide, then verify the hug on the new card.
    await page.waitForTimeout(300)
    await hug(3)

    // The band follows into the list view, row by row.
    await page.keyboard.press("v")
    await expect(page.locator(".ledger-row")).toHaveCount(4)
    await page.keyboard.press("ArrowUp")
    await expect(page.locator(".ledger-row").nth(2)).toHaveClass(/is-cursor/)
    await expect(ring.locator(".focus-ring-coord")).toHaveText("C1·R3")
  })
})
