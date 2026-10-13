import { describe, expect, test } from "bun:test"
import { shouldReassertFullscreen } from "./Mpv.js"

// The compositor can strip fullscreen at runtime (observed on labwc after a
// display power cycle: mpv keeps running windowed with a titlebar). The
// backend observes the fullscreen property and must re-assert it whenever
// mpv reports it flipped to false — and only then.
describe("shouldReassertFullscreen", () => {
  test("true for a property-change event reporting fullscreen=false", () => {
    expect(
      shouldReassertFullscreen({ event: "property-change", id: 1, name: "fullscreen", data: false })
    ).toBe(true)
  })

  test("false when fullscreen is (re)gained", () => {
    expect(
      shouldReassertFullscreen({ event: "property-change", id: 1, name: "fullscreen", data: true })
    ).toBe(false)
  })

  test("false for property-change events on other properties", () => {
    expect(
      shouldReassertFullscreen({ event: "property-change", id: 2, name: "pause", data: false })
    ).toBe(false)
  })

  test("false for command replies and other events", () => {
    expect(shouldReassertFullscreen({ error: "success", request_id: 3, data: null })).toBe(false)
    expect(shouldReassertFullscreen({ event: "idle" })).toBe(false)
    expect(shouldReassertFullscreen(null)).toBe(false)
    expect(shouldReassertFullscreen("property-change")).toBe(false)
  })
})
