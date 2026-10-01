import { spawn } from "node:child_process"
import { mkdir, rename, stat, unlink } from "node:fs/promises"
import { dirname } from "node:path"
import type { TranscodeJob } from "@pwe/shared"

/**
 * ffmpeg wrapper. One job at a time. Detects hardware QSV at runtime
 * (encoder support + actual device probe) with a libx265 software fallback.
 *
 * Pure command-builder helpers (`buildFfmpegArgs`, `parseProgressLine`) are
 * exported so the wrapper can be unit-tested without actually spawning ffmpeg.
 */

const FFMPEG = process.env["FFMPEG_BIN"] ?? "ffmpeg"

export type EncoderKind = "qsv" | "vaapi" | "x265"

export interface EncoderChoice {
  readonly kind: EncoderKind
  readonly reason: string
}

export interface JobPaths {
  readonly sourceAbs: string
  readonly partialAbs: string
  readonly finalAbs: string
  readonly outputDir: string
}

export const buildJobPaths = (sourcePath: string, outputPath: string): JobPaths => {
  return {
    sourceAbs: sourcePath,
    partialAbs: `${outputPath}.partial`,
    finalAbs: outputPath,
    outputDir: dirname(outputPath),
  }
}

const runOnce = (
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number } = {}
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let killed = false

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          killed = true
          child.kill("SIGKILL")
        }, opts.timeoutMs)
      : null

    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString()
    })
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString()
    })
    child.on("error", (err) => {
      if (timer) clearTimeout(timer)
      resolvePromise({ code: -1, stdout, stderr: `${stderr}\n${err.message}` })
    })
    child.on("close", (code) => {
      if (timer) clearTimeout(timer)
      resolvePromise({
        code: killed ? -2 : (code ?? -1),
        stdout,
        stderr,
      })
    })
  })

/**
 * Two-step QSV detection:
 *   1. Encoder presence in ffmpeg -encoders output.
 *   2. One-frame nullsrc probe to confirm /dev/dri/renderD128 is accessible.
 *
 * Both must pass — encoder list alone does not mean the device file is mapped
 * into the container.
 */
export const detectEncoder = async (
  ffmpeg: string = FFMPEG
): Promise<EncoderChoice> => {
  const list = await runOnce(ffmpeg, ["-hide_banner", "-encoders"], { timeoutMs: 5_000 })

  // 1. Try Intel QSV (oneVPL / Gen12+)
  if (list.code === 0 && list.stdout.includes("hevc_qsv")) {
    const qsvProbe = await runOnce(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-init_hw_device",
        "qsv=hw",
        "-filter_hw_device",
        "hw",
        "-f",
        "lavfi",
        "-i",
        "nullsrc=s=256x256:d=0.04",
        "-vf",
        "format=nv12,hwupload=extra_hw_frames=64,format=qsv",
        "-c:v",
        "hevc_qsv",
        "-f",
        "null",
        "-",
      ],
      { timeoutMs: 8_000 }
    )
    if (qsvProbe.code === 0) {
      return { kind: "qsv", reason: "hevc_qsv device probe succeeded" }
    }
  }

  // 2. Try Intel / AMD VA-API (Gen8-Gen11 Intel Jasper Lake / UHD Graphics / AMD)
  if (list.code === 0 && list.stdout.includes("hevc_vaapi")) {
    const vaapiProbe = await runOnce(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-init_hw_device",
        "vaapi=va:/dev/dri/renderD128",
        "-filter_hw_device",
        "va",
        "-f",
        "lavfi",
        "-i",
        "nullsrc=s=256x256:d=0.04",
        "-vf",
        "format=nv12,hwupload",
        "-c:v",
        "hevc_vaapi",
        "-f",
        "null",
        "-",
      ],
      { timeoutMs: 8_000 }
    )
    if (vaapiProbe.code === 0) {
      return { kind: "vaapi", reason: "hevc_vaapi device probe succeeded" }
    }
  }

  return {
    kind: "x265",
    reason: "hardware encoder (qsv / vaapi) unavailable or /dev/dri not accessible",
  }
}
/**
 * Rate control for the two hardware encoders, which used to run at constant
 * quality with no ceiling (`-global_quality` / `-qp`). On grainy, high-motion
 * wallpapers that emitted 25 Mbps out of a 12 Mbps source — an artifact bigger
 * than the file it was made from — under a declared HEVC level 4.0, whose Main
 * tier allows 12 Mbps.
 *
 * The first attempt used QVBR, the one mode that keeps a quality target *and*
 * enforces bitrate + maxrate + VBV. The deployed driver rejected it outright:
 *
 *   Driver does not support QVBR RC mode (supported modes: CQP, CBR, VBR).
 *
 * So on this hardware only CQP, CBR and VBR exist, and the tradeoff has to be
 * made inside that set. Measured on the real driver, 30 s of each of two
 * sources, 1200x1080:
 *
 *   mode                     grainy source   ordinary source
 *   CQP -qp 23 (previous)         25.45 Mbps       1.80 Mbps
 *   VBR 4M/6M                      3.96 Mbps       3.83 Mbps
 *   VBR 8M/12M                     7.89 Mbps       7.07 Mbps
 *   CBR 6M/6M                      5.98 Mbps       5.30 Mbps
 *
 * No setting in that set both leaves ordinary content alone and bounds the
 * expensive content: CQP is the only mode that preserves the 1.8 Mbps case and
 * it is the one with no ceiling. So this picks the ceiling and pays for it —
 * ordinary content rises to roughly the target, and the grainy outlier drops by
 * 6.4x, which is what stops a 448 MB source producing an 838 MB artifact.
 *
 * `-global_quality` is gone from both paths on purpose. It cannot coexist with
 * a ceiling here: without an explicit rc mode the VA-API wrapper silently falls
 * back to CQP and *discards* -b:v/-maxrate/-bufsize ("Buffering settings are
 * ignored in CQP RC mode"), leaving the encoder unbounded while looking
 * configured. That failure mode is silent, so the quality factor is not carried
 * on the hardware paths at all — bitrate now drives them, and
 * `job.target_quality` only reaches the libx265/libx264 path, where `-crf` is
 * still meaningful.
 *
 * The target is what the driver aims for; maxrate is the hard bound (6 Mbps ≈
 * 0.75 MB/s), and bufsize gives the VBV a 1 s window at that rate.
 */
const HW_BITRATE_TARGET = "4M"
const HW_BITRATE_MAX = "6M"
const HW_VBV_BUFFER = "6M"

/**
 * Declared hardware level, per encoder — the two take different scales:
 *   - hevc_qsv/h264_qsv take MFX level codes, where MFX_LEVEL_HEVC_5 /
 *     MFX_LEVEL_AVC_5 = 50.
 *   - hevc_vaapi/h264_vaapi take the codec's own level syntax, where the name
 *     "5" resolves to general_level_idc 150 (HEVC) / level_idc 50 (AVC).
 * Level 5.0 is the lowest level that holds for every frame rate in the library
 * at 1200x1080 — the range observed is 16–100 fps, and 4.1 caps the luma
 * sample rate at ~103 fps while 4.0 caps it at ~52 fps. Its 25 Mbps Main tier
 * bound sits far above the 6 Mbps ceiling above, so the declared level cannot
 * be contradicted by what this pipeline emits. Measured: every probe output
 * carried general_level_idc 150 regardless of rate-control mode, so the
 * declaration is independent of the mode chosen here.
 */
const QSV_LEVEL = "50"
const VAAPI_LEVEL = "5"

/**
 * Build the ffmpeg argv for a given encoder + job. Pure — no side effects.
 * Exported for unit testing.
 */
export const buildFfmpegArgs = (
  job: TranscodeJob,
  paths: JobPaths,
  encoder: EncoderKind
): string[] => {
  const common = [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    paths.sourceAbs,
    "-an", // wallpapers are silent on the Pi anyway
    "-progress",
    "pipe:1",
    // The temporary filename ends in `.partial`, so ffmpeg cannot infer the
    // output container from its extension. Keep the atomic rename workflow and
    // declare the muxer explicitly.
    "-f",
    "mp4",
  ]

  const w = job.target_width
  const h = job.target_height
  const q = job.target_quality

  // Crop-to-fill, matching the Pi's "fill" display mode: take the largest
  // centred window of the source with the target aspect ratio, then scale that
  // window to the target box. Doing the crop *before* the scaler is what lets
  // every encoder share it — the hardware scalers (scale_qsv / scale_vaapi)
  // have no aspect-ratio or crop options, and hwuploaded frames cannot be
  // cropped in software afterwards.
  const cropBox = `crop=w='min(iw,ih*${w}/${h})':h='min(ih,iw*${h}/${w})'`

  if (encoder === "qsv") {
    // QSV path: hardware device initialization + VPP hardware scaler +
    // hardware HEVC encode. `mode=hq` favors quality over throughput;
    // the Pi screen is small so the speed tax is immaterial.
    // In FFmpeg 7+ (oneVPL), scale_qsv expects hardware frames, so we
    // initialize the device context and upload frames to QSV surfaces.
    return [
      ...common,
      "-init_hw_device",
      "qsv=hw",
      "-filter_hw_device",
      "hw",
      "-vf",
      `${cropBox},hwupload=extra_hw_frames=64,format=qsv,scale_qsv=w=${w}:h=${h}:mode=hq`,
      "-c:v",
      "hevc_qsv",
      "-level",
      QSV_LEVEL,
      "-b:v",
      HW_BITRATE_TARGET,
      "-maxrate",
      HW_BITRATE_MAX,
      "-bufsize",
      HW_VBV_BUFFER,
      "-pix_fmt",
      "nv12",
      "-movflags",
      "+faststart",
      paths.partialAbs,
    ]
  }
  if (encoder === "vaapi") {
    const enc = job.target_codec === "h264" ? "h264_vaapi" : "hevc_vaapi"
    return [
      ...common,
      "-init_hw_device",
      "vaapi=va:/dev/dri/renderD128",
      "-filter_hw_device",
      "va",
      "-vf",
      `${cropBox},format=nv12,hwupload,scale_vaapi=w=${w}:h=${h}:mode=hq`,
      "-c:v",
      enc,
      "-level",
      VAAPI_LEVEL,
      "-rc_mode",
      "VBR",
      "-b:v",
      HW_BITRATE_TARGET,
      "-maxrate",
      HW_BITRATE_MAX,
      "-bufsize",
      HW_VBV_BUFFER,
      "-movflags",
      "+faststart",
      paths.partialAbs,
    ]
  }

  // Software libx265 path. The crop box above already yields the target aspect
  // ratio, so the scaler is a plain fit with no aspect handling of its own.
  const sw = job.target_codec === "h264" ? "libx264" : "libx265"
  return [
    ...common,
    "-vf",
    `${cropBox},scale=${w}:${h}`,
    "-c:v",
    sw,
    "-crf",
    String(q),
    "-preset",
    "medium",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    paths.partialAbs,
  ]
}

/**
 * Parse one line of `-progress pipe:1` output. Returns the percent (0..100)
 * if this line completes a `out_time_ms=` measurement, otherwise null.
 * The caller threads `durationMs` from ffprobe-on-source or, when unknown,
 * passes 0 to disable percent computation.
 */
export const parseProgressLine = (
  line: string,
  durationMs: number,
  prevPercent: number
): number | null => {
  // ffmpeg writes lines like `out_time_ms=12345678`. The value is microseconds
  // (the field is mis-named upstream). When duration is unknown we cannot
  // compute percent — leave prevPercent alone.
  const m = /^out_time_ms=(\d+)$/.exec(line.trim())
  if (!m || durationMs <= 0) return null
  const elapsedMs = Number(m[1]) / 1000
  const pct = Math.max(0, Math.min(99, Math.floor((elapsedMs / durationMs) * 100)))
  if (pct <= prevPercent) return null
  return pct
}

export interface TranscodeOptions {
  readonly sourcePath: string
  readonly outputPath: string
  readonly onProgress?: (percent: number) => void
  readonly ffmpegBin?: string
  /**
   * Optional pre-detected encoder. Tests inject `"x265"` to keep runtime
   * deterministic; production calls `detectEncoder()` once at startup and
   * reuses the result for every job.
   */
  readonly encoder?: EncoderKind
}

export interface TranscodeResult {
  readonly outputPath: string
  readonly outputSize: number
  readonly durationMs: number
  readonly encoderUsed: EncoderKind
}

const probeDurationMs = async (ffmpegBin: string, sourceAbs: string): Promise<number> => {
  // Use ffmpeg itself (not ffprobe) so the Worker image only ships one binary.
  // We read the "Duration: HH:MM:SS.cs" line from stderr.
  const res = await runOnce(ffmpegBin, ["-hide_banner", "-i", sourceAbs], {
    timeoutMs: 10_000,
  })
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(res.stderr)
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return 0
  const h = Number(m[1])
  const min = Number(m[2])
  const s = Number(m[3])
  return Math.floor((h * 3600 + min * 60 + s) * 1000)
}

export const transcode = async (
  job: TranscodeJob,
  opts: TranscodeOptions
): Promise<TranscodeResult> => {
  const ffmpegBin = opts.ffmpegBin ?? FFMPEG
  const paths = buildJobPaths(opts.sourcePath, opts.outputPath)

  // Source presence check — fail fast if the Pi download failed.
  await stat(paths.sourceAbs).catch(() => {
    throw new Error(`Source not found: ${paths.sourceAbs}`)
  })

  await mkdir(paths.outputDir, { recursive: true })

  // Clean any stale .partial. ffmpeg's `-y` overwrites by design, but NFS can
  // leave the file open-by-dead-host, blocking open().
  await unlink(paths.partialAbs).catch(() => {})

  const encoder: EncoderKind = opts.encoder ?? (await detectEncoder(ffmpegBin)).kind
  const args = buildFfmpegArgs(job, paths, encoder)
  const durationMs = await probeDurationMs(ffmpegBin, paths.sourceAbs)

  const startedAt = Date.now()

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stderrTail = ""
    let stdoutLineBuf = ""
    let lastPercent = 0

    child.stdout.on("data", (b: Buffer) => {
      stdoutLineBuf += b.toString()
      let nl = stdoutLineBuf.indexOf("\n")
      while (nl !== -1) {
        const line = stdoutLineBuf.slice(0, nl)
        stdoutLineBuf = stdoutLineBuf.slice(nl + 1)
        const next = parseProgressLine(line, durationMs, lastPercent)
        if (next !== null) {
          lastPercent = next
          opts.onProgress?.(next)
        }
        nl = stdoutLineBuf.indexOf("\n")
      }
    })

    child.stderr.on("data", (b: Buffer) => {
      stderrTail += b.toString()
      // Keep the last ~8KB of stderr — final error report grabs the tail.
      if (stderrTail.length > 8_192) {
        stderrTail = stderrTail.slice(stderrTail.length - 8_192)
      }
    })

    child.on("error", (err) => rejectPromise(err))
    child.on("close", (code) => {
      if (code === 0) return resolvePromise()
      const tail = stderrTail.split("\n").slice(-20).join("\n")
      rejectPromise(new Error(`ffmpeg exited ${code}\n${tail}`))
    })
  })

  await rename(paths.partialAbs, paths.finalAbs)
  const st = await stat(paths.finalAbs)

  return {
    outputPath: paths.finalAbs,
    outputSize: st.size,
    durationMs: Date.now() - startedAt,
    encoderUsed: encoder,
  }
}
