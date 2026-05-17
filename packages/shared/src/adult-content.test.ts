import { describe, expect, test } from "bun:test"
import { hasAdultMetadata, hasAdultTitleHint, isAdultContent } from "./adultContent.js"

describe("adult content helpers", () => {
  test("detects title hints", () => {
    expect(hasAdultTitleHint("Ahegao wallpaper")).toBe(true)
    expect(hasAdultTitleHint("Lofi Girl")).toBe(false)
  })

  test("detects adult metadata", () => {
    expect(hasAdultMetadata("Mature", null)).toBe(true)
    expect(hasAdultMetadata(null, "mild")).toBe(true)
    expect(hasAdultMetadata("Everyone", "none")).toBe(false)
  })

  test("combines metadata and temporary hints", () => {
    expect(isAdultContent({ title: "Ahegao loop" })).toBe(true)
    expect(isAdultContent({ title: "Plain title", adultHint: 1 })).toBe(true)
    expect(isAdultContent({ title: "Plain title", contentRating: "Mature" })).toBe(true)
    expect(isAdultContent({ title: "Plain title", contentRating: "Everyone", ratingSex: "none" })).toBe(
      false
    )
  })
})
