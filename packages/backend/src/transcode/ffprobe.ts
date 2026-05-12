import { Effect } from "effect"
import { FfprobeError, type VideoProbe } from "@pwe/shared"

interface FfprobeStream {
  readonly codec_type?: string
  readonly codec_name?: string
  readonly width?: number
  readonly height?: number
}

interface FfprobeFormat {
  readonly duration?: string
  readonly size?: string
}

interface FfprobeOutput {
  readonly streams?: ReadonlyArray<FfprobeStream>
  readonly format?: FfprobeFormat
}

export const ffprobe = (filePath: string): Effect.Effect<VideoProbe, FfprobeError> =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(
        [
          "ffprobe",
          "-v",
          "error",
          "-print_format",
          "json",
          "-show_streams",
          "-show_format",
          filePath,
        ],
        { stdout: "pipe", stderr: "pipe", stdin: "ignore" }
      )

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const code = await proc.exited
      if (code !== 0) throw new Error(`ffprobe exit ${code}: ${stderr}`)

      const parsed = JSON.parse(stdout) as FfprobeOutput
      const video = parsed.streams?.find((s) => s.codec_type === "video")
      if (!video || video.width == null || video.height == null) {
        throw new Error("No video stream found")
      }

      const duration = parsed.format?.duration ? parseFloat(parsed.format.duration) : 0
      const size = parsed.format?.size ? parseInt(parsed.format.size, 10) : 0

      return {
        width: video.width,
        height: video.height,
        codec: video.codec_name ?? "unknown",
        duration_seconds: duration,
        size_bytes: size,
      }
    },
    catch: (e) =>
      new FfprobeError({
        path: filePath,
        reason: e instanceof Error ? e.message : String(e),
      }),
  })
