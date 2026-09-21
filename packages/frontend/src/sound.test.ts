import { describe, expect, test } from "bun:test"
import { SOUND_FAMILIES, SOUND_TRIGGERS, sounds } from "./sound.js"

// Matrix invariants from the ticket-15 sound spec (§2–§4). The engine's
// runtime behavior (cooldown, reentry, hidden-tab drops) is covered by the
// Playwright spec; here we pin the declarative table itself so a careless
// edit can't drift from the locked spec.

describe("interface sound matrix (ticket 13, sound spec §3)", () => {
  test("exactly the nine sounding rows, on their locked families", () => {
    expect(Object.keys(SOUND_TRIGGERS).sort()).toEqual(
      ["armed", "dismiss", "display", "done", "download", "fail", "nav", "select", "transport"].sort()
    )
    expect(SOUND_TRIGGERS.nav.family).toBe("nav")
    expect(SOUND_TRIGGERS.select.family).toBe("nav")
    expect(SOUND_TRIGGERS.dismiss.family).toBe("nav")
    expect(SOUND_TRIGGERS.transport.family).toBe("commit")
    expect(SOUND_TRIGGERS.download.family).toBe("commit")
    expect(SOUND_TRIGGERS.done.family).toBe("transition")
    expect(SOUND_TRIGGERS.display.family).toBe("transition")
    expect(SOUND_TRIGGERS.fail.family).toBe("warn")
    expect(SOUND_TRIGGERS.armed.family).toBe("warn")
  })

  test("cooldowns and reentry policies match the locked matrix", () => {
    const expected: Record<string, [number, "overlap" | "restart" | "block"]> = {
      nav: [50, "overlap"],
      select: [50, "overlap"],
      dismiss: [60, "overlap"],
      transport: [80, "restart"],
      download: [100, "restart"],
      done: [500, "block"],
      display: [200, "restart"],
      fail: [800, "block"],
      armed: [300, "restart"],
    }
    for (const [id, [cooldownMs, reentry]] of Object.entries(expected)) {
      expect(SOUND_TRIGGERS[id as keyof typeof SOUND_TRIGGERS].cooldownMs).toBe(cooldownMs)
      expect(SOUND_TRIGGERS[id as keyof typeof SOUND_TRIGGERS].reentry).toBe(reentry)
    }
  })

  test("in-family variants derive from pitch and gain only", () => {
    expect(SOUND_TRIGGERS.select.pitch).toBe(1.5)
    expect(SOUND_TRIGGERS.dismiss.pitch).toBe(0.7)
    expect(SOUND_TRIGGERS.dismiss.gain).toBe(0.8)
    expect(SOUND_TRIGGERS.display.gain).toBe(0.7)
    expect(SOUND_TRIGGERS.armed.pitch).toBe(0.85)
    expect(SOUND_TRIGGERS.armed.gain).toBe(0.55)
    expect(SOUND_TRIGGERS.transport.pitch).toBeUndefined()
    expect(SOUND_TRIGGERS.download.pitch).toBeUndefined()
    expect(SOUND_TRIGGERS.fail.pitch).toBeUndefined()
  })

  test("direction B patch: soft attacks, layer gain ≤ 0.34, locked durations", () => {
    expect(SOUND_FAMILIES.nav.duration).toBe(0.11)
    expect(SOUND_FAMILIES.commit.duration).toBe(0.42)
    expect(SOUND_FAMILIES.transition.duration).toBe(0.34)
    expect(SOUND_FAMILIES.warn.duration).toBe(0.4)
    for (const family of Object.values(SOUND_FAMILIES)) {
      for (const layer of family.layers) {
        // BLOOM warmth comes from the attack time — 0ms hard attacks banned.
        expect(layer.attack).toBeGreaterThanOrEqual(0.002)
        expect(layer.gain).toBeLessThanOrEqual(0.34)
      }
    }
  })

  test("without a DOM the engine is inert and never throws", () => {
    expect(sounds.supported).toBe(false)
    expect(sounds.enabled).toBe(false)
    expect(() => sounds.trigger("nav")).not.toThrow()
    expect(() => sounds.trigger("done")).not.toThrow()
    expect(() => sounds.toggleMuted()).not.toThrow()
  })
})
