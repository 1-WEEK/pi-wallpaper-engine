import { describe, expect, test } from "bun:test"
import type { TranscodeJob } from "@pwe/shared"
import { buildFfmpegArgs, buildJobPaths, parseProgressLine } from "./ffmpeg.js"

const job: TranscodeJob = {
  id: "J1",
  workshop_id: "abc",
  source_url: "/api/transcode/J1/source",
  artifact_url: "/api/transcode/J1/artifact",
  target_width: 1200,
  target_height: 1080,
  target_codec: "hevc",
  target_quality: 23,
}

describe("buildJobPaths", () => {
  test("builds source/partial/final paths for local worker files", () => {
    const paths = buildJobPaths("/tmp/pwe/J1/source", "/tmp/pwe/J1/output.mp4")
    expect(paths.sourceAbs).toBe("/tmp/pwe/J1/source")
    expect(paths.finalAbs).toBe("/tmp/pwe/J1/output.mp4")
    expect(paths.partialAbs).toBe("/tmp/pwe/J1/output.mp4.partial")
    expect(paths.outputDir).toBe("/tmp/pwe/J1")
  })
})

describe("buildFfmpegArgs", () => {
  const paths = buildJobPaths("/tmp/pwe/J1/source", "/tmp/pwe/J1/output.mp4")

  test("QSV path uses hevc_qsv + scale_qsv + global_quality with hardware device init", () => {
    const args = buildFfmpegArgs(job, paths, "qsv")
    expect(args).toContain("-init_hw_device")
    expect(args).toContain("-filter_hw_device")
    expect(args).toContain("-c:v")
    expect(args).toContain("hevc_qsv")
    const vfIndex = args.indexOf("-vf")
    expect(vfIndex).toBeGreaterThan(-1)
    expect(args[vfIndex + 1]).toBe(
      "hwupload=extra_hw_frames=64,format=qsv,scale_qsv=w=1200:h=1080:mode=hq"
    )
    expect(args).toContain("-global_quality")
    expect(args[args.indexOf("-global_quality") + 1]).toBe("23")
    // Writes to .partial, not final.
    expect(args[args.length - 1]).toBe(paths.partialAbs)
  })
  test("VA-API path uses hevc_vaapi + scale_vaapi + qp with hardware device init", () => {
    const args = buildFfmpegArgs(job, paths, "vaapi")
    expect(args).toContain("-init_hw_device")
    expect(args).toContain("-filter_hw_device")
    expect(args).toContain("-c:v")
    expect(args).toContain("hevc_vaapi")
    const vfIndex = args.indexOf("-vf")
    expect(vfIndex).toBeGreaterThan(-1)
    expect(args[vfIndex + 1]).toBe(
      "format=nv12,hwupload,scale_vaapi=w=1200:h=1080:mode=hq"
    )
    expect(args).toContain("-qp")
    expect(args[args.indexOf("-qp") + 1]).toBe("23")
    expect(args[args.length - 1]).toBe(paths.partialAbs)
  })

  test("VA-API path uses h264_vaapi when target_codec is h264", () => {
    const h264Job: TranscodeJob = { ...job, target_codec: "h264" }
    const args = buildFfmpegArgs(h264Job, paths, "vaapi")
    expect(args).toContain("h264_vaapi")
    expect(args).not.toContain("hevc_vaapi")
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

  test("declares the MP4 muxer when writing to a .partial path", () => {
    const args = buildFfmpegArgs(job, paths, "x265")
    const formatIndex = args.indexOf("-f")
    expect(formatIndex).toBeGreaterThan(-1)
    expect(args[formatIndex + 1]).toBe("mp4")
    expect(args[args.length - 1]).toBe(paths.partialAbs)
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
