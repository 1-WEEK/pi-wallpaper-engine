import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  assertCredentialFileValue,
  assertSmbComponentValue,
  isPathInsideRoot,
  normalizeSmbRelativePath,
  normalizeMountOptions,
} from "./Storage.js"

describe("normalizeMountOptions", () => {
  test("accepts the supported CIFS option set", async () => {
    const options = await Effect.runPromise(
      normalizeMountOptions([
        "vers=3.0",
        "iocharset=utf8",
        "uid=1000",
        "gid=1000",
        "file_mode=0644",
        "dir_mode=0755",
        "nobrl",
      ])
    )

    expect(options).toEqual([
      "vers=3.0",
      "iocharset=utf8",
      "uid=1000",
      "gid=1000",
      "file_mode=0644",
      "dir_mode=0755",
      "nobrl",
    ])
  })

  test("rejects dangerous credential and downgrade options", async () => {
    await expect(Effect.runPromise(normalizeMountOptions(["credentials=/tmp/evil"]))).rejects.toThrow(
      "not allowed"
    )
    await expect(Effect.runPromise(normalizeMountOptions(["password=secret"]))).rejects.toThrow(
      "not allowed"
    )
    await expect(Effect.runPromise(normalizeMountOptions(["sec=ntlm"]))).rejects.toThrow(
      "not allowed"
    )
    await expect(Effect.runPromise(normalizeMountOptions(["vers=1.0"]))).rejects.toThrow(
      "not allowed"
    )
    await expect(Effect.runPromise(normalizeMountOptions(["noperm"]))).rejects.toThrow(
      "not allowed"
    )
  })

  test("rejects unsupported option keys", async () => {
    await expect(Effect.runPromise(normalizeMountOptions(["seal"]))).rejects.toThrow("not supported")
  })
})

describe("isPathInsideRoot", () => {
  test("matches files inside the mounted root", () => {
    expect(isPathInsideRoot("/mnt/pwe/share/video.mp4", "/mnt/pwe/share")).toBe(true)
    expect(isPathInsideRoot("/mnt/pwe/share/subdir/video.mp4", "/mnt/pwe/share")).toBe(true)
  })

  test("does not confuse sibling prefixes with descendants", () => {
    expect(isPathInsideRoot("/mnt/pwe/share-2/video.mp4", "/mnt/pwe/share")).toBe(false)
  })

  test("rejects paths outside the mounted root", () => {
    expect(isPathInsideRoot("/mnt/other/video.mp4", "/mnt/pwe/share")).toBe(false)
  })
})

describe("assertCredentialFileValue", () => {
  test("accepts ordinary credential values", async () => {
    await expect(Effect.runPromise(assertCredentialFileValue("Username", "steam-user"))).resolves.toBe(
      "steam-user"
    )
    await expect(Effect.runPromise(assertCredentialFileValue("Domain", ""))).resolves.toBe("")
    await expect(Effect.runPromise(assertCredentialFileValue("Password", "s3cr3t"))).resolves.toBe(
      "s3cr3t"
    )
  })

  test("rejects newline and NUL injection into credential files", async () => {
    await expect(
      Effect.runPromise(assertCredentialFileValue("Username", "alice\npassword=hunter2"))
    ).rejects.toThrow("cannot contain newline or NUL characters")
    await expect(
      Effect.runPromise(assertCredentialFileValue("Domain", "WORKGROUP\r\nsec=none"))
    ).rejects.toThrow("cannot contain newline or NUL characters")
    await expect(
      Effect.runPromise(assertCredentialFileValue("Password", "abc\0def"))
    ).rejects.toThrow("cannot contain newline or NUL characters")
  })
})

describe("assertSmbComponentValue", () => {
  test("accepts ordinary server and share names", async () => {
    await expect(Effect.runPromise(assertSmbComponentValue("Server", "nas.local"))).resolves.toBe(
      "nas.local"
    )
    await expect(Effect.runPromise(assertSmbComponentValue("Share", "wallpapers 4k"))).resolves.toBe(
      "wallpapers 4k"
    )
  })

  test("rejects subpaths and control characters", async () => {
    await expect(Effect.runPromise(assertSmbComponentValue("Share", "wallpapers/2026"))).rejects.toThrow(
      "cannot contain slashes"
    )
    await expect(Effect.runPromise(assertSmbComponentValue("Server", "nas\nother"))).rejects.toThrow(
      "cannot contain slashes"
    )
    await expect(Effect.runPromise(assertSmbComponentValue("Share", "abc\0def"))).rejects.toThrow(
      "cannot contain slashes"
    )
  })
})

describe("normalizeSmbRelativePath", () => {
  test("accepts empty and nested relative paths", async () => {
    await expect(Effect.runPromise(normalizeSmbRelativePath("Path", ""))).resolves.toBe("")
    await expect(
      Effect.runPromise(normalizeSmbRelativePath("Path", " pi-wallpaper-engine "))
    ).resolves.toBe("pi-wallpaper-engine")
    await expect(
      Effect.runPromise(normalizeSmbRelativePath("Path", "media/wallpapers"))
    ).resolves.toBe("media/wallpapers")
  })

  test("rejects absolute, parent, empty, and control segments", async () => {
    await expect(Effect.runPromise(normalizeSmbRelativePath("Path", "/media"))).rejects.toThrow(
      "relative path"
    )
    await expect(
      Effect.runPromise(normalizeSmbRelativePath("Path", "media/../wallpapers"))
    ).rejects.toThrow("path segments")
    await expect(
      Effect.runPromise(normalizeSmbRelativePath("Path", "media//wallpapers"))
    ).rejects.toThrow("path segments")
    await expect(
      Effect.runPromise(normalizeSmbRelativePath("Path", "media\\wallpapers"))
    ).rejects.toThrow("relative path")
    await expect(
      Effect.runPromise(normalizeSmbRelativePath("Path", "media\nwallpapers"))
    ).rejects.toThrow("relative path")
  })
})
