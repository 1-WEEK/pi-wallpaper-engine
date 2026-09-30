// Interface sound layer (ticket 13, sound spec §3/§5/§6). Behavioral
// verification only: sounds are pure Web Audio synthesis, so every sounding
// layer creates one OscillatorNode — the probe counts createOscillator calls
// (and AudioContext constructions) as the "a sound fired" signal.
import { expect, test } from "playwright/test"
import type { Page } from "playwright"
import type { ActivityTask } from "@pwe/shared"
import { mockLibraryItem, mockSystemSummary, mockWorkshopItems } from "./fixtures.js"
import {
  mockAuthDisabled,
  mockLibraryList,
  mockSummary,
  mockWorkshopSearch,
} from "./helpers.js"

/** Counts oscillator creations; optionally presets the master switch ON. */
const installProbe = (page: Page, opts: { enabled?: boolean } = {}) =>
  page.addInitScript((o) => {
    const w = window as unknown as {
      __osc: number
      __ctx: number
      AudioContext: typeof AudioContext
    }
    if (o.enabled) localStorage.setItem("pwe-interface-sounds", "1")
    w.__osc = 0
    w.__ctx = 0
    const proto = window.AudioContext.prototype
    const origCreate = proto.createOscillator
    proto.createOscillator = function (
      this: AudioContext,
      ...args: Parameters<AudioContext["createOscillator"]>
    ) {
      w.__osc += 1
      return origCreate.apply(this, args)
    }
    const OrigAC = window.AudioContext
    w.AudioContext = class extends OrigAC {
      constructor(...args: ConstructorParameters<typeof AudioContext>) {
        w.__ctx += 1
        super(...args)
      }
    }
  }, opts)

const probe = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __osc: number; __ctx: number }
    return { osc: w.__osc, ctx: w.__ctx }
  })

const mockShell = async (page: Page, summary = mockSystemSummary()) => {
  await mockAuthDisabled(page)
  await mockSummary(page, summary)
  await mockLibraryList(page, [])
  await mockWorkshopSearch(page, mockWorkshopItems(4), 4)
  await page.route("**/api/download/tasks**", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], total: 0 }),
    })
  )
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
        migration: null,
      }),
    })
  )
}

const setHidden = (page: Page, hidden: boolean) =>
  page.evaluate((h) => {
    Object.defineProperty(document, "hidden", { value: h, configurable: true })
    document.dispatchEvent(new Event("visibilitychange"))
  }, hidden)

test.describe("interface sound layer", () => {
  test("master switch defaults OFF: navigation works but stays silent", async ({ page }) => {
    await installProbe(page)
    await mockShell(page)
    await page.goto("/browse")

    await expect(page.locator(".sound-dot")).toHaveCount(0)
    await page.locator(".rail-nav-link", { hasText: "Library" }).click()
    await expect(page).toHaveURL(/\/library/)
    const counts = await probe(page)
    expect(counts.osc).toBe(0)
    // Disabled must not even create the AudioContext.
    expect(counts.ctx).toBe(0)
  })

  test("enabled: nav fires on rail navigation and ledger row select", async ({ page }) => {
    await installProbe(page, { enabled: true })
    await mockShell(page)
    await page.goto("/browse")

    await page.locator(".rail-nav-link", { hasText: "Activity" }).click()
    await expect(page).toHaveURL(/\/activity/)
    expect((await probe(page)).osc).toBeGreaterThanOrEqual(1)

    // Ledger row select (Browse list view) — nav family again.
    await page.goto("/browse")
    await expect(page.locator(".bws-card").first()).toBeVisible()
    await page.keyboard.press("v")
    const before = (await probe(page)).osc
    await page.locator(".ledger-row").nth(1).click()
    expect((await probe(page)).osc).toBe(before + 1)
  })

  test("nav and transport fire at pointerdown, exactly once per press", async ({ page }) => {
    await installProbe(page, { enabled: true })
    const summary = mockSystemSummary()
    summary.status.player = {
      ...summary.status.player,
      playing: true,
      current_workshop_id: "1693728660",
      current_title: "Neon City",
    }
    await mockShell(page, summary)
    await page.route("**/api/player/next", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    )
    await page.goto("/browse")

    // Sound spec §3: the nav family's trigger point is pointerdown (same
    // frame as :active) — dispatching pointerdown alone already sounds.
    const before = (await probe(page)).osc
    await page.locator(".rail-nav-link", { hasText: "Library" }).dispatchEvent("pointerdown")
    expect((await probe(page)).osc).toBe(before + 1)
    // The trailing click (navigation semantic layer) must NOT double-fire…
    await page.locator(".rail-nav-link", { hasText: "Library" }).click()
    await expect(page).toHaveURL(/\/library/)
    expect((await probe(page)).osc).toBe(before + 2) // one for the bare press, one for the click

    // …and the press+release of a single real click is exactly one voice.
    const mid = (await probe(page)).osc
    await page.locator(".rail-nav-link", { hasText: "Browse" }).click()
    expect((await probe(page)).osc).toBe(mid + 1)

    // Transport (commit family, 3 layers). Keyboard activation first — no
    // pointerdown precedes it, so the click semantic layer fires the sound.
    const k0 = (await probe(page)).osc
    await page.getByRole("button", { name: "Next wallpaper" }).press("Enter")
    expect((await probe(page)).osc).toBe(k0 + 3)

    // …and the pointer path fires at pointerdown. (The waits step past the
    // trigger's 80ms cooldown so each gesture is its own voice.)
    await page.waitForTimeout(120)
    const t0 = (await probe(page)).osc
    await page.getByRole("button", { name: "Next wallpaper" }).dispatchEvent("pointerdown")
    expect((await probe(page)).osc).toBe(t0 + 3)

    // A full real click (press+release) is exactly one voice, not two.
    await page.waitForTimeout(120)
    const c0 = (await probe(page)).osc
    await page.getByRole("button", { name: "Next wallpaper" }).click()
    expect((await probe(page)).osc).toBe(c0 + 3)
  })

  test("commit fires on download accept and PlayerBar transport", async ({ page }) => {
    await installProbe(page, { enabled: true })
    const summary = mockSystemSummary()
    summary.status.player = {
      ...summary.status.player,
      playing: true,
      current_workshop_id: "1693728660",
      current_title: "Neon City",
    }
    await mockShell(page, summary)
    await page.route("**/api/download/*", (r) => {
      if (r.request().method() !== "POST") return r.fallback()
      return r.fulfill({ status: 202, contentType: "application/json", body: "{}" })
    })
    await page.route("**/api/player/next", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    )
    await page.goto("/browse")
    await expect(page.locator(".bws-card").first()).toBeVisible()

    // Download accept — commit family (3 layers).
    let before = (await probe(page)).osc
    await page.locator(".bws-add", { hasText: "ADD" }).first().click()
    await expect(page.locator(".bws-add", { hasText: "QUEUED" }).first()).toBeVisible()
    expect((await probe(page)).osc).toBe(before + 3)

    // PlayerBar transport — commit family again.
    before = (await probe(page)).osc
    await page.getByRole("button", { name: "Next wallpaper" }).click()
    expect((await probe(page)).osc).toBe(before + 3)
  })

  test("cooldown: a synchronous nav burst collapses to one voice", async ({ page }) => {
    await installProbe(page, { enabled: true })
    await mockShell(page)
    await page.goto("/browse")
    // Unlock from a real gesture first so the burst below only measures
    // cooldown, not unlock bookkeeping.
    await page.locator(".bws-head").click()
    const before = (await probe(page)).osc
    await page.evaluate(() => {
      /* Freeze performance.now() for the burst: each click handler runs
       * flyTo's forced synchronous layout, which under parallel-suite load
       * can stretch the "synchronous" forEach past the 50ms nav cooldown
       * (observed: +2 voices on a load-average-11 box). The test's subject
       * is the cooldown collapse, not layout speed — pin the clock so the
       * burst is truly simultaneous. */
      const realNow = performance.now.bind(performance)
      const frozen = realNow()
      performance.now = () => frozen
      try {
        document
          .querySelectorAll<HTMLElement>(".rail-nav-link")
          .forEach((el) => el.click())
      } finally {
        performance.now = realNow
      }
    })
    expect((await probe(page)).osc).toBe(before + 1)
  })

  test("shell mute dot: instant, outside the PlayerBar, persists", async ({ page }) => {
    await installProbe(page, { enabled: true })
    await mockShell(page)
    await page.goto("/browse")

    const dot = page.locator(".sound-dot")
    await expect(dot).toBeVisible()
    // Semantics/position separation: the dot is not part of the PlayerBar.
    await expect(page.locator(".pbar .sound-dot")).toHaveCount(0)
    await expect(dot).toHaveAttribute("aria-pressed", "false")

    await dot.click()
    await expect(dot).toHaveAttribute("aria-pressed", "true")
    const before = (await probe(page)).osc
    await page.locator(".rail-nav-link", { hasText: "Library" }).click()
    await expect(page).toHaveURL(/\/library/)
    expect((await probe(page)).osc).toBe(before)

    // Muted state survives reload; the dot still shows it.
    await page.reload()
    await expect(page.locator(".sound-dot")).toHaveAttribute("aria-pressed", "true")
    await page.locator(".sound-dot").click()
    await expect(page.locator(".sound-dot")).toHaveAttribute("aria-pressed", "false")
    const muted = (await probe(page)).osc
    await page.locator(".rail-nav-link", { hasText: "Browse" }).click()
    expect((await probe(page)).osc).toBe(muted + 1)
  })

  test("hidden tab drops triggers and never replays on return", async ({ page }) => {
    await installProbe(page, { enabled: true })
    await mockShell(page)
    await page.goto("/browse")

    await setHidden(page, true)
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('[data-nav="library"]')?.click()
    })
    expect((await probe(page)).osc).toBe(0)

    // Back to visible: the next gesture plays exactly once — no backlog.
    await setHidden(page, false)
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('[data-nav="activity"]')?.click()
    })
    expect((await probe(page)).osc).toBe(1)
  })

  test("reduced motion skips the transition family (display toggle)", async ({ page }) => {
    await installProbe(page, { enabled: true })
    const summary = mockSystemSummary()
    summary.status.display = {
      configured: true,
      state: "on",
      source: "default",
      error_kind: null,
    }
    await mockShell(page, summary)
    await page.route("**/api/display/off", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, state: "off" }),
      })
    )
    await page.goto("/browse")
    const toggle = page.getByRole("button", { name: "Turn display off" })
    await expect(toggle).toBeVisible()

    await page.emulateMedia({ reducedMotion: "reduce" })
    const before = (await probe(page)).osc
    await toggle.click()
    expect((await probe(page)).osc).toBe(before)

    // nav/commit/warn stay live under reduced motion — only transition skips.
    await page.locator(".rail-nav-link", { hasText: "Library" }).click()
    expect((await probe(page)).osc).toBe(before + 1)

    await page.emulateMedia({ reducedMotion: "no-preference" })
    await page.getByRole("button", { name: "Turn display off" }).click()
    // transition family = 2 layers
    expect((await probe(page)).osc).toBe(before + 1 + 2)
  })

  test("state receipt: a download completing fires the transition family", async ({ page }) => {
    await installProbe(page, { enabled: true })
    const running: ActivityTask = {
      task_id: "t-1",
      task_type: "download",
      workshop_id: "1693728660",
      title: "Neon City",
      preview_url: "",
      content_rating: "Everyone",
      rating_sex: null,
      adult_hint: 0,
      stage: "downloading",
      message: "",
      started_at: Date.now() - 5000,
      finished_at: null,
      percent: 40,
      bytes_done: 40,
      bytes_total: 100,
    }
    const tasksRef: { current: ActivityTask[] } = { current: [running] }

    await mockAuthDisabled(page)
    await mockSummary(page)
    await mockLibraryList(page, [])
    await page.route("**/api/download/tasks**", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: tasksRef.current, total: tasksRef.current.length }),
      })
    )
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
          migration: null,
        }),
      })
    )

    await page.goto("/activity")
    await expect(page.locator(".act-row").first()).toBeVisible()
    const before = (await probe(page)).osc

    // The 1s poll picks up the completion — a state receipt, not a gesture.
    // (SWR's 10s dedupe window means the flip can take a while to arrive;
    // activity.pw.ts uses the same generous timeout.)
    tasksRef.current = [{ ...running, stage: "complete", finished_at: Date.now(), percent: 100 }]
    await expect
      .poll(async () => (await probe(page)).osc - before, { timeout: 20000 })
      .toBe(2)
  })

  test("warn fires when a destructive confirm arms", async ({ page }) => {
    await installProbe(page, { enabled: true })
    await mockShell(page)
    // The wide transcoded-meta caption overflows the first card's hover
    // actions past the card edge (pre-existing layout quirk; library.pw.ts
    // clicks the second card for the same reason) — arm a short-meta card.
    await mockLibraryList(page, [
      mockLibraryItem(),
      mockLibraryItem({
        workshop_id: "222",
        title: "Rainy Window",
        transcode_status: "failed",
        transcode_progress: 0,
        transcoded_path: null,
        transcoded_resolution: null,
        transcoded_codec: null,
        transcoded_size: null,
        transcode_error: "ffmpeg exited 1",
      }),
    ])
    await page.goto("/library")
    const card = page.locator(".lib-card", { hasText: "Rainy Window" })
    await expect(card).toBeVisible()

    await card.hover()
    const before = (await probe(page)).osc
    const del = card.locator(".lib-act-danger")
    await del.click()
    // warn family = 3 layers; armed state shows SURE?
    await expect(del).toHaveText("SURE?")
    expect((await probe(page)).osc).toBe(before + 3)
  })

  test("master switch in Settings drives the engine and persists", async ({ page }) => {
    await installProbe(page)
    await mockShell(page)
    await page.goto("/settings")

    const seg = page.getByRole("radiogroup", { name: "Interface sounds" })
    await seg.getByRole("radio", { name: "ON" }).click()
    await expect(seg.getByRole("radio", { name: "ON" })).toHaveAttribute("aria-checked", "true")
    // The shell dot appears once the master switch is on.
    await expect(page.locator(".sound-dot")).toBeVisible()

    await page.reload()
    await expect(
      page.getByRole("radiogroup", { name: "Interface sounds" }).getByRole("radio", { name: "ON" })
    ).toHaveAttribute("aria-checked", "true")
    await page.locator(".rail-nav-link", { hasText: "Library" }).click()
    expect((await probe(page)).osc).toBeGreaterThanOrEqual(1)
  })
})
