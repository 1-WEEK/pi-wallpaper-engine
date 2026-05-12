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
