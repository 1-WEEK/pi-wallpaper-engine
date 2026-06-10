import { describe, expect, test } from "bun:test"
import type { LibraryItem } from "@pwe/shared"
import { formatSleepCountdown, spaceSavedPercent } from "./format.js"

describe("formatSleepCountdown", () => {
  test("formats milliseconds as mm:ss", () => {
    expect(formatSleepCountdown(272_000)).toBe("4:32")
    expect(formatSleepCountdown(65_000)).toBe("1:05")
  })

  test("clamps zero and negative to 0:00", () => {
    expect(formatSleepCountdown(0)).toBe("0:00")
    expect(formatSleepCountdown(-5_000)).toBe("0:00")
  })
})

describe("spaceSavedPercent", () => {
  const row = (over: Partial<LibraryItem>): LibraryItem =>
    ({
      transcode_status: "completed",
      source_size: 1000,
      transcoded_size: 600,
      ...over,
    }) as unknown as LibraryItem

  test("computes percent saved versus source", () => {
    expect(spaceSavedPercent(row({}))).toBe(40)
  })

  test("returns null when transcode is not completed", () => {
    expect(spaceSavedPercent(row({ transcode_status: "skipped" }))).toBeNull()
  })

  test("returns null when optimized is not smaller than source", () => {
    expect(spaceSavedPercent(row({ transcoded_size: 1200 }))).toBeNull()
    expect(spaceSavedPercent(row({ transcoded_size: 0 }))).toBeNull()
  })
})
