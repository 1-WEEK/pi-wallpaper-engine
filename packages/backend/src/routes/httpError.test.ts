import { describe, expect, test } from "bun:test"
import { httpFromError } from "./httpError.js"

describe("httpFromError", () => {
  test("maps not-found and not-video to 404 / 422", () => {
    expect(httpFromError({ _tag: "LibraryNotFoundError", workshopId: "123" }).status).toBe(404)
    expect(httpFromError({ _tag: "NotVideoWallpaperError", actualType: "scene" }).status).toBe(422)
  })

  test("maps mpv errors to 500 with an mpv: prefix", () => {
    const r = httpFromError({ _tag: "MpvIpcError", reason: "socket gone" })
    expect(r.status).toBe(500)
    expect(r.body.error).toBe("mpv: socket gone")
  })

  test("maps StorageError by kind", () => {
    expect(httpFromError({ _tag: "StorageError", kind: "Busy", message: "m" }).status).toBe(409)
    expect(httpFromError({ _tag: "StorageError", kind: "Validation", message: "m" }).status).toBe(400)
    expect(httpFromError({ _tag: "StorageError", kind: "Disconnected", message: "m" }).status).toBe(503)
  })

  test("maps MigrateError by kind", () => {
    expect(httpFromError({ _tag: "MigrateError", kind: "Busy", message: "m" }).status).toBe(409)
    expect(httpFromError({ _tag: "MigrateError", kind: "Space", message: "m" }).status).toBe(507)
    expect(httpFromError({ _tag: "MigrateError", kind: "Copy", message: "m" }).status).toBe(500)
  })

  test("maps DisplayError NotConfigured to 503, else 500", () => {
    expect(httpFromError({ _tag: "DisplayError", kind: "NotConfigured", message: "m" }).status).toBe(503)
    expect(httpFromError({ _tag: "DisplayError", kind: "NonZeroExit", message: "m" }).status).toBe(500)
  })

  test("maps SteamCmdError by kind", () => {
    expect(httpFromError({ _tag: "SteamCmdError", kind: "AuthRequired", message: "m" }).status).toBe(401)
    expect(httpFromError({ _tag: "SteamCmdError", kind: "NotSubscribed", message: "m" }).status).toBe(403)
    expect(httpFromError({ _tag: "SteamCmdError", kind: "Timeout", message: "m" }).status).toBe(504)
    expect(httpFromError({ _tag: "SteamCmdError", kind: "UnknownFailure", message: "m" }).status).toBe(500)
  })

  test("maps gateway and infra errors", () => {
    expect(httpFromError({ _tag: "WorkshopApiError", message: "m" }).status).toBe(502)
    expect(httpFromError({ _tag: "WorkerTimeoutError" }).status).toBe(504)
    expect(httpFromError({ _tag: "DbError" }).status).toBe(500)
    expect(httpFromError({ _tag: "ConfigError", reason: "bad" }).body.error).toBe("bad")
  })

  test("falls back to 500 for unknown tags", () => {
    expect(httpFromError({ _tag: "WhoKnows", message: "boom" })).toEqual({
      status: 500,
      body: { error: "boom" },
    })
  })
})
