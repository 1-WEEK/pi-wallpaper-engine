import { describe, expect, test } from "bun:test"
import type { LibraryItem } from "@pwe/shared"
import { formatPlayLimitCountdown, spaceSavedPercent } from "./format.js"

describe("formatPlayLimitCountdown", () => {
  test("drops the hour field below an hour", () => {
    expect(formatPlayLimitCountdown(0)).toBe("0:00")
    expect(formatPlayLimitCountdown(59)).toBe("0:59")
    expect(formatPlayLimitCountdown(600)).toBe("10:00")
    expect(formatPlayLimitCountdown(3599)).toBe("59:59")
  })

  test("adds an hour field and zero-pads the minutes past an hour", () => {
    expect(formatPlayLimitCountdown(3600)).toBe("1:00:00")
    expect(formatPlayLimitCountdown(3725)).toBe("1:02:05")
    expect(formatPlayLimitCountdown(7200)).toBe("2:00:00")
  })

  test("clamps negative to 0:00", () => {
    expect(formatPlayLimitCountdown(-1)).toBe("0:00")
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
