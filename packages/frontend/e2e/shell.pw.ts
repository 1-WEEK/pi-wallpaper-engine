import { expect, test } from "playwright/test"
import type { Page } from "playwright"
import { mockSystemSummary } from "./fixtures.js"
import { mockAuthDisabled, mockLibraryList, mockSummary, freezePageClock } from "./helpers.js"

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
      // A cold vite compile can eat the default 5s expect window.
    ).toHaveText("3", { timeout: 15000 })
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
          // Timestamp the route commit EXACTLY: wouter navigates via
          // history.pushState. Watching pathname on rAF frames inflates the
          // reading under suite load (starved frames observe the commit
          // hundreds of ms late); the hook fires synchronously with the
          // commit itself.
          const origPush = history.pushState.bind(history)
          history.pushState = (...args: Parameters<typeof history.pushState>) => {
            if (commitAt < 0 && String(args[2]) !== "/browse") {
              commitAt = performance.now() - t0
              urlMidFlight = String(args[2])
            }
            return origPush(...args)
          }
          const poll = () => {
            const flying = mask
              .getAnimations()
              .some((a) => a.playState === "running" || a.playState === "pending")
            if (flying) {
              flightRunning = true
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
            // Also wait for the commit itself: under suite load the 120ms
            // commit timer can out-starve the whole flight (observed:
            // settle landed while the timer was still queued → commitAt=-1).
            if (commitAt < 0 && performance.now() - t0 < 8000) {
              requestAnimationFrame(poll)
              return
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
    // Scheduled at 120ms; the generous upper bound only tolerates timer
    // starvation under parallel-suite load — a synchronous (<60ms) or
    // missing (-1 after the 8s probe cap) commit still fails.
    expect(probe.commitAt).toBeLessThan(2000)
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
    // (The rail's background has a 200ms theme transition; poll for it to
    // land — under load the transition can start late and outlive a fixed
    // sleep, reading a mid-flight railBg ≠ the instantly-flipped chipBg.)
    await page.emulateMedia({ colorScheme: "light" })
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
    await expect
      .poll(async () => {
        const { chipBg, railBg } = await read()
        return chipBg === railBg
      })
      .toBe(true)
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
    /* Trap the mask slide at creation and freeze it half-way (210ms of the
     * 420ms flight): the sweep recorder below and the app's own --pt-sweep
     * writer both sample rAF frames, which starve under suite load — a live
     * flight can settle between two samples and the clip reads a near-zero
     * early frame (observed: 4.7% vs the >20% assertion). Frozen, every
     * produced frame shows the same mid-flight coverage. */
    await page.evaluate(() => {
      const w = window as unknown as {
        __maskAnim: Animation | null
        __origAnimate: typeof Element.prototype.animate
      }
      w.__maskAnim = null
      w.__origAnimate = Element.prototype.animate
      Element.prototype.animate = function (
        this: Element,
        kfs: Keyframe[] | PropertyIndexedKeyframes | null,
        opts?: number | KeyframeAnimationOptions
      ): Animation {
        const anim = w.__origAnimate.call(this, kfs, opts)
        if ((this as HTMLElement).classList?.contains("rail-nav-mask")) {
          anim.pause()
          anim.currentTime = 210
          w.__maskAnim = anim
        }
        return anim
      }
    })
    /* Freeze the flight's timers (120ms route commit, 540ms settle
     * fallback): the frozen animation never finishes, so without this the
     * fallback would tear the flight down mid-probe under load. Note
     * page.clock also fakes requestAnimationFrame — while paused neither the
     * app's --pt-sweep writer nor the recorder below tick on their own; the
     * probe advances them deterministically via clock.runFor. */
    await freezePageClock(page)
    // Record the frozen flight in-page — Playwright's click() roundtrip alone
    // can eat most of a live 420ms window, so post-hoc sampling is too late.
    // (Click's actionability probe uses the raw builtin rAF, so it still
    // works with the clock paused.)
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

    /* The flight is frozen at half coverage: the sweep clip MUST reach the
     * middle of the row. The paused clock owns rAF now — tick ~4 frames so
     * the app writes --pt-sweep from the frozen pose and the recorder sees
     * it. 64ms stays well under the 120ms commit timer, so nothing tears
     * the flight down mid-probe. */
    await page.clock.runFor(64)
    const handoff = await page.evaluate(() => (window as any).__handoff)
    expect(handoff.maxClipPct).toBeGreaterThan(20)
    expect(handoff.sweepingSeen).toBe(true)
    expect(handoff.bandDuringSweep).toBe(true) // the dither band holds until full coverage
    expect(handoff.clipInsetSeen).toBe(true) // its swept region is clipped per frame
    expect(handoff.coveredDuringSweep).toBe(false)

    /* Unfreeze: restore the prototype, stop the recorder, resume the flight
     * and let the frozen timers (commit + settle) run out. */
    await page.evaluate(() => {
      const w = window as unknown as {
        __maskAnim: Animation | null
        __origAnimate: typeof Element.prototype.animate
        __handoffDone: boolean
      }
      Element.prototype.animate = w.__origAnimate
      w.__handoffDone = true
      w.__maskAnim?.play()
    })
    await page.clock.runFor(1000)
    await expect(library).toHaveClass(/is-covered/, { timeout: 1500 })

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
    await expect(sheet.getByRole("radiogroup", { name: "Play limit", exact: true })).toBeVisible()

    // The sheet controls commit against the same endpoints as the dock.
    await sheet.getByRole("radio", { name: "SHUFFLE" }).click()
    await expect.poll(() => postedMode).toBe("shuffle")

    await sheet.getByRole("button", { name: "Close" }).click()
    await expect(page.locator(".mobile-sheet.open")).toHaveCount(0)
  })

  test("touch targets are ≥44px across the mobile chrome", async ({ page }) => {
    await mockAllEndpoints(page)
    await page.goto("/browse")

    // boundingBox() returns fractional px — a 44 CSS px target can read
    // 43.999969 under sub-pixel rounding, so compare with a 0.1px epsilon.
    const EPS = 0.1
    for (const item of await page.locator(".mobile-tab-bar-item").all()) {
      const box = (await item.boundingBox())!
      expect(box.height).toBeGreaterThanOrEqual(44 - EPS)
    }
    for (const btn of await page.locator(".mobile-mini-player-btn").all()) {
      const box = (await btn.boundingBox())!
      expect(box.width).toBeGreaterThanOrEqual(44 - EPS)
      expect(box.height).toBeGreaterThanOrEqual(44 - EPS)
    }
    const open = await page.locator(".mobile-mini-player-open").boundingBox()
    expect(open!.height).toBeGreaterThanOrEqual(44 - EPS)

    await page.getByRole("button", { name: "Open player controls" }).click()
    const close = await page.locator(".mobile-sheet.open .mobile-sheet-close").boundingBox()
    expect(close!.width).toBeGreaterThanOrEqual(44 - EPS)
    expect(close!.height).toBeGreaterThanOrEqual(44 - EPS)
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

test.describe("Shell theme surface (ticket 01)", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  /* Every page box stops at the scroller's content box (its own bleed padding
   * keeps the dock clear), so a short page leaves a band between the box and
   * the viewport bottom. That band belongs to the shell and MUST resolve to
   * the page's theme colour — it used to fall through to the legacy hardcoded
   * dark, painting a black strip under a light page and a second black under
   * a dark one. Probe the real composited colour per pixel row, including the
   * rows the page box does not reach. */
  const backgroundBands = (page: Page, x: number) =>
    page.evaluate((probeX) => {
      const bands: string[] = []
      for (let y = 4; y < window.innerHeight - 4; y += 4) {
        let el = document.elementFromPoint(probeX, y) as HTMLElement | null
        let bg = ""
        while (el) {
          const cs = getComputedStyle(el).backgroundColor
          if (cs && cs !== "rgba(0, 0, 0, 0)") {
            bg = cs
            break
          }
          el = el.parentElement
        }
        bands.push(bg)
      }
      return bands
    }, x)

  // The dock's translucent fill and the rail's hairline overlay the theme, so
  // only the opaque readings are compared — an opaque legacy dark appearing in
  // the column is exactly the regression.
  const opaqueOnly = (bands: string[]) => [...new Set(bands.filter((b) => b.startsWith("rgb(")))]

  for (const path of ["/settings", "/library", "/browse", "/activity"]) {
    test(`${path} paints one theme background at every depth, both themes`, async ({ page }) => {
      await mockAllEndpoints(page)
      await page.goto(path)

      for (const theme of ["dark", "light"] as const) {
        await page.evaluate((t) => {
          localStorage.setItem("pwe-theme", t)
          document.documentElement.dataset.theme = t
          document.documentElement.style.colorScheme = t
        }, theme)
        // The theme flip is transitioned on the shell and page boxes.
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
        await expect
          .poll(async () => opaqueOnly(await backgroundBands(page, 900)))
          .toEqual([theme === "dark" ? "rgb(0, 0, 0)" : "rgb(251, 250, 244)"])

        // The shell's inherited ink follows the theme too (a page box that
        // stops short no longer hands legacy cream text to the shell).
        const shellInk = await page.evaluate(() => getComputedStyle(document.body).color)
        expect(shellInk).toBe(
          theme === "dark" ? "rgba(255, 255, 255, 0.88)" : "rgba(0, 0, 0, 0.86)"
        )
      }
    })
  }
})
