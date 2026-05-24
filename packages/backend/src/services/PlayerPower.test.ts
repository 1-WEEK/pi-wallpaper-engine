import { describe, expect, test } from "bun:test"
import { shouldAutoRestoreOnStartup } from "./PlayerPower.js"

describe("shouldAutoRestoreOnStartup", () => {
  test("requires a probed display-on state", () => {
    expect(shouldAutoRestoreOnStartup({ state: "on", source: "probed" })).toBe(true)
  })

  test("does not restore from cached or unknown display state", () => {
    expect(shouldAutoRestoreOnStartup({ state: "on", source: "cached" })).toBe(false)
    expect(shouldAutoRestoreOnStartup({ state: "unknown", source: "default" })).toBe(false)
    expect(shouldAutoRestoreOnStartup({ state: "off", source: "probed" })).toBe(false)
  })
})
