import { describe, expect, test } from "bun:test"
import type { TranscodeJob } from "@pwe/shared"
import { buildFfmpegArgs, parseProgressLine, resolveJobPaths } from "./ffmpeg.js"

const job: TranscodeJob = {
  id: "J1",
  workshop_id: "abc",
  source_relative_path: "source/abc/wallpaper.mp4",
  output_relative_path: "optimized/abc.mp4",
  target_width: 1200,
  target_height: 1080,
  target_codec: "hevc",
  target_quality: 23,
}

describe("resolveJobPaths", () => {
  test("resolves source/partial/final under media root", () => {
    const paths = resolveJobPaths(job, "/data")
    expect(paths.sourceAbs).toBe("/data/source/abc/wallpaper.mp4")
    expect(paths.finalAbs).toBe("/data/optimized/abc.mp4")
    expect(paths.partialAbs).toBe("/data/optimized/abc.mp4.partial")
    expect(paths.outputDir).toBe("/data/optimized")
  })
})

describe("buildFfmpegArgs", () => {
  const paths = resolveJobPaths(job, "/data")

  test("QSV path uses hevc_qsv + scale_qsv + global_quality", () => {
    const args = buildFfmpegArgs(job, paths, "qsv")
    expect(args).toContain("-c:v")
    expect(args).toContain("hevc_qsv")
    const vfIndex = args.indexOf("-vf")
    expect(vfIndex).toBeGreaterThan(-1)
    expect(args[vfIndex + 1]).toBe("scale_qsv=w=1200:h=1080:mode=hq")
    expect(args).toContain("-global_quality")
    expect(args[args.indexOf("-global_quality") + 1]).toBe("23")
    // Writes to .partial, not final.
    expect(args[args.length - 1]).toBe(paths.partialAbs)
  })

  test("libx265 fallback uses scale + crop + crf with -preset medium", () => {
    const args = buildFfmpegArgs(job, paths, "x265")
    expect(args).toContain("libx265")
    const vfIndex = args.indexOf("-vf")
    expect(args[vfIndex + 1]).toBe(
      "scale=1200:1080:force_original_aspect_ratio=increase,crop=1200:1080"
    )
    expect(args).toContain("-crf")
    expect(args[args.indexOf("-crf") + 1]).toBe("23")
    expect(args).toContain("-preset")
  })

  test("libx264 path is used when target_codec is h264", () => {
    const h264Job: TranscodeJob = { ...job, target_codec: "h264" }
    const args = buildFfmpegArgs(h264Job, paths, "x265")
    expect(args).toContain("libx264")
    expect(args).not.toContain("libx265")
  })

  test("audio is dropped via -an", () => {
    const args = buildFfmpegArgs(job, paths, "qsv")
    expect(args).toContain("-an")
  })
})

describe("parseProgressLine", () => {
  test("emits a higher percent when out_time_ms advances", () => {
    // duration = 60s = 60000ms. ffmpeg reports microseconds.
    const pct = parseProgressLine("out_time_ms=30000000", 60_000, 10)
    expect(pct).toBe(50)
  })

  test("returns null when the percent has not advanced", () => {
    const pct = parseProgressLine("out_time_ms=30000000", 60_000, 50)
    expect(pct).toBeNull()
  })

  test("returns null for unrelated lines", () => {
    expect(parseProgressLine("frame=1024", 60_000, 0)).toBeNull()
    expect(parseProgressLine("", 60_000, 0)).toBeNull()
    expect(parseProgressLine("progress=continue", 60_000, 0)).toBeNull()
  })

  test("returns null when duration is unknown (=0)", () => {
    expect(parseProgressLine("out_time_ms=30000000", 0, 0)).toBeNull()
  })

  test("caps at 99% to leave headroom for completion event", () => {
    const pct = parseProgressLine("out_time_ms=99999999999", 60_000, 0)
    expect(pct).toBe(99)
  })
})
