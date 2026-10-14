import { test, expect } from "playwright/test"
import { mockLibraryItem, mockSystemSummary } from "./fixtures.js"
import { mockAuthDisabled, mockLibraryList, mockSummary } from "./helpers.js"

interface TestWindow extends Window {
  __soundLog?: string[]
  __pwe_sounds?: {
    trigger: (id: string) => void
    isMuted: boolean
  }
}

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: async ({ browserName }, use) => use(browserName === "chromium"),
})

test.describe("Mobile interface sounds (ticket 07)", () => {
  test("master switch default OFF; persists per device in localStorage", async ({ page }) => {
    await mockAuthDisabled(page)
    await mockSummary(page)
    await page.goto("/settings?sec=playback")

    // Default OFF in localStorage
    const stored = await page.evaluate(() => localStorage.getItem("pwe-interface-sounds"))
    expect(stored).toBeNull()

    // Radio shows OFF
    const soundsGroup = page.getByRole("radiogroup", { name: "Interface sounds" })
    await expect(soundsGroup.getByRole("radio", { name: "OFF" })).toHaveAttribute("aria-checked", "true")

    // Turn ON
    await soundsGroup.getByRole("radio", { name: "ON" }).click()
    expect(await page.evaluate(() => localStorage.getItem("pwe-interface-sounds"))).toBe("1")

    // Turn OFF
    await soundsGroup.getByRole("radio", { name: "OFF" }).click()
    expect(await page.evaluate(() => localStorage.getItem("pwe-interface-sounds"))).toBe("0")
  })

  test("sound triggers wire correctly on mobile when enabled", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("pwe-interface-sounds", "1")
    })
    await mockAuthDisabled(page)
    const summary = mockSystemSummary()
    summary.status.display.configured = true
    summary.status.display.state = "on"
    summary.status.player.current_workshop_id = "1693728660"
    summary.status.player.playing = true
    await mockSummary(page, summary)
    await mockLibraryList(page, [
      mockLibraryItem({ workshop_id: "1693728660", title: "Neon City" }),
    ])
    await page.route("**/api/player/**", (route) => route.fulfill({ json: { ok: true } }))
    await page.route("**/api/download/tasks**", (route) => route.fulfill({ json: { items: [], total: 0 } }))

    await page.goto("/library")

    // Instrument sounds.trigger to track invocations
    await page.evaluate(() => {
      const win = window as TestWindow
      win.__soundLog = []
      const engine = win.__pwe_sounds
      if (engine) {
        const origTrig = engine.trigger.bind(engine)
        engine.trigger = (id: string) => {
          win.__soundLog?.push(id)
          origTrig(id)
        }
      }
    })

    // 1. TabBar switch: tap Browse tab
    const browseTab = page.locator('.mobile-tab-bar-item[data-nav="browse"]')
    await browseTab.tap()
    await expect(page).toHaveURL(/\/browse/)

    // 2. MiniPlayer transport: tap Pause
    const pauseBtn = page.getByRole("button", { name: "Pause" })
    await pauseBtn.tap()

    // 3. MiniPlayer display power toggle
    const displayBtn = page.getByRole("button", { name: /Turn display/ })
    await displayBtn.tap()

    // 4. Open and close MobileSheet: tap Open player controls then Close
    await page.getByRole("button", { name: "Open player controls" }).tap()
    const sheet = page.locator(".mobile-sheet.open")
    await expect(sheet).toBeVisible()
    await sheet.getByRole("button", { name: "Close", exact: true }).tap()
    await expect(sheet).toHaveCount(0)

    // Check trigger occurrences
    const logs = await page.evaluate(() => {
      const win = window as TestWindow
      return win.__soundLog ?? []
    })
    expect(logs).toContain("nav")
    expect(logs).toContain("transport")
    expect(logs).toContain("display")
    expect(logs).toContain("dismiss")
  })

  test("mute row cancels in-flight voices and silences sounds", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("pwe-interface-sounds", "1")
    })
    await mockAuthDisabled(page)
    await mockSummary(page)
    await page.goto("/settings?sec=playback")

    // Mute row appears when master switch is ON
    const muteGroup = page.getByRole("radiogroup", { name: "Mute interface sounds" })
    await expect(muteGroup).toBeVisible()

    // Click MUTED
    await muteGroup.getByRole("radio", { name: "MUTED" }).click()
    expect(await page.evaluate(() => localStorage.getItem("pwe-interface-sounds-muted"))).toBe("1")

    // Check sound engine reports muted
    const isMuted = await page.evaluate(() => {
      const win = window as TestWindow
      return Boolean(win.__pwe_sounds?.isMuted)
    })
    expect(isMuted).toBe(true)

    // Click LIVE
    await muteGroup.getByRole("radio", { name: "LIVE" }).click()
    expect(await page.evaluate(() => localStorage.getItem("pwe-interface-sounds-muted"))).toBe("0")
  })

  test("SILENT actions produce zero sound calls", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("pwe-interface-sounds", "1")
    })
    await mockAuthDisabled(page)
    await mockSummary(page)
    await page.goto("/settings?sec=playback")

    await page.evaluate(() => {
      const win = window as TestWindow
      win.__soundLog = []
      const engine = win.__pwe_sounds
      if (engine) {
        engine.trigger = (id: string) => {
          win.__soundLog?.push(id)
        }
      }
    })

    // Theme toggle and Reduce transparency are explicitly in the SILENT list (spec §5.2 line 255)
    const theme = page.getByRole("radiogroup", { name: "Theme" })
    await theme.getByRole("radio", { name: "B", exact: true }).click()

    const rt = page.getByRole("radiogroup", { name: "Reduce transparency" })
    await rt.getByRole("radio", { name: "ON" }).click()

    const logs = await page.evaluate(() => {
      const win = window as TestWindow
      return win.__soundLog ?? []
    })
    expect(logs.length).toBe(0)
  })
})
