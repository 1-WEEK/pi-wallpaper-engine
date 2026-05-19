import { describe, expect, test } from "bun:test"
import {
  classifyError,
  hasExplicitFailureOutput,
  shouldTreatQuietDownloadAsFinished,
  type DownloadSnapshot,
} from "./SteamCmd.js"

const snapshot = (patch: Partial<DownloadSnapshot> = {}): DownloadSnapshot => ({
  fileCount: 1,
  totalBytes: 100,
  newestMtimeMs: 1_000,
  ...patch,
})

describe("classifyError", () => {
  test("surfaces explicit SteamCMD timeout lines even with exit code 0", () => {
    const err = classifyError(
      "Downloading item 3561017530 ...\nERROR! Timeout downloading item 3561017530",
      0
    )

    expect(err.kind).toBe("Timeout")
    expect(err.message).toContain("timed out")
  })

  test("surfaces explicit disk space failures", () => {
    const err = classifyError(
      "Downloading item 3561017530 ...\nERROR! Download item 3561017530 failed (Not enough free disk space).",
      0
    )

    expect(err.kind).toBe("UnknownFailure")
    expect(err.message).toContain("free disk space")
  })

  test("keeps explicit ERROR lines when SteamCMD concatenates them onto progress output", () => {
    const err = classifyError(
      "Downloading item 3561017530 ...ERROR! Timeout downloading item 3561017530Unloading Steam API...OK",
      0
    )

    expect(err.kind).toBe("Timeout")
  })
})

describe("hasExplicitFailureOutput", () => {
  test("detects ERROR markers even when they are not at line start", () => {
    expect(
      hasExplicitFailureOutput(
        "Downloading item 3561017530 ...ERROR! Timeout downloading item 3561017530"
      )
    ).toBe(true)
  })
})

describe("shouldTreatQuietDownloadAsFinished", () => {
  test("keeps waiting while files are still growing", () => {
    expect(
      shouldTreatQuietDownloadAsFinished(
        snapshot(),
        snapshot({ totalBytes: 250, newestMtimeMs: 2_000 })
      )
    ).toBe(false)
  })

  test("treats unchanged files as finalized", () => {
    expect(
      shouldTreatQuietDownloadAsFinished(
        snapshot({ totalBytes: 250, newestMtimeMs: 2_000 }),
        snapshot({ totalBytes: 250, newestMtimeMs: 2_000 })
      )
    ).toBe(true)
  })

  test("does not proceed before any files exist", () => {
    expect(
      shouldTreatQuietDownloadAsFinished(
        snapshot({ fileCount: 0, totalBytes: 0, newestMtimeMs: 0 }),
        snapshot({ fileCount: 0, totalBytes: 0, newestMtimeMs: 0 })
      )
    ).toBe(false)
  })
})
