import { describe, expect, test } from "bun:test"
import { shouldConvergeToIdle, shouldReassertFullscreen } from "./Mpv.js"

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

// A wallpaper's file can stop without this backend asking: the share holding it
// went away, the file was deleted, a decode failed. mpv reports that as
// `end-file`, and the player has to converge to idle instead of reporting a
// wallpaper that is not on screen any more.
describe("shouldConvergeToIdle", () => {
  test("true for the reasons that mean the file stopped on its own", () => {
    expect(shouldConvergeToIdle({ event: "end-file", reason: "eof" })).toBe(true)
    expect(shouldConvergeToIdle({ event: "end-file", reason: "error" })).toBe(true)
    expect(shouldConvergeToIdle({ event: "end-file", reason: "unknown" })).toBe(true)
  })

  test("false for the reasons this backend caused", () => {
    // `stop` and `quit` are ours; `stop()` already converged the status ref and
    // treating them as a lost file would re-enter the recovery path on every
    // ordinary stop.
    expect(shouldConvergeToIdle({ event: "end-file", reason: "stop" })).toBe(false)
    expect(shouldConvergeToIdle({ event: "end-file", reason: "quit" })).toBe(false)
  })

  test("true for an end with no reason field", () => {
    // mpv versions have shipped `end-file` without `reason`; an unknown end is
    // still an end, and the consumer probes the media root before acting.
    expect(shouldConvergeToIdle({ event: "end-file" })).toBe(true)
    expect(shouldConvergeToIdle({ event: "end-file", reason: "redirect" })).toBe(true)
  })

  test("false for other events, command replies and non-objects", () => {
    expect(shouldConvergeToIdle({ event: "idle" })).toBe(false)
    expect(shouldConvergeToIdle({ error: "success", request_id: 3 })).toBe(false)
    expect(shouldConvergeToIdle({ event: "property-change", name: "fullscreen", data: false })).toBe(
      false
    )
    expect(shouldConvergeToIdle(null)).toBe(false)
    expect(shouldConvergeToIdle("end-file")).toBe(false)
  })
})
