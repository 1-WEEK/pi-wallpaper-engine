import { expect, test } from "playwright/test"
import type { Page } from "playwright"
import { mockSystemSummary } from "./fixtures.js"
import { mockAuthDisabled, mockLibraryList, mockSummary } from "./helpers.js"

const mockAllEndpoints = async (page: Page) => {
  await mockAuthDisabled(page)
  const summary = mockSystemSummary()
  await mockSummary(page, summary)
  await mockLibraryList(page, [])
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
  await page.route("**/api/download/tasks**", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], total: 0 }),
    })
  )
  await page.route("**/api/workshop/search*", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ total: 0, items: [] }),
    })
  )
}

test.describe("Desktop shell", () => {
  test("rail navigates between pages and marks the active link", async ({ page }) => {
    await mockAllEndpoints(page)
    await page.goto("/browse")

    const nav = page.locator(".rail-nav")
    await expect(nav.locator(".rail-nav-link")).toHaveCount(4)
    await expect(nav.locator(".rail-nav-link.is-here")).toHaveText(/Browse/)

    await nav.getByRole("link", { name: "Library" }).click()
    await expect(page).toHaveURL(/\/library$/)
    await expect(page.locator("h1.lib-title")).toContainText("Library")
    await expect(nav.locator(".rail-nav-link.is-here")).toHaveText(/Library/)

    await nav.getByRole("link", { name: "Settings" }).click()
    await expect(page.locator("h1.set-title")).toContainText("Settings")
  })

  test("rail shows the live activity task count", async ({ page }) => {
    await mockAuthDisabled(page)
    const summary = mockSystemSummary()
    summary.status.downloads.active = 3
    await mockSummary(page, summary)
    await mockLibraryList(page, [])
    await page.goto("/browse")

    await expect(
      page.locator(".rail-nav-link", { hasText: "Activity" }).locator(".rail-nav-count")
    ).toHaveText("3")
  })

  test("theme switch: AUTO follows the OS, manual choice overrides and persists", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" })
    await mockAllEndpoints(page)
    await page.goto("/browse")
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")

    // Manual choice overrides the system …
    await page.getByRole("button", { name: "[A]", exact: true }).click()
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light")

    // … and persists across reloads (inline boot script, no flash).
    await page.reload()
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light")

    // Back to AUTO: follows the OS again, live.
    await page.getByRole("button", { name: "[AUTO]", exact: true }).click()
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
    await page.emulateMedia({ colorScheme: "light" })
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
  })

  test("unknown routes land on Browse", async ({ page }) => {
    await mockAllEndpoints(page)
    await page.goto("/definitely-not-a-page")
    // Browse may append its default tag filter to the URL after landing.
    await expect(page).toHaveURL(/\/browse/)
  })
})

test.describe("Nav motion (ticket 11 — XOR mask, 09 票 N 方案)", () => {
  test("mask slides 420ms; pass-over rows invert transiently; coverage flips at settle; content commits ~120ms later", async ({
    page,
  }) => {
    await mockAllEndpoints(page)
    await page.goto("/browse")
    await expect(page.locator(".rail-nav-link.is-covered")).toHaveText(/Browse/)

    // Sample per animation frame for the whole flight instead of at fixed
    // clock offsets — under parallel-suite CPU load a setTimeout(210) probe
    // can land after the 420ms flight has already settled.
    const probe = await page.evaluate(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          const link = [...document.querySelectorAll(".rail-nav-link")].find((a) =>
            a.textContent?.includes("Settings")
          )!
          const mask = document.querySelector(".rail-nav-mask")!
          const out: Record<string, unknown> = {}
          const t0 = performance.now()
          let commitAt = -1
          let urlMidFlight: string | null = null
          let maxMaskedMidFlight = 0
          let coveredDuringFlight = false
          let flightRunning = false
          const poll = () => {
            const flying = mask
              .getAnimations()
              .some((a) => a.playState === "running" || a.playState === "pending")
            if (flying) {
              flightRunning = true
              if (commitAt < 0 && location.pathname !== "/browse") {
                commitAt = performance.now() - t0
                urlMidFlight = location.pathname
              }
              maxMaskedMidFlight = Math.max(
                maxMaskedMidFlight,
                document.querySelectorAll(".rail-nav-link.is-masked").length
              )
              if (document.querySelector(".rail-nav-link.is-covered")) coveredDuringFlight = true
              requestAnimationFrame(poll)
              return
            }
            if (!flightRunning && performance.now() - t0 < 1500) {
              requestAnimationFrame(poll) // flight not started yet (loaded env)
              return
            }
            // The flight is over. Coverage is React state — it lands a frame
            // after the animation's settle callback, so wait for it here.
            if (!document.querySelector(".rail-nav-link.is-covered")) {
              if (performance.now() - t0 < 3000) {
                requestAnimationFrame(poll)
                return
              }
            }
            // Settled: coverage flipped to the target, no residue, no
            // flicker — the mask sits exactly on the target row.
            out.commitAt = commitAt
            out.urlMidFlight = urlMidFlight
            out.maxMaskedMidFlight = maxMaskedMidFlight
            out.coveredDuringFlight = coveredDuringFlight
            out.flightRunning = flightRunning
            out.coveredAfter =
              document.querySelector(".rail-nav-link.is-covered")?.textContent ?? null
            out.residueAfter = document.querySelectorAll(
              ".rail-nav-link.is-masked, .rail-nav-link.is-sweeping"
            ).length
            const m = mask.getBoundingClientRect()
            const r = link.getBoundingClientRect()
            out.alignTop = Math.abs(m.top - r.top)
            out.alignHeight = Math.abs(m.height - r.height)
            resolve(out)
          }
          link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }))
          // t≈0: the indicator moves FIRST — flight running, route not yet committed.
          out.urlImmediately = location.pathname
          out.animatingImmediately = mask.getAnimations().length > 0
          requestAnimationFrame(poll)
        })
    )

    expect(probe.urlImmediately).toBe("/browse")
    expect(probe.animatingImmediately).toBe(true)
    expect(probe.flightRunning).toBe(true)
    expect(probe.commitAt).toBeGreaterThan(60)
    expect(probe.commitAt).toBeLessThan(1000)
    expect(probe.urlMidFlight).toBe("/settings")
    expect(probe.maxMaskedMidFlight).toBeGreaterThan(0)
    expect(probe.coveredDuringFlight).toBe(false)
    expect(probe.coveredAfter).toContain("Settings")
    expect(probe.residueAfter).toBe(0)
    expect(probe.alignTop).toBeLessThanOrEqual(1)
    expect(probe.alignHeight).toBeLessThanOrEqual(1)
  })

  test("hover shows a 1-bit checker band (SVG tile, no conic moiré) with carved-out text chips, both themes", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" })
    await mockAllEndpoints(page)
    await page.goto("/browse")
    const library = page.locator(".rail-nav-link", { hasText: "Library" })
    await library.hover()

    const read = () =>
      library.evaluate((el) => {
        const after = getComputedStyle(el, "::after")
        const label = getComputedStyle(el.querySelector(".rail-nav-label")!)
        return {
          afterBg: after.backgroundImage,
          chipBg: label.backgroundColor,
          chipShadow: label.boxShadow,
          railBg: getComputedStyle(document.querySelector(".rail")!).backgroundColor,
        }
      })

    const dark = await read()
    expect(dark.afterBg).toContain("data:image/svg+xml")
    expect(dark.afterBg).not.toContain("conic-gradient")
    expect(dark.afterBg).toContain("%23FFFFFF") // light checker squares on the dark theme
    expect(dark.chipBg).toBe(dark.railBg) // chip of page color behind the glyphs
    expect(dark.chipShadow).toContain("2px")

    // AUTO follows the OS live — the tile and chips flip with the theme.
    // (The rail's background has a 200ms theme transition; let it land.)
    await page.emulateMedia({ colorScheme: "light" })
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
    await page.waitForTimeout(300)
    const light = await read()
    expect(light.afterBg).toContain("%23000000")
    expect(light.chipBg).toBe(light.railBg)
  })

  test("hover → active handoff: the dither survives the flight and is clipped away in lockstep with the mask", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" })
    await mockAllEndpoints(page)
    await page.goto("/browse")
    const library = page.locator(".rail-nav-link", { hasText: "Library" })
    await library.hover()
    // Record the whole flight in-page — Playwright's click() roundtrip alone
    // can eat most of the 420ms window, so post-hoc sampling is too late.
    await library.evaluate((el) => {
      const w = window as unknown as { __handoff: Record<string, unknown>; __handoffDone: boolean }
      w.__handoffDone = false
      w.__handoff = {
        sweepingSeen: false,
        bandDuringSweep: false,
        clipInsetSeen: false,
        maxClipPct: 0,
        coveredDuringSweep: false,
      }
      const poll = () => {
        if (el.classList.contains("is-sweeping")) {
          const after = getComputedStyle(el, "::after")
          const h = w.__handoff
          h.sweepingSeen = true
          if (after.content !== "none") h.bandDuringSweep = true
          const m = /^inset\(([\d.]+)%/.exec(after.clipPath)
          if (m) {
            h.clipInsetSeen = true
            h.maxClipPct = Math.max(h.maxClipPct as number, parseFloat(m[1]))
          }
          if (el.classList.contains("is-covered")) h.coveredDuringSweep = true
        }
        if (!w.__handoffDone) requestAnimationFrame(poll)
      }
      requestAnimationFrame(poll)
    })
    await library.click()

    await expect(library).toHaveClass(/is-covered/, { timeout: 1500 })
    const handoff = await page.evaluate(() => {
      const w = window as unknown as { __handoff: Record<string, unknown>; __handoffDone: boolean }
      w.__handoffDone = true
      return w.__handoff
    })
    expect(handoff.sweepingSeen).toBe(true)
    expect(handoff.bandDuringSweep).toBe(true) // the dither band holds until full coverage
    expect(handoff.clipInsetSeen).toBe(true) // its swept region is clipped per frame
    expect(handoff.maxClipPct).toBeGreaterThan(20) // the clip really tracks the leading edge
    expect(handoff.coveredDuringSweep).toBe(false)

    const settled = await library.evaluate((el) => ({
      band: getComputedStyle(el, "::after").content,
      sweeping: el.classList.contains("is-sweeping"),
      sweepVar: el.style.getPropertyValue("--pt-sweep"),
    }))
    expect(settled.band).toBe("none") // seamless handoff at the settle moment
    expect(settled.sweeping).toBe(false)
    expect(settled.sweepVar).toBe("")
  })

  test("rail ledger rows share the language: hover dither band, selection stays accent text", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" })
    await mockAllEndpoints(page)
    await page.goto("/library")
    await expect(page.locator("h1.lib-title")).toContainText("Library")

    const offRow = page.locator(".lib-rc-row:not(.is-on)").first()
    await offRow.hover()
    const off = await offRow.evaluate((el) => ({
      bg: getComputedStyle(el).backgroundImage,
      chip: getComputedStyle(el.querySelector(".lib-rc-row-name")!).backgroundColor,
      railBg: getComputedStyle(document.querySelector(".rail")!).backgroundColor,
    }))
    expect(off.bg).toContain("data:image/svg+xml")
    expect(off.chip).toBe(off.railBg)

    const onRow = page.locator(".lib-rc-row.is-on").first()
    await onRow.hover()
    const on = await onRow.evaluate((el) => {
      const probe = document.createElement("span")
      probe.style.color = "var(--pt-accent)"
      document.body.appendChild(probe)
      const accent = getComputedStyle(probe).color
      probe.remove()
      return { bg: getComputedStyle(el).backgroundImage, color: getComputedStyle(el).color, accent }
    })
    expect(on.bg).toBe("none") // selected rows never get the dither or an inverse block
    expect(on.color).toBe(on.accent)
  })

  test("reduced motion: the mask jumps (no slide, no delay); hover/active visuals unchanged", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" })
    await mockAllEndpoints(page)
    await page.goto("/browse")
    await expect(page.locator(".rail-nav-link")).toHaveCount(4)
    const library = page.locator(".rail-nav-link", { hasText: "Library" })

    const immediate = await page.evaluate(() => {
      const link = [...document.querySelectorAll(".rail-nav-link")].find((a) =>
        a.textContent?.includes("Library")
      )!
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }))
      return {
        url: location.pathname,
        animations: document.querySelector(".rail-nav-mask")!.getAnimations().length,
      }
    })
    expect(immediate.url).toBe("/library") // committed instantly — no 120ms trail
    expect(immediate.animations).toBe(0) // the mask jumped, no flight
    await expect(library).toHaveClass(/is-here/)
    await expect(library).toHaveClass(/is-covered/)

    // Hover dither itself is not a motion — it stays (Mac 原味: 瞬时反馈).
    const settings = page.locator(".rail-nav-link", { hasText: "Settings" })
    await settings.hover()
    const hoverBg = await settings.evaluate(
      (el) => getComputedStyle(el, "::after").backgroundImage
    )
    expect(hoverBg).toContain("data:image/svg+xml")
  })
})

test.describe("Mobile shell", () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test("tab bar replaces the rail and navigates", async ({ page }) => {
    await mockAllEndpoints(page)
    await page.goto("/browse")

    await expect(page.locator(".mobile-shell")).toBeVisible()
    await expect(page.locator(".rail")).toHaveCount(0)

    const tabBar = page.locator(".mobile-tab-bar")
    await expect(tabBar).toBeVisible()
    await tabBar.getByRole("link", { name: /Library/ }).click()
    await expect(page).toHaveURL(/\/library$/)
  })

  test("hover preview and the coordinate grid stay desktop-only (no mobile substitute)", async ({
    page,
  }) => {
    await mockAllEndpoints(page)
    await page.goto("/browse")

    // The measured coordinate grid (spec §2.3) is a desktop signature — on
    // mobile it is simply absent, not degraded.
    await expect(page.locator(".bws-gridlines")).toHaveCount(0)
    await expect(page.locator(".focus-ring")).toHaveCount(0)
  })

  test("mini player opens the sheet with the PlayerBar's instant controls", async ({ page }) => {
    await mockAllEndpoints(page)
    let postedMode: string | null = null
    await page.route("**/api/player/mode", (r) => {
      postedMode = (r.request().postDataJSON() as { mode: string }).mode
      return r.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })
    await page.goto("/browse")

    // PlayerBar degrades to MiniPlayer + Sheet (spec §9).
    await expect(page.locator(".pbar")).toHaveCount(0)
    await page.getByRole("button", { name: "Open player controls" }).click()

    const sheet = page.locator(".mobile-sheet.open")
    await expect(sheet).toBeVisible()
    await expect(sheet.getByRole("radiogroup", { name: "Play mode", exact: true })).toBeVisible()
    await expect(
      sheet.getByRole("radiogroup", { name: "Display mode", exact: true })
    ).toBeVisible()
    await expect(sheet.getByRole("radiogroup", { name: "Sleep timer" })).toBeVisible()

    // The sheet controls commit against the same endpoints as the dock.
    await sheet.getByRole("radio", { name: "SHUFFLE" }).click()
    await expect.poll(() => postedMode).toBe("shuffle")

    await sheet.getByRole("button", { name: "Close" }).click()
    await expect(page.locator(".mobile-sheet.open")).toHaveCount(0)
  })

  test("touch targets are ≥44px across the mobile chrome", async ({ page }) => {
    await mockAllEndpoints(page)
    await page.goto("/browse")

    for (const item of await page.locator(".mobile-tab-bar-item").all()) {
      const box = (await item.boundingBox())!
      expect(box.height).toBeGreaterThanOrEqual(44)
    }
    for (const btn of await page.locator(".mobile-mini-player-btn").all()) {
      const box = (await btn.boundingBox())!
      expect(box.width).toBeGreaterThanOrEqual(44)
      expect(box.height).toBeGreaterThanOrEqual(44)
    }
    const open = await page.locator(".mobile-mini-player-open").boundingBox()
    expect(open!.height).toBeGreaterThanOrEqual(44)

    await page.getByRole("button", { name: "Open player controls" }).click()
    const close = await page.locator(".mobile-sheet.open .mobile-sheet-close").boundingBox()
    expect(close!.width).toBeGreaterThanOrEqual(44)
    expect(close!.height).toBeGreaterThanOrEqual(44)
  })
})

test.describe("Desktop no-leak (ticket 14)", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("no mobile degradation leaks into the wide desktop shell", async ({ page }) => {
    await mockAllEndpoints(page)
    await page.goto("/settings")

    await expect(page.locator(".mobile-shell")).toHaveCount(0)
    await expect(page.locator(".mobile-tab-bar")).toHaveCount(0)
    await expect(page.locator(".mobile-mini-player")).toHaveCount(0)
    await expect(page.locator(".mobile-sheet")).toHaveCount(0)
    await expect(page.locator(".setm-list")).toHaveCount(0)

    await expect(page.locator(".rail")).toBeVisible()
    await expect(page.locator(".pbar")).toBeVisible()
    await expect(page.locator(".set-title")).toContainText("Settings")
  })
})
