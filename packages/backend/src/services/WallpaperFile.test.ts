import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Either } from "effect"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { resolveWallpaperFiles } from "./WallpaperFile.js"

let dirs: string[] = []

const makeItemDir = async (files: Record<string, string>): Promise<string> => {
  const dir = await mkdtemp(resolve(tmpdir(), "pwe-wallpaper-"))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    await writeFile(resolve(dir, name), content)
  }
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  dirs = []
})

describe("resolveWallpaperFiles", () => {
  test("resolves a video wallpaper and reads metadata from project.json", async () => {
    const dir = await makeItemDir({
      "project.json": JSON.stringify({
        type: "video",
        file: "bg.mp4",
        title: "Aurora",
        preview: "preview.jpg",
      }),
      "bg.mp4": "x",
      "preview.jpg": "x",
    })

    const out = await Effect.runPromise(resolveWallpaperFiles(dir, "123"))

    expect(out.title).toBe("Aurora")
    expect(out.videoAbs).toBe(resolve(dir, "bg.mp4"))
    expect(out.previewAbs).toBe(resolve(dir, "preview.jpg"))
  })

  test("accepts a capitalized type value (case-insensitive gate)", async () => {
    const dir = await makeItemDir({
      "project.json": JSON.stringify({ type: "Video" }),
      "clip.webm": "x",
    })

    const out = await Effect.runPromise(resolveWallpaperFiles(dir, "1"))

    expect(out.videoAbs).toBe(resolve(dir, "clip.webm"))
  })

  test("rejects a non-video type as NotVideoWallpaperError (the real gate)", async () => {
    const dir = await makeItemDir({
      "project.json": JSON.stringify({ type: "scene" }),
      "scene.pkg": "x",
    })

    const res = await Effect.runPromise(Effect.either(resolveWallpaperFiles(dir, "777")))

    expect(Either.isLeft(res)).toBe(true)
    if (Either.isLeft(res) && res.left._tag === "NotVideoWallpaperError") {
      expect(res.left.actualType).toBe("scene")
      expect(res.left.workshopId).toBe("777")
    }
  })

  test("falls back to any video file when project.json is absent", async () => {
    const dir = await makeItemDir({ "movie.mkv": "x" })

    const out = await Effect.runPromise(resolveWallpaperFiles(dir, "42"))

    expect(out.videoAbs).toBe(resolve(dir, "movie.mkv"))
    expect(out.title).toBe("")
  })

  test("rejects when there is no type and no video file", async () => {
    const dir = await makeItemDir({ "readme.txt": "x" })

    const res = await Effect.runPromise(Effect.either(resolveWallpaperFiles(dir, "9")))

    expect(Either.isLeft(res)).toBe(true)
    if (Either.isLeft(res) && res.left._tag === "NotVideoWallpaperError") {
      expect(res.left.actualType).toBe("unknown")
    }
  })
})
