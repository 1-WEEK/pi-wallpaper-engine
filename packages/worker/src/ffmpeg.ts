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

export type EncoderKind = "qsv" | "x265"

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
  if (list.code !== 0 || !list.stdout.includes("hevc_qsv")) {
    return { kind: "x265", reason: "hevc_qsv not present in ffmpeg -encoders output" }
  }

  // ~1 frame at 24fps from a 64x64 lavfi source. Encoded into a null muxer so
  // nothing is written. If /dev/dri/renderD128 is missing or not accessible,
  // ffmpeg exits non-zero with "Cannot load libmfx" / similar.
  const probe = await runOnce(
    ffmpeg,
    [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "nullsrc=s=64x64:d=0.04",
      "-c:v",
      "hevc_qsv",
      "-f",
      "null",
      "-",
    ],
    { timeoutMs: 8_000 }
  )
  if (probe.code !== 0) {
    return {
      kind: "x265",
      reason: `hevc_qsv device probe failed (${probe.code}): ${probe.stderr.split("\n").slice(-3).join(" / ").slice(0, 200)}`,
    }
  }
  return { kind: "qsv", reason: "hevc_qsv device probe succeeded" }
}

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
  ]

  const w = job.target_width
  const h = job.target_height
  const q = job.target_quality

  if (encoder === "qsv") {
    // QSV path: hardware scaler + hardware HEVC encode. `mode=hq` favors
    // quality over throughput; the Pi screen is small so the speed tax is
    // immaterial.
    return [
      ...common,
      "-vf",
      `scale_qsv=w=${w}:h=${h}:mode=hq`,
      "-c:v",
      "hevc_qsv",
      "-global_quality",
      String(q),
      "-pix_fmt",
      "nv12",
      "-movflags",
      "+faststart",
      paths.partialAbs,
    ]
  }

  // Software libx265 path with aspect-correct crop. `force_original_aspect_ratio=
  // increase` upscales to cover the target box, then `crop` trims the overflow
  // — matches the Pi's "fill" display mode.
  const sw = job.target_codec === "h264" ? "libx264" : "libx265"
  return [
    ...common,
    "-vf",
    `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`,
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
