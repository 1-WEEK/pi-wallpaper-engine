import { Schema } from "effect"
import { DisplayMode, PathsConfig, ScreenConfig, MpvConfig, ServerConfig } from "./Config.js"
import { PlayMode } from "./Playback.js"

// ── Player Status ──────────────────────────────────

export const PlayerStatus = Schema.Struct({
  playing: Schema.Boolean,
  current_workshop_id: Schema.NullOr(Schema.String),
  path: Schema.NullOr(Schema.String),
  display_mode: DisplayMode,
  play_mode: PlayMode,
  rotation_interval_sec: Schema.Number,
  current_title: Schema.NullOr(Schema.String),
  current_preview_url: Schema.NullOr(Schema.String),
  current_resolution: Schema.NullOr(Schema.String),
  current_codec: Schema.NullOr(Schema.String),
})
export type PlayerStatus = typeof PlayerStatus.Type

// ── Display Status ─────────────────────────────────

export const DisplayState = Schema.Literal("on", "off", "unknown")
export type DisplayState = typeof DisplayState.Type

export const DisplayStateSource = Schema.Literal("probed", "cached", "default")
export type DisplayStateSource = typeof DisplayStateSource.Type

export const DisplayStatus = Schema.Struct({
  configured: Schema.Boolean,
  state: DisplayState,
  source: DisplayStateSource,
  error_kind: Schema.NullOr(Schema.String),
})
export type DisplayStatus = typeof DisplayStatus.Type

// ── Storage Status ─────────────────────────────────

export const StorageStatus = Schema.Struct({
  available: Schema.Boolean,
  path: Schema.String,
  data_root: Schema.String,
  default_root: Schema.String,
  using_default: Schema.Boolean,
  last_error: Schema.NullOr(Schema.String),
  used_bytes: Schema.NullOr(Schema.Number),
  free_bytes: Schema.NullOr(Schema.Number),
  total_bytes: Schema.NullOr(Schema.Number),
  used_percent: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
})
export type StorageStatus = typeof StorageStatus.Type

// ── Library / Downloads / Sleep / Transcode ────────

export const LibraryCounts = Schema.Struct({
  total: Schema.Number,
})
export type LibraryCounts = typeof LibraryCounts.Type

export const DownloadsCounts = Schema.Struct({
  active: Schema.Number,
  finished: Schema.Number,
})
export type DownloadsCounts = typeof DownloadsCounts.Type

export const SleepStatus = Schema.Struct({
  active: Schema.Boolean,
  deadline: Schema.NullOr(Schema.Number),
})
export type SleepStatus = typeof SleepStatus.Type

export const TranscodeCounts = Schema.Struct({
  pending: Schema.Number,
  claimed: Schema.Number,
  running: Schema.Number,
  uploading: Schema.Number,
  completed: Schema.Number,
  failed: Schema.Number,
})
export type TranscodeCounts = typeof TranscodeCounts.Type

// ── Steam Summary Config ───────────────────────────
// Separate from SteamConfig (raw web_api_key) —
// this one carries the masked version for public API responses.

export const SteamSummaryConfig = Schema.Struct({
  username: Schema.String,
  web_api_key_masked: Schema.String,
  steamcmd_path: Schema.String,
})
export type SteamSummaryConfig = typeof SteamSummaryConfig.Type

// ── Summary Config (public API shape) ──────────────

export const SummaryConfig = Schema.Struct({
  steam: SteamSummaryConfig,
  paths: PathsConfig,
  screen: ScreenConfig,
  mpv: MpvConfig,
  server: ServerConfig,
})
export type SummaryConfig = typeof SummaryConfig.Type

export const SummaryStatus = Schema.Struct({
  player: PlayerStatus,
  display: DisplayStatus,
  storage: StorageStatus,
  library: LibraryCounts,
  downloads: DownloadsCounts,
  sleep: SleepStatus,
  transcode: TranscodeCounts,
})
export type SummaryStatus = typeof SummaryStatus.Type

export const SystemSummary = Schema.Struct({
  config: SummaryConfig,
  status: SummaryStatus,
})
export type SystemSummary = typeof SystemSummary.Type
