import { describe, expect, test } from "bun:test"
import { normalizeThemeChoice, resolveThemeChoice } from "./theme.js"

describe("normalizeThemeChoice", () => {
  test("accepts explicit light/dark", () => {
    expect(normalizeThemeChoice("light")).toBe("light")
    expect(normalizeThemeChoice("dark")).toBe("dark")
  })

  test("anything else falls back to auto", () => {
    expect(normalizeThemeChoice("auto")).toBe("auto")
    expect(normalizeThemeChoice(null)).toBe("auto")
    expect(normalizeThemeChoice("sepia")).toBe("auto")
    expect(normalizeThemeChoice("")).toBe("auto")
  })
})

describe("resolveThemeChoice", () => {
  test("auto follows the system theme", () => {
    expect(resolveThemeChoice("auto", "light")).toBe("light")
    expect(resolveThemeChoice("auto", "dark")).toBe("dark")
  })

  test("manual choice overrides the system theme", () => {
    expect(resolveThemeChoice("light", "dark")).toBe("light")
    expect(resolveThemeChoice("dark", "light")).toBe("dark")
  })
})
