import { describe, expect, test } from "bun:test"
import { decideSourcePathRepair, hasSuspectSourceMetadata } from "./Library.js"

// SteamCMD's "Success" line sometimes reports the transient downloads/<weAppId>
// path, then moves files to content/. reconcilePaths repairs stale rows in
// place, but only when the swapped path actually exists on disk.
describe("decideSourcePathRepair", () => {
  const downloads = "source/123/steamapps/workshop/downloads/431960/123/bg.mp4"
  const content = "source/123/steamapps/workshop/content/431960/123/bg.mp4"

  test("rewrites a stale downloads/ path to content/ when content exists", () => {
    const exists = (p: string) => p === content
    expect(decideSourcePathRepair(downloads, exists)).toBe(content)
  })

  test("leaves a correct content/ path untouched", () => {
    const exists = (p: string) => p === content
    expect(decideSourcePathRepair(content, exists)).toBeNull()
  })

  test("rewrites content/ back to downloads/ when only downloads exists", () => {
    const exists = (p: string) => p === downloads
    expect(decideSourcePathRepair(content, exists)).toBe(downloads)
  })

  test("does not rewrite when the swapped path also does not exist", () => {
    expect(decideSourcePathRepair(downloads, () => false)).toBeNull()
  })

  test("does not rewrite a path that contains neither marker", () => {
    expect(decideSourcePathRepair("source/123/loose/bg.mp4", () => false)).toBeNull()
  })
})

describe("hasSuspectSourceMetadata", () => {
  test("flags unknown codec or 0x0 resolution", () => {
    expect(hasSuspectSourceMetadata("unknown", "1920x1080")).toBe(true)
    expect(hasSuspectSourceMetadata("h264", "0x0")).toBe(true)
  })

  test("passes good metadata", () => {
    expect(hasSuspectSourceMetadata("h264", "1920x1080")).toBe(false)
  })
})
