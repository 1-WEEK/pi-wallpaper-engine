import { Schema } from "effect"

export const DisplayMode = Schema.Literals(["fill", "fit", "stretch"])
export type DisplayMode = typeof DisplayMode.Type

export const HwDec = Schema.Literals(["auto", "auto-safe", "v4l2m2m", "drm", "drmprime", "no"])
export type HwDec = typeof HwDec.Type

export const GpuApi = Schema.Literals(["opengl", "vulkan", "auto"])
export type GpuApi = typeof GpuApi.Type

export const TargetCodec = Schema.Literals(["hevc", "h264"])
export type TargetCodec = typeof TargetCodec.Type

export const SteamConfig = Schema.Struct({
  username: Schema.String.check(Schema.isMinLength(1)),
  web_api_key: Schema.String.check(Schema.isMinLength(1)),
  steamcmd_path: Schema.String.check(Schema.isMinLength(1)),
})

export const PathsConfig = Schema.Struct({
  data_root: Schema.String.check(Schema.isMinLength(1)),
  source_dir: Schema.String.check(Schema.isMinLength(1)),
  optimized_dir: Schema.String.check(Schema.isMinLength(1)),
})

export const StorageConfig = Schema.Struct({
  root: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMinLength(1)))),
})
export type StorageConfig = typeof StorageConfig.Type

export const ScreenConfig = Schema.Struct({
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
  default_display_mode: DisplayMode,
})

export const MpvConfig = Schema.Struct({
  binary_path: Schema.String.check(Schema.isMinLength(1)),
  ipc_socket: Schema.String.check(Schema.isMinLength(1)),
  hwdec: HwDec,
  gpu_api: GpuApi,
})

export const TranscodeConfig = Schema.Struct({
  target_codec: TargetCodec,
  target_quality: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 51 })),
  heartbeat_timeout_ms: Schema.Number.check(Schema.isGreaterThan(0)),
})

export const ServerConfig = Schema.Struct({
  host: Schema.String.check(Schema.isMinLength(1)),
  port: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
})

// Optional display power control. Each command is an argv array, executed
// directly without a shell (no injection, no quoting). `status_command` exits
// 0 when the display is on, non-zero when off. Without status_command, the
// service falls back to an in-memory cache of the last on/off action.
export const DisplayConfig = Schema.Struct({
  on_command: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  off_command: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  status_command: Schema.optional(Schema.Array(Schema.String).check(Schema.isMinLength(1))),
})

const HttpsUrl = Schema.String.check(Schema.isPattern(/^https:\/\/[^\s]+$/))

export const AuthConfig = Schema.Struct({
  enabled: Schema.Boolean,
  base_url: HttpsUrl,
  trusted_origins: Schema.Array(HttpsUrl).check(Schema.isMinLength(1)),
  rp_id: Schema.String.check(Schema.isMinLength(1)),
  admin_email: Schema.String.check(Schema.isMinLength(1)),
  secret_env: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  setup_token_env: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  session_days: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  max_passkeys: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
})
export type AuthConfig = typeof AuthConfig.Type

export const Config = Schema.Struct({
  steam: SteamConfig,
  paths: PathsConfig,
  storage: Schema.optional(StorageConfig),
  screen: ScreenConfig,
  mpv: MpvConfig,
  transcode: TranscodeConfig,
  server: ServerConfig,
  display: Schema.optional(DisplayConfig),
  auth: Schema.optional(AuthConfig),
})

export type Config = typeof Config.Type
