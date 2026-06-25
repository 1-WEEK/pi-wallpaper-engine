import { Data } from "effect"

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly path: string
  readonly reason: string
}> {}

export class DbError extends Data.TaggedError("DbError")<{
  readonly operation: string
  readonly cause: unknown
}> {}

export class WorkshopApiError extends Data.TaggedError("WorkshopApiError")<{
  readonly status: number
  readonly message: string
}> {}

export type SteamCmdFailureKind =
  | "AuthRequired"
  | "NotSubscribed"
  | "Timeout"
  | "BinaryNotFound"
  | "UnknownFailure"

export class SteamCmdError extends Data.TaggedError("SteamCmdError")<{
  readonly kind: SteamCmdFailureKind
  readonly message: string
  readonly exitCode?: number | undefined
}> {}

export class MpvIpcError extends Data.TaggedError("MpvIpcError")<{
  readonly reason: string
  readonly cause?: unknown
}> {}

export class MpvSpawnError extends Data.TaggedError("MpvSpawnError")<{
  readonly reason: string
  readonly cause?: unknown
}> {}

export class WorkerTimeoutError extends Data.TaggedError("WorkerTimeoutError")<{
  readonly jobId: string
  readonly elapsedMs: number
}> {}

export class LibraryNotFoundError extends Data.TaggedError("LibraryNotFoundError")<{
  readonly workshopId: string
}> {}

export class FfprobeError extends Data.TaggedError("FfprobeError")<{
  readonly path: string
  readonly reason: string
}> {}

export class NotVideoWallpaperError extends Data.TaggedError("NotVideoWallpaperError")<{
  readonly workshopId: string
  readonly actualType: string
}> {}

export type DisplayFailureKind = "NotConfigured" | "Timeout" | "NonZeroExit" | "SpawnFailed"

export class DisplayError extends Data.TaggedError("DisplayError")<{
  readonly kind: DisplayFailureKind
  readonly message: string
  readonly exitCode?: number | undefined
  readonly stderr?: string | undefined
}> {}

export type StorageFailureKind =
  | "Disconnected"
  | "Config"
  | "Validation"
  | "Busy"
export class StorageError extends Data.TaggedError("StorageError")<{
  readonly kind: StorageFailureKind
  readonly message: string
  readonly cause?: unknown
}> {}

export type MigrateFailureKind = "Busy" | "Space" | "Copy" | "Verify" | "Cancelled"

export class MigrateError extends Data.TaggedError("MigrateError")<{
  readonly kind: MigrateFailureKind
  readonly message: string
  readonly cause?: unknown
}> {}
