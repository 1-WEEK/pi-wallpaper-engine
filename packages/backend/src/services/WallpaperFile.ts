import { Effect } from "effect"
import { readFile, readdir } from "node:fs/promises"
import { resolve, relative } from "node:path"
import { NotVideoWallpaperError, SteamCmdError } from "@pwe/shared"

const VIDEO_EXTS = [".mp4", ".mov", ".webm", ".mkv"]

interface ProjectJson {
  readonly type?: string
  readonly file?: string
  readonly preview?: string
  readonly title?: string
  readonly contentrating?: string
  readonly ratingsex?: string
}

export interface ResolvedWallpaper {
  readonly title: string
  readonly previewAbs: string | null
  readonly videoAbs: string
  readonly contentRating: string | null
  readonly ratingSex: string | null
}

export interface WallpaperAdultMetadata {
  readonly contentRating: string | null
  readonly ratingSex: string | null
}

export const normalizeAdultMetadata = (
  projectJson: ProjectJson | null
): WallpaperAdultMetadata => ({
  contentRating: projectJson?.contentrating ?? null,
  ratingSex: projectJson?.ratingsex ?? null,
})

export const findWorkshopContent = (
  workshopRoot: string,
  workshopId: string,
  weAppId: string
): Effect.Effect<string, SteamCmdError> =>
  Effect.tryPromise({
    try: async () =>
      resolve(
        workshopRoot,
        workshopId,
        "steamapps",
        "workshop",
        "content",
        weAppId,
        workshopId
      ),
    catch: (e) =>
      new SteamCmdError({
        kind: "UnknownFailure",
        message: `Path resolution failed: ${e instanceof Error ? e.message : String(e)}`,
      }),
  })

export const resolveWallpaperFiles = (
  itemDir: string,
  workshopId: string
): Effect.Effect<ResolvedWallpaper, SteamCmdError | NotVideoWallpaperError> =>
  Effect.gen(function* () {
    const projectJson = yield* Effect.tryPromise({
      try: async () => {
        const raw = await readFile(resolve(itemDir, "project.json"), "utf-8")
        return JSON.parse(raw) as ProjectJson
      },
      catch: () => null as ProjectJson | null,
    }).pipe(Effect.catchAll(() => Effect.succeed(null as ProjectJson | null)))

    // WE wallpaper types in project.json: "video", "scene", "web", "application".
    // Only "video" is renderable on the Pi (we just hand it to mpv). Reject
    // others fast with a specific error so the UI can explain why.
    if (projectJson?.type) {
      const t = projectJson.type.toLowerCase()
      if (t !== "video") {
        return yield* Effect.fail(
          new NotVideoWallpaperError({ workshopId, actualType: projectJson.type })
        )
      }
    }

    const entries = yield* Effect.tryPromise({
      try: () => readdir(itemDir),
      catch: (e) =>
        new SteamCmdError({
          kind: "UnknownFailure",
          message: `Cannot list ${itemDir}: ${e instanceof Error ? e.message : String(e)}`,
        }),
    })

    const videoFromJson = projectJson?.file
      ? entries.find((e) => e === projectJson.file)
      : undefined
    const videoGlob = entries.find((e) =>
      VIDEO_EXTS.some((ext) => e.toLowerCase().endsWith(ext))
    )
    const video = videoFromJson ?? videoGlob

    if (!video) {
      // No project.json type, no video file — treat as unrenderable.
      return yield* Effect.fail(
        new NotVideoWallpaperError({
          workshopId,
          actualType: projectJson?.type ?? "unknown",
        })
      )
    }

    const previewName =
      projectJson?.preview ??
      entries.find((e) => /^preview\./i.test(e)) ??
      null

    return {
      title: projectJson?.title ?? "",
      previewAbs: previewName ? resolve(itemDir, previewName) : null,
      videoAbs: resolve(itemDir, video),
      ...normalizeAdultMetadata(projectJson),
    }
  })

export const toRelative = (dataRoot: string, abs: string): string => relative(dataRoot, abs)
