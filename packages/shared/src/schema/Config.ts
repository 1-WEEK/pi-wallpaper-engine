import { Schema } from "effect"

export const DisplayMode = Schema.Literal("fill", "fit", "stretch")
export type DisplayMode = typeof DisplayMode.Type

export const HwDec = Schema.Literal("auto", "auto-safe", "v4l2m2m", "drm", "drmprime", "no")
export type HwDec = typeof HwDec.Type

export const GpuApi = Schema.Literal("opengl", "vulkan", "auto")
export type GpuApi = typeof GpuApi.Type

export const TargetCodec = Schema.Literal("hevc", "h264")
export type TargetCodec = typeof TargetCodec.Type

export const StorageMode = Schema.Literal("local", "mounted_share")
export type StorageMode = typeof StorageMode.Type

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

// A single SMB data source (a NAS, a Samba box, a Windows share — anything
// that speaks SMB). The owner sets this once; there is no multi-server
// management. Connection name, mount base, sentinel, and mount options are
// backend constants, not user-facing config.
export const SmbConfig = Schema.Struct({
  server: Schema.String.pipe(Schema.minLength(1)),
  share: Schema.String.pipe(Schema.minLength(1)),
  username: Schema.String.pipe(Schema.minLength(1)),
  // Relative path inside the SMB share where media files live. Empty means the
  // share root, preserving compatibility with older configs.
  path: Schema.optional(Schema.String),
})
export type SmbConfig = typeof SmbConfig.Type

export const StorageConfig = Schema.Struct({
  mode: Schema.optional(StorageMode),
  smb: Schema.optional(Schema.NullOr(SmbConfig)),
})
export type StorageConfig = typeof StorageConfig.Type

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

// Optional display power control. Each command is an argv array, executed
// directly without a shell (no injection, no quoting). `status_command` exits
// 0 when the display is on, non-zero when off. Without status_command, the
// service falls back to an in-memory cache of the last on/off action.
export const DisplayConfig = Schema.Struct({
  on_command: Schema.Array(Schema.String).pipe(Schema.minItems(1)),
  off_command: Schema.Array(Schema.String).pipe(Schema.minItems(1)),
  status_command: Schema.optional(Schema.Array(Schema.String).pipe(Schema.minItems(1))),
})

export const Config = Schema.Struct({
  steam: SteamConfig,
  paths: PathsConfig,
  storage: Schema.optional(StorageConfig),
  screen: ScreenConfig,
  mpv: MpvConfig,
  transcode: TranscodeConfig,
  server: ServerConfig,
  display: Schema.optional(DisplayConfig),
})

export type Config = typeof Config.Type
