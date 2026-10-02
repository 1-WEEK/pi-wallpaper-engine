import { Effect } from "effect"
import { resolve } from "node:path"
import { StorageError } from "@pwe/shared"
import { Mpv } from "../services/Mpv.js"

export const ensureArtifactNotInUse = (artifactAbs: string) =>
  Effect.gen(function* () {
    const mpv = yield* Mpv
    const status = yield* mpv.status()
    // Pausing keeps mpv's file handle open; SMB still refuses to replace it.
    if (status.path !== null && resolve(status.path) === resolve(artifactAbs)) {
      return yield* Effect.fail(new StorageError({
        kind: "Busy",
        message: "This optimized video is open in the player. Stop playback or switch wallpapers before re-transcoding. Pausing does not release the file.",
      }))
    }
  })
