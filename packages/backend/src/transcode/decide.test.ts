import { describe, expect, test } from "bun:test"
import { decideTranscode } from "./decide.js"

const screen = { width: 1200, height: 1080 }

const probe = (over: Partial<{ width: number; height: number; codec: string }>) => ({
  width: 1920,
  height: 1080,
  codec: "h264",
  duration_seconds: 30,
  size_bytes: 100_000_000,
  ...over,
})

describe("decideTranscode", () => {
  test("1080p H.264 16:9 → skip (aspect mismatch but supported codec, let mpv scale)", () => {
    const d = decideTranscode(probe({ width: 1920, height: 1080, codec: "h264" }), screen)
    expect(d.kind).toBe("transcode")
    if (d.kind === "transcode") expect(d.target_width).toBe(1200)
  })

  test("1080p H.265 16:9 → transcode (aspect mismatch)", () => {
    const d = decideTranscode(probe({ width: 1920, height: 1080, codec: "hevc" }), screen)
    expect(d.kind).toBe("transcode")
    if (d.kind === "transcode") expect(d.target_codec).toBe("hevc")
  })

  test("Already 1200x1080 H.264 → skip", () => {
    const d = decideTranscode(probe({ width: 1200, height: 1080, codec: "h264" }), screen)
    expect(d.kind).toBe("skip")
  })

  test("4K H.264 → transcode to screen native HEVC", () => {
    const d = decideTranscode(probe({ width: 3840, height: 2160, codec: "h264" }), screen)
    expect(d.kind).toBe("transcode")
    if (d.kind === "transcode") {
      expect(d.target_width).toBe(1200)
      expect(d.target_height).toBe(1080)
      expect(d.target_codec).toBe("hevc")
    }
  })

  test("Vertical content (1080x1920) → skip (let mpv fit)", () => {
    const d = decideTranscode(probe({ width: 1080, height: 1920, codec: "h264" }), screen)
    expect(d.kind).toBe("skip")
  })

  test("Unsupported codec (av1) at native res → transcode", () => {
    const d = decideTranscode(probe({ width: 1200, height: 1080, codec: "av1" }), screen)
    expect(d.kind).toBe("transcode")
  })

  test("Matching screen aspect (1200x1080 from 1200x1080) → skip", () => {
    const d = decideTranscode(probe({ width: 1200, height: 1080, codec: "hevc" }), screen)
    expect(d.kind).toBe("skip")
  })
})
