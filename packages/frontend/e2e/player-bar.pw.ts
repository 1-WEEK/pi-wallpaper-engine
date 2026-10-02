import { expect, test } from "playwright/test"
import type { Page } from "playwright"
import type { SystemSummary } from "@pwe/shared"
import { mockSystemSummary } from "./fixtures.js"
import { mockAuthDisabled, mockLibraryList, freezePageClock } from "./helpers.js"

const playingSummary = (): SystemSummary => {
  const summary = mockSystemSummary()
  summary.status.player = {
    ...summary.status.player,
    playing: true,
    current_workshop_id: "1693728660",
    current_title: "Neon City",
    current_resolution: "1920x1080",
    current_codec: "hevc",
  }
  return summary
}

/** Summary is served from a mutable ref so actions can change what the next poll sees. */
const mockAllEndpoints = async (page: Page, summaryRef: { value: SystemSummary }) => {
  await mockAuthDisabled(page)
  await mockLibraryList(page, [])
  await page.route("**/api/system/summary", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(summaryRef.value),
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

test.describe("PlayerBar glass dock", () => {
  test("shows the current wallpaper and transport state", async ({ page }) => {
    await mockAllEndpoints(page, { value: playingSummary() })
    await page.goto("/browse")

    const dock = page.locator(".pbar")
    await expect(dock.locator(".pbar-title")).toHaveText("Neon City")
    await expect(dock.locator(".pbar-sub")).toContainText("looping")
    await expect(dock.locator(".pbar-codec")).toContainText("1920x1080 · hevc")
    await expect(dock.getByRole("button", { name: "Pause playback" })).toBeEnabled()
  })

  test("idle player disables current-item controls", async ({ page }) => {
    await mockAllEndpoints(page, { value: mockSystemSummary() })
    await page.goto("/browse")

    const dock = page.locator(".pbar")
    await expect(dock.locator(".pbar-title")).toHaveText("No wallpaper selected")
    await expect(dock.getByRole("button", { name: "Resume playback" })).toBeDisabled()
    // Next/prev drive rotation and stay usable without a current item.
    await expect(dock.getByRole("button", { name: "Next wallpaper" })).toBeEnabled()
  })

  test("names a missing media root instead of reading as an idle player", async ({ page }) => {
    // Ticket 01 (`.scratch/playback-mount-resilience`): with the media root
    // unmounted, the player is idle and the wallpaper it would restore is not
    // on screen. The dock is the surface visible on every page, so the outage
    // has to be named there — "idle" would be a lie the administrator cannot
    // act on.
    const summary = mockSystemSummary()
    summary.status.player.current_workshop_id = "1693728660"
    summary.status.storage = {
      ...summary.status.storage,
      available: false,
      used_bytes: null,
      free_bytes: null,
      total_bytes: null,
      used_percent: null,
      last_error:
        "Media root is not accessible at /mnt/pi-wallpaper-engine-data: the directory does not exist (ENOENT).",
      error: "Media root is not accessible at /mnt/pi-wallpaper-engine-data: the directory does not exist (ENOENT).",
    }

    await mockAllEndpoints(page, { value: summary })
    await page.goto("/browse")

    const dock = page.locator(".pbar")
    await expect(dock.locator(".pbar-sub")).toContainText("storage unavailable")
    await expect(dock.locator(".pbar-sub")).not.toContainText("paused")
    // The causing path reaches the user, not just an "unavailable" verdict.
    await expect(dock.locator(".pbar-notice")).toContainText("/mnt/pi-wallpaper-engine-data")
  })

  test("pause posts to the API and the bar reflects the paused state", async ({ page }) => {
    const summaryRef = { value: playingSummary() }
    await mockAllEndpoints(page, summaryRef)

    let pausePosted = false
    await page.route("**/api/player/pause", (r) => {
      pausePosted = true
      const next = playingSummary()
      next.status.player.playing = false
      summaryRef.value = next
      return r.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })

    await page.goto("/browse")
    await page.getByRole("button", { name: "Pause playback" }).click()

    await expect.poll(() => pausePosted).toBe(true)
    // onRefresh refetches the summary, which now reports paused.
    await expect(page.getByRole("button", { name: "Resume playback" })).toBeVisible()
    await expect(page.locator(".pbar-sub")).toContainText("paused")
  })

  test("DISPLAY popover posts the chosen mode and stays open", async ({ page }) => {
    const summaryRef = { value: playingSummary() }
    await mockAllEndpoints(page, summaryRef)

    let postedMode: string | null = null
    await page.route("**/api/player/display-mode", (r) => {
      postedMode = (r.request().postDataJSON() as { mode: string }).mode
      const next = playingSummary()
      next.status.player.display_mode = "fit"
      summaryRef.value = next
      return r.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })

    await page.goto("/browse")
    await page.getByRole("button", { name: "Display mode", exact: true }).click()
    const pop = page.locator(".pbar-pop").filter({ hasText: "DISPLAY" })
    await expect(pop).toBeVisible()

    // Segmenter semantics: the popover stays open so modes can be compared.
    await pop.getByRole("button", { name: "FIT" }).click()
    await expect.poll(() => postedMode).toBe("fit")
    await expect(pop).toBeVisible()
    await expect(pop.getByRole("button", { name: "FIT" })).toHaveClass(/is-on/)
  })

  test("popover bottom floats 12px above the glass top, right edge flush with the cluster", async ({
    page,
  }) => {
    await mockAllEndpoints(page, { value: playingSummary() })
    await page.goto("/browse")

    await page.getByRole("button", { name: "Display mode", exact: true }).click()
    const pop = page.locator(".pbar-pop").filter({ hasText: "DISPLAY" })
    await expect(pop).toBeVisible()
    // The 200ms enter transition shifts the transformed box; measure at rest.
    await page.waitForTimeout(260)

    const popBox = await pop.boundingBox()
    const innerBox = await page.locator(".pbar-inner").boundingBox()
    const clusterBox = await page.locator(".pbar-cluster").boundingBox()
    if (!popBox || !innerBox || !clusterBox) throw new Error("missing bounding boxes")

    expect(popBox.y + popBox.height).toBeCloseTo(innerBox.y - 12, 0)
    expect(popBox.x + popBox.width).toBeCloseTo(clusterBox.x + clusterBox.width, 0)
  })

  test("display → limit quick-switch lets the old popover exit while the new one enters", async ({
    page,
  }) => {
    await mockAllEndpoints(page, { value: playingSummary() })
    await page.goto("/browse")

    await page.getByRole("button", { name: "Display mode", exact: true }).click()
    const displayPop = page.locator(".pbar-pop").filter({ hasText: "DISPLAY" })
    await expect(displayPop).toBeVisible()

    await page.getByRole("button", { name: "Play limit" }).click()
    const limitPop = page.locator(".pbar-pop").filter({ hasText: "PLAY LIMIT" })
    await expect(limitPop).toBeVisible()
    // The display popover leaves on its mirrored 150ms exit instead of
    // vanishing in the same frame (the mid-exit window is too short to
    // assert without races); it always ends up unmounted.
    await expect(displayPop).toHaveCount(0)
  })

  test("popover exit beat: 150ms fade + translateY(6px), no snap-off (spec §5 F2)", async ({
    page,
  }) => {
    await mockAllEndpoints(page, { value: playingSummary() })
    await page.goto("/browse")

    await page.getByRole("button", { name: "Display mode", exact: true }).click()
    const pop = page.locator(".pbar-pop").filter({ hasText: "DISPLAY" })
    await expect(pop).toBeVisible()

    /* Freeze the unmount timer: closePop() removes the popover on a real
     * 150ms setTimeout, which races the probes below. And trap the exit
     * transition at its birth: a transition lives only 150ms of REAL time,
     * so a post-hoc getAnimations() probe can land after it finished (the
     * finished transition is dropped and the read comes back null).
     * Listening for transitionrun and pausing inside the handler freezes
     * the exit deterministically, no matter how loaded the machine is. */
    await page.evaluate(() => {
      const w = window as unknown as { __popExit: { opacity: number; duration: string } | null }
      w.__popExit = null
      document.addEventListener("transitionrun", (e) => {
        const el = e.target as HTMLElement
        if (!el.classList?.contains("pbar-pop")) return
        if ((e as TransitionEvent).propertyName !== "opacity") return
        if (w.__popExit) return // only the first opacity transition after install (the exit)
        const anim = el.getAnimations().find(
          (a) => (a as CSSTransition).transitionProperty === "opacity"
        )
        if (!anim) return
        anim.pause()
        anim.currentTime = 10 // freeze mid-exit at a deterministic frame
        const cs = getComputedStyle(el)
        w.__popExit = { opacity: parseFloat(cs.opacity), duration: cs.transitionDuration }
      })
    })
    await freezePageClock(page)
    await page.keyboard.press("Escape")
    await page.clock.runFor(50) // close handler runs; class flip schedules the exit
    await expect(page.locator(".pbar-pop-out")).toBeAttached()
    await expect.poll(() => page.evaluate(() => (window as any).__popExit)).not.toBeNull()

    /* Frozen 10ms into the exit: the popover must still be mostly opaque —
     * the leave is a mirrored 150ms beat, not a cut. */
    const mid = await page.evaluate(() => (window as any).__popExit)
    expect(mid.duration).toBe("0.15s")
    expect(mid.opacity).toBeGreaterThan(0.5)

    /* End pose: fully faded and shifted down 6px — the mirror of the
     * @starting-style enter. Fast-forward EVERY transition on the element
     * (opacity was frozen by the trap; transform runs on real time and may
     * still be early under load). */
    await page.evaluate(() => {
      const el = document.querySelector(".pbar-pop-out")
      el?.getAnimations().forEach((a) => {
        a.currentTime = 150
      })
      const cs = getComputedStyle(el!)
      return { opacity: cs.opacity, transform: cs.transform }
    }).then((end) => {
      expect(parseFloat(end.opacity)).toBe(0)
      // translateY(6px) is the ty component of the matrix.
      const m = /matrix\([^,]+,[^,]+,[^,]+,[^,]+,[^,]+, ([^)]+)\)/.exec(end.transform)
      expect(m).not.toBeNull()
      expect(parseFloat(m![1])).toBeCloseTo(6, 0)
    })

    await page.clock.runFor(200) // let the frozen unmount timer fire
    await expect(pop).toHaveCount(0)
  })

  test("PLAY LIMIT popover posts the preset and the mode; the subtitle reports the countdown", async ({
    page,
  }) => {
    const summaryRef = { value: playingSummary() }
    await mockAllEndpoints(page, summaryRef)

    const posted: Array<{ minutes: number; once: boolean }> = []
    await page.route("**/api/player/play-limit", (r) => {
      const body = r.request().postDataJSON() as { minutes: number; once: boolean }
      posted.push(body)
      const deadline = Date.now() + body.minutes * 60_000
      const next = playingSummary()
      next.status.play_limit = { minutes: body.minutes, deadline, once: body.once }
      summaryRef.value = next
      return r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ minutes: body.minutes, deadline, once: body.once }),
      })
    })

    await page.goto("/browse")
    await page.getByRole("button", { name: "Play limit" }).click()
    const pop = page.locator(".pbar-pop").filter({ hasText: "PLAY LIMIT" })
    await expect(pop).toBeVisible()
    // Two right-aligned lines, not one long strip off the dock's left edge.
    const box = await pop.boundingBox()
    expect(box!.width).toBeLessThan(320)
    await expect(pop.getByRole("button", { name: "OFF" })).toHaveClass(/is-on/)
    await expect(pop.getByRole("button", { name: "ALWAYS" })).toHaveClass(/is-on/)

    await pop.getByRole("button", { name: "30M" }).click()
    await expect.poll(() => posted.length).toBe(1)
    expect(posted[0]).toEqual({ minutes: 30, once: false })
    // Selection commits and closes the popover (after its mirrored exit).
    await expect(pop).toHaveCount(0)
    await expect(page.locator(".pbar-sub")).toContainText("limit 30m")

    // The mode is the other half of the same value: flipping it commits against
    // the current minutes and leaves the popover open, like the display modes.
    await page.getByRole("button", { name: "Play limit" }).click()
    const pop2 = page.locator(".pbar-pop").filter({ hasText: "PLAY LIMIT" })
    await expect(pop2).toBeVisible()
    await pop2.getByRole("button", { name: "ONCE" }).click()
    await expect.poll(() => posted.length).toBe(2)
    expect(posted[1]).toEqual({ minutes: 30, once: true })
    await expect(pop2.getByRole("button", { name: "ONCE" })).toHaveClass(/is-on/)
  })

  test("display power is a direct toggle against the API", async ({ page }) => {
    const summaryRef = { value: playingSummary() }
    summaryRef.value.status.display = {
      configured: true,
      state: "on",
      source: "probed",
      error_kind: null,
    }
    await mockAllEndpoints(page, summaryRef)

    let offPosted = false
    await page.route("**/api/display/off", (r) => {
      offPosted = true
      const next = playingSummary()
      next.status.display = { configured: true, state: "off", source: "probed", error_kind: null }
      summaryRef.value = next
      return r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, state: "off" }),
      })
    })

    await page.goto("/browse")
    await page.getByRole("button", { name: "Turn display off" }).click()
    await expect.poll(() => offPosted).toBe(true)
    await expect(page.getByRole("button", { name: "Turn display on" })).toBeVisible()
  })

  test("dock tucks on downward scroll, recalls on upward, and drops an open popover", async ({
    page,
  }) => {
    // Reduced motion keeps lenis off (spec §5 F5), so the scroller moves
    // natively and the direction test is deterministic.
    await page.emulateMedia({ reducedMotion: "reduce" })
    await mockAllEndpoints(page, { value: playingSummary() })
    await page.goto("/browse")

    const dock = page.locator(".pbar")
    await expect(dock.locator(".pbar-title")).toHaveText("Neon City")

    await page.getByRole("button", { name: "Display mode", exact: true }).click()
    await expect(page.locator(".pbar-pop")).toHaveCount(1)

    // Give .main something to scroll, then scroll down: the dock tucks and
    // the popover state is explicitly nulled — no ghost popover (F2).
    await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>(".main")
      if (!main) throw new Error(".main not found")
      const spacer = document.createElement("div")
      spacer.style.height = "3000px"
      main.appendChild(spacer)
      main.scrollTop = 600
    })
    await expect(dock).toHaveClass(/pbar-tucked/)
    await expect(page.locator(".pbar-pop")).toHaveCount(0)

    await page.evaluate(() => {
      document.querySelector<HTMLElement>(".main")!.scrollTop = 0
    })
    await expect(dock).not.toHaveClass(/pbar-tucked/)
  })
})
