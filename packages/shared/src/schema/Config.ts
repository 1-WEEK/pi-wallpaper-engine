import { Schema } from "effect"

export const DisplayMode = Schema.Literal("fill", "fit", "stretch")
export type DisplayMode = typeof DisplayMode.Type

export const HwDec = Schema.Literal("auto", "auto-safe", "v4l2m2m", "drm", "drmprime", "no")
export type HwDec = typeof HwDec.Type

export const GpuApi = Schema.Literal("opengl", "vulkan", "auto")
export type GpuApi = typeof GpuApi.Type

export const TargetCodec = Schema.Literal("hevc", "h264")
export type TargetCodec = typeof TargetCodec.Type

export const SteamConfig = Schema.Struct({
  username: Schema.String.pipe(Schema.minLength(1)),
  web_api_key: Schema.String.pipe(Schema.minLength(1)),
  steamcmd_path: Schema.String.pipe(Schema.minLength(1)),
})

export const PathsConfig = Schema.Struct({
  data_root: Schema.String.pipe(Schema.minLength(1)),
  source_dir: Schema.String.pipe(Schema.minLength(1)),
  optimized_dir: Schema.String.pipe(Schema.minLength(1)),
})

export const ScreenConfig = Schema.Struct({
  width: Schema.Number.pipe(Schema.int(), Schema.positive()),
  height: Schema.Number.pipe(Schema.int(), Schema.positive()),
  default_display_mode: DisplayMode,
})

export const MpvConfig = Schema.Struct({
  binary_path: Schema.String.pipe(Schema.minLength(1)),
  ipc_socket: Schema.String.pipe(Schema.minLength(1)),
  hwdec: HwDec,
  gpu_api: GpuApi,
})

export const TranscodeConfig = Schema.Struct({
  target_codec: TargetCodec,
  target_quality: Schema.Number.pipe(Schema.between(0, 51)),
  heartbeat_timeout_ms: Schema.Number.pipe(Schema.positive()),
})

export const ServerConfig = Schema.Struct({
  host: Schema.String.pipe(Schema.minLength(1)),
  port: Schema.Number.pipe(Schema.between(1, 65535)),
})

export const Config = Schema.Struct({
  steam: SteamConfig,
  paths: PathsConfig,
  screen: ScreenConfig,
  mpv: MpvConfig,
  transcode: TranscodeConfig,
  server: ServerConfig,
})

export type Config = typeof Config.Type
