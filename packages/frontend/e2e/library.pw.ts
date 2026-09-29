import { expect, test } from "playwright/test"
import type { Page } from "playwright"
import type { LibraryItem } from "@pwe/shared"
import { mockLibraryItem, mockSystemSummary } from "./fixtures.js"
import { mockAuthDisabled, mockLibraryList, mockSummary, freezePageClock } from "./helpers.js"

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
  test("hover PLAY on the FIRST card (wide transcoded meta) posts to the player endpoint", async ({
    page,
  }) => {
    // Regression (ticket 15): the first card carries the widest caption meta
    // ("1920x1080 · HEVC · 95.4 MB ↓80%"), which used to push the hover
    // action cluster past the card's right edge — the button's center
    // hit-tested on .lib-grid and the click never landed. The cluster now
    // overlays the caption's right end (out of flow), so it can never leave
    // the card and never squeezes the caption at rest.
    let played: string | null = null
    await mockAllEndpoints(page, [completed, failed])
    await page.route("**/api/player/play/*", (r) => {
      played = r.request().url()
      void r.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })
    await page.goto("/library")
    await expect(page.locator(".lib-card")).toHaveCount(2, { timeout: 15000 })
    const card = page.locator(".lib-card", { hasText: "Neon City" })
    await card.hover()
    const play = card.locator(".lib-act-primary", { hasText: "PLAY" })
    await play.click() // Playwright hit-tests the button center
    await expect.poll(() => played).toContain("/api/player/play/1693728660")

    // …and the cluster is geometrically inside the card, not just clickable.
    const inside = await card.evaluate((el) => {
      const actions = el.querySelector(".lib-actions")!
      const c = el.getBoundingClientRect()
      const a = actions.getBoundingClientRect()
      return a.right <= c.right + 0.5
    })
    expect(inside).toBe(true)
  })

  test("hover PLAY posts to the player endpoint", async ({ page }) => {
    test.setTimeout(60_000) // cold vite transform under parallel-suite load
    let played: string | null = null
    await mockAllEndpoints(page, [completed, failed])
    await page.route("**/api/player/play/*", (r) => {
      played = r.request().url()
      void r.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })
    await page.goto("/library")
    // First paint after a cold vite transform can outlast the default expect
    // timeout under parallel-suite load.
    await expect(page.locator(".lib-card")).toHaveCount(2, { timeout: 15000 })
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

  test("exit beat: scrim and panel fade out in lockstep — 150ms, no snap-off", async ({
    page,
  }) => {
    await mockAllEndpoints(page, [completed], completed.workshop_id)
    await page.goto("/library")
    await expect(page.locator(".lib-card")).toHaveCount(1)
    await page.keyboard.press("Enter")
    await expect(page.locator(".ldet-panel")).toBeVisible()

    /* Freeze the unmount timer: the close handler removes the popover on a
     * real 150ms setTimeout, which races the probes below. */
    await freezePageClock(page)
    await page.keyboard.press("Escape")
    await page.clock.runFor(50) // close class applies; exit animations created
    await expect(page.locator(".ldet-scrim-out")).toBeAttached()

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
        scrim: read(".ldet-scrim", "ldet-scrim-out"),
        panel: read(".ldet-panel", "ldet-out"),
      }
    })
    expect(mid.scrim).not.toBeNull()
    expect(mid.panel).not.toBeNull()
    expect(mid.scrim!).toBeGreaterThan(0.5)
    expect(mid.panel!).toBeGreaterThan(0.5)

    /* F1: same duration on both layers. */
    const durs = await page.evaluate(() =>
      [".ldet-scrim", ".ldet-panel"].map(
        (sel) => getComputedStyle(document.querySelector(sel)!).animationDuration
      )
    )
    expect(durs[0]).toBe(durs[1])

    await page.clock.runFor(300) // let the frozen unmount timer fire
    await expect(page.locator(".ldet")).toHaveCount(0)
  })

  test.describe("reduced motion", () => {
    test.use({ reducedMotion: "reduce" })

    test("the exit beat degrades to an instant cut: opacity 0 with no animation", async ({
      page,
    }) => {
      await mockAllEndpoints(page, [completed], completed.workshop_id)
      await page.goto("/library")
      await expect(page.locator(".lib-card")).toHaveCount(1)
      await page.keyboard.press("Enter")
      await expect(page.locator(".ldet-panel")).toBeVisible()

      // Same frozen-clock seam as the exit-beat test above: under reduced
      // motion there is no exit animation, but the 150ms unmount timer still
      // races the probe.
      await freezePageClock(page)
      await page.keyboard.press("Escape")
      await page.clock.runFor(50)
      await expect(page.locator(".ldet-scrim-out")).toBeAttached()
      const exit = await page.evaluate(() => {
        const el = document.querySelector(".ldet-scrim")
        return el
          ? { anims: el.getAnimations().length, opacity: getComputedStyle(el).opacity }
          : null
      })
      expect(exit).toEqual({ anims: 0, opacity: "0" })
      await page.clock.runFor(300)
      await expect(page.locator(".ldet")).toHaveCount(0)
    })
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

test.describe("Library → PlayerBar play ghost (ticket 12)", () => {
  const previewA = "https://example.com/preview/neon.jpg"
  const previewB = "https://example.com/preview/rainy.jpg"
  const itemA = mockLibraryItem({ preview_url: previewA })
  const itemB = mockLibraryItem({ workshop_id: "222", title: "Rainy Window", preview_url: previewB })

  /** Boot Library with a summary that flips to now-playing once PLAY posts. */
  const bootWithPlayback = async (page: Page) => {
    let played: string | null = null
    await mockAuthDisabled(page)
    await page.route("**/api/system/summary", (r) => {
      const s = mockSystemSummary()
      if (played) {
        s.status.player.current_workshop_id = itemA.workshop_id
        s.status.player.playing = true
        s.status.player.current_title = itemA.title
        s.status.player.current_preview_url = previewA
      }
      void r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(s) })
    })
    await mockLibraryList(page, [itemA, itemB])
    await page.route("**/api/player/play/*", (r) => {
      played = r.request().url()
      void r.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })
    await page.goto("/library")
    await expect(page.locator(".lib-card")).toHaveCount(2)
    return { played: () => played }
  }

  const playCard = async (page: Page, title: string) => {
    const card = page.locator(".lib-card", { hasText: title })
    await card.hover()
    await card.locator(".lib-act-primary", { hasText: "PLAY" }).click()
  }

  /** Install BEFORE clicking PLAY: a MutationObserver records each ghost's
   *  spawn snapshot (start pose + final keyframe + duration) at insertion
   *  time, so the assertions read a recording instead of racing the 380ms
   *  flight — a post-hoc probe can land after the animation's effect is
   *  already gone (snapshot read NaN). The elements tagged with
   *  data-ghost-from / data-ghost-to are measured in the SAME frame as the
   *  spawn, so the assertions never compare against a stale boundingBox()
   *  from before the click (async font metrics can shift the grid ~1px). */
  const installGhostRecorder = (page: Page) =>
    page.evaluate(() => {
      const w = window as unknown as { __ghostShots: Array<Record<string, unknown>> }
      w.__ghostShots = []
      new MutationObserver((muts) => {
        for (const mut of muts) {
          for (const node of mut.addedNodes) {
            if (!(node instanceof HTMLImageElement)) continue
            if (node.parentElement !== document.body) continue
            const effect = node.getAnimations()[0]?.effect as KeyframeEffect | undefined
            const kfs = effect?.getKeyframes() ?? []
            const last = (kfs[kfs.length - 1] ?? {}) as Record<string, unknown>
            const from = document
              .querySelector("[data-ghost-from]")
              ?.getBoundingClientRect()
            const to = document.querySelector("[data-ghost-to]")?.getBoundingClientRect()
            w.__ghostShots.push({
              left: parseFloat(node.style.left),
              top: parseFloat(node.style.top),
              lastTransform: String(last.transform ?? ""),
              duration: Number(effect?.getComputedTiming().duration),
              fromLeft: from?.left ?? null,
              fromTop: from?.top ?? null,
              toLeft: to?.left ?? null,
              toTop: to?.top ?? null,
            })
          }
        }
      }).observe(document.body, { childList: true })
    })

  const ghostSnapshots = (page: Page) =>
    page.evaluate(() => (window as unknown as { __ghostShots: Array<Record<string, unknown>> }).__ghostShots)

  test("PLAY flies the card media into the PlayerBar thumb; now-playing switches", async ({
    page,
  }) => {
    const { played } = await bootWithPlayback(page)
    const card = page.locator(".lib-card", { hasText: "Neon City" })

    await installGhostRecorder(page)
    await card.locator(".lib-media").evaluate((el) => ((el as HTMLElement).dataset.ghostFrom = "1"))
    await page.locator(".pbar-thumb").evaluate((el) => ((el as HTMLElement).dataset.ghostTo = "1"))
    await playCard(page, "Neon City")
    const ghosts = page.locator("body > img")
    await expect(ghosts).toHaveCount(1)

    // Start pose = the card media rect; the final keyframe lands exactly on
    // the PlayerBar thumb slot; 380ms — the registered §5 exception. All
    // rects were recorded in the spawn frame by the observer.
    await expect.poll(() => ghostSnapshots(page)).toHaveLength(1)
    const [g] = await ghostSnapshots(page)
    expect(g.duration).toBe(380)
    expect(g.left as number).toBeCloseTo(g.fromLeft as number, 0)
    expect(g.top as number).toBeCloseTo(g.fromTop as number, 0)
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(g.lastTransform as string)
    expect(m).not.toBeNull()
    expect((g.left as number) + parseFloat(m![1])).toBeCloseTo(g.toLeft as number, 0)
    expect((g.top as number) + parseFloat(m![2])).toBeCloseTo(g.toTop as number, 0)

    // PlayerBar switches to now-playing and the card lights NOW PLAYING.
    await expect.poll(() => played()).toContain(`/api/player/play/${itemA.workshop_id}`)
    await expect(page.locator(".pbar-title")).toHaveText("Neon City")
    await expect(card.locator(".lib-now")).toHaveText("NOW PLAYING")
    await expect(ghosts).toHaveCount(0, { timeout: 2000 })
  })

  test("rapid repeated PLAYs replace the ghost — never stack", async ({ page }) => {
    await bootWithPlayback(page)
    await playCard(page, "Neon City")
    await expect(page.locator("body > img")).toHaveCount(1)
    await playCard(page, "Rainy Window")
    // Mid-flight of the second ghost: the first was killed, nothing queued.
    await page.waitForTimeout(150)
    expect(await page.locator("body > img").count()).toBe(1)
    await expect(page.locator("body > img")).toHaveCount(0, { timeout: 2000 })
  })
})

test.describe("Library play ghost: reduced motion (ticket 12)", () => {
  test.use({ reducedMotion: "reduce" })

  test("no ghost; the play intent and now-playing switch still land", async ({ page }) => {
    const preview = "https://example.com/preview/neon.jpg"
    const item = mockLibraryItem({ preview_url: preview })
    let played: string | null = null
    await mockAuthDisabled(page)
    await page.route("**/api/system/summary", (r) => {
      const s = mockSystemSummary()
      if (played) {
        s.status.player.current_workshop_id = item.workshop_id
        s.status.player.playing = true
        s.status.player.current_title = item.title
      }
      void r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(s) })
    })
    await mockLibraryList(page, [item])
    await page.route("**/api/player/play/*", (r) => {
      played = r.request().url()
      void r.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })
    await page.goto("/library")
    const card = page.locator(".lib-card", { hasText: "Neon City" })
    await card.hover()
    await card.locator(".lib-act-primary", { hasText: "PLAY" }).click()
    await expect.poll(() => played).toContain(`/api/player/play/${item.workshop_id}`)
    await expect(page.locator(".pbar-title")).toHaveText("Neon City")
    await expect(card.locator(".lib-now")).toHaveText("NOW PLAYING")
    await page.waitForTimeout(500)
    expect(await page.locator("body > img").count()).toBe(0)
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

    // The band hugs the cursor card exactly. Poll until the slide has fully
    // settled — a fixed wait races the 250ms flight under suite load.
    const hug = async (i: number) => {
      await expect
        .poll(
          async () => {
            const m = await page.evaluate((idx) => {
              const ring = document.querySelector(".focus-ring")
              const card = document.querySelectorAll(".lib-card")[idx]
              if (!ring || !card) return null
              const r = ring.getBoundingClientRect()
              const c = card.getBoundingClientRect()
              const d = Math.max(
                Math.abs(r.x - c.x),
                Math.abs(r.y - c.y),
                Math.abs(r.width - c.width),
                Math.abs(r.height - c.height)
              )
              return { d, anims: ring.getAnimations().length }
            }, i)
            return m !== null && m.d <= 1.5 && m.anims === 0
          },
          { timeout: 3000 }
        )
        .toBe(true)
    }
    await hug(0)

    // 3 columns @1280px: right steps within the row, down jumps a row.
    await page.keyboard.press("ArrowRight")
    await expect(cards.nth(1)).toHaveClass(/lib-cursor/)
    await expect(ring.locator(".focus-ring-coord")).toHaveText("C2·R1")
    await page.keyboard.press("ArrowDown")
    await expect(cards.nth(3)).toHaveClass(/lib-cursor/) // clamped to last item
    await expect(ring.locator(".focus-ring-coord")).toHaveText("C1·R2")
    // Assert the settled end pose, not a mid-flight sample.
    await hug(3)

    // The band follows into the list view, row by row.
    await page.keyboard.press("v")
    await expect(page.locator(".ledger-row")).toHaveCount(4)
    await page.keyboard.press("ArrowUp")
    await expect(page.locator(".ledger-row").nth(2)).toHaveClass(/is-cursor/)
    await expect(ring.locator(".focus-ring-coord")).toHaveText("C1·R3")
  })
})
