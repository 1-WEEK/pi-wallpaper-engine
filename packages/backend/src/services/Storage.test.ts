import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { friendlyStorageError, isPathInsideRoot, normalizeCustomRootPath } from "./Storage.js"
import { StorageError } from "@pwe/shared"

describe("normalizeCustomRootPath", () => {
  test("accepts ordinary absolute paths", async () => {
    await expect(Effect.runPromise(normalizeCustomRootPath("Root", "/mnt/media"))).resolves.toBe(
      "/mnt/media"
    )
    await expect(
      Effect.runPromise(normalizeCustomRootPath("Root", " /media/usb/pi-wallpaper-engine "))
    ).resolves.toBe("/media/usb/pi-wallpaper-engine")
  })

  test("rejects empty, relative, and control-character paths", async () => {
    await expect(Effect.runPromise(normalizeCustomRootPath("Root", ""))).rejects.toThrow(
      "absolute directory path"
    )
    await expect(Effect.runPromise(normalizeCustomRootPath("Root", "media/usb"))).rejects.toThrow(
      "absolute directory path"
    )
    await expect(
      Effect.runPromise(normalizeCustomRootPath("Root", "/media/usb\nother"))
    ).rejects.toThrow("absolute directory path")
  })
})

describe("isPathInsideRoot", () => {
  test("matches files inside the selected root", () => {
    expect(isPathInsideRoot("/mnt/pwe/share/video.mp4", "/mnt/pwe/share")).toBe(true)
    expect(isPathInsideRoot("/mnt/pwe/share/subdir/video.mp4", "/mnt/pwe/share")).toBe(true)
  })

  test("does not confuse sibling prefixes with descendants", () => {
    expect(isPathInsideRoot("/mnt/pwe/share-2/video.mp4", "/mnt/pwe/share")).toBe(false)
  })

  test("rejects paths outside the selected root", () => {
    expect(isPathInsideRoot("/mnt/other/video.mp4", "/mnt/pwe/share")).toBe(false)
  })
})

describe("friendlyStorageError", () => {
  test("returns user-facing messages", () => {
    expect(
      friendlyStorageError(new StorageError({ kind: "Busy", message: "busy" }))
    ).toContain("Stop playback")
    expect(
      friendlyStorageError(new StorageError({ kind: "Disconnected", message: "down" }))
    ).toContain("unavailable")
  })
})
