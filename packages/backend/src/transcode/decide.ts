import type { VideoProbe } from "@pwe/shared"

export interface ScreenSpec {
  readonly width: number
  readonly height: number
}

export type TranscodeDecision =
  | { readonly kind: "skip"; readonly reason: string }
  | {
      readonly kind: "transcode"
      readonly target_width: number
      readonly target_height: number
      readonly target_codec: "hevc" | "h264"
      readonly reason: string
    }

const isSameResolution = (probe: VideoProbe, screen: ScreenSpec): boolean =>
  probe.width === screen.width && probe.height === screen.height

const aspectRatio = (w: number, h: number): number => w / h

const ASPECT_TOLERANCE = 0.05

export const decideTranscode = (
  probe: VideoProbe,
  screen: ScreenSpec,
  preferredCodec: "hevc" | "h264" = "hevc"
): TranscodeDecision => {
  const screenAspect = aspectRatio(screen.width, screen.height)
  const sourceAspect = aspectRatio(probe.width, probe.height)
  const aspectMatches = Math.abs(sourceAspect - screenAspect) < ASPECT_TOLERANCE
  const codec = probe.codec.toLowerCase()

  // Vertical content
  if (probe.height > probe.width) {
    return {
      kind: "skip",
      reason: "Vertical content — let mpv runtime-scale with fit mode",
    }
  }

  // 4K — always transcode
  if (probe.width >= 2160 || probe.height >= 1440) {
    return {
      kind: "transcode",
      target_width: screen.width,
      target_height: screen.height,
      target_codec: preferredCodec,
      reason: `4K source (${probe.width}x${probe.height}) — transcode to screen native`,
    }
  }

  // Exact match + supported codec
  if (isSameResolution(probe, screen) && (codec === "h264" || codec === "hevc")) {
    return { kind: "skip", reason: "Already at screen native resolution and codec" }
  }

  // 1080p / 720p H.264 or HEVC with aspect mismatch
  if (!aspectMatches) {
    return {
      kind: "transcode",
      target_width: screen.width,
      target_height: screen.height,
      target_codec: codec === "hevc" ? "hevc" : preferredCodec,
      reason: `Aspect mismatch (${sourceAspect.toFixed(2)} vs ${screenAspect.toFixed(2)}) — crop to screen`,
    }
  }

  // 1080p source, screen-aspect match, supported codec — let mpv runtime-scale
  if (codec === "h264" || codec === "hevc") {
    return {
      kind: "skip",
      reason: "Aspect matches and codec is supported — mpv handles scaling",
    }
  }

  // Unsupported codec
  return {
    kind: "transcode",
    target_width: screen.width,
    target_height: screen.height,
    target_codec: preferredCodec,
    reason: `Source codec ${codec} not hardware-decodable on Pi 4B`,
  }
}
