// Canonical mapping from a tagged business error to an HTTP status + body.
// Centralizes what was duplicated across ~28 route handlers. The mapping is
// kind-aware (StorageError/DisplayError/etc.) and was derived from the existing
// per-route catchTag status codes so wiring a route through this preserves its
// contract. Pure, so it is unit-tested without a runtime.

export interface HttpErrorResult {
  readonly status: number
  readonly body: { readonly error: string }
}

type Tagged = { readonly _tag?: string; readonly [key: string]: unknown }

const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""))

export const httpFromError = (err: Tagged): HttpErrorResult => {
  const error = (msg: string): HttpErrorResult["body"] => ({ error: msg })
  const kind = str(err["kind"])
  const message = str(err["message"])

  switch (err._tag) {
    case "LibraryNotFoundError":
      return { status: 404, body: error(`Wallpaper ${str(err["workshopId"])} not found`) }
    case "NotVideoWallpaperError":
      return { status: 422, body: error(`Not a video wallpaper (${str(err["actualType"])})`) }
    case "MpvIpcError":
    case "MpvSpawnError":
      return { status: 500, body: error(`mpv: ${str(err["reason"])}`) }
    case "StorageError":
      return {
        status:
          kind === "Busy"
            ? 409
            : kind === "Validation" || kind === "Config"
              ? 400
              : kind === "Disconnected"
                ? 503
                : 500,
        body: error(message),
      }
    case "MigrateError":
      return {
        status: kind === "Busy" || kind === "Cancelled" ? 409 : kind === "Space" ? 507 : 500,
        body: error(message),
      }
    case "DisplayError":
      return { status: kind === "NotConfigured" ? 503 : 500, body: error(message) }
    case "SteamCmdError":
      return {
        status:
          kind === "AuthRequired"
            ? 401
            : kind === "NotSubscribed"
              ? 403
              : kind === "Timeout"
                ? 504
                : 500,
        body: error(message),
      }
    case "WorkshopApiError":
      return { status: 502, body: error(message) }
    case "WorkerTimeoutError":
      return { status: 504, body: error("worker timed out") }
    case "ConfigError":
    case "FfprobeError":
      return { status: 500, body: error(str(err["reason"])) }
    case "DbError":
      return { status: 500, body: error("Database error") }
    default:
      return { status: 500, body: error(message || str(err)) }
  }
}
