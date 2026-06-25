import { describe, expect, test } from "bun:test"
import { decideSourcePathRepair, hasSuspectSourceMetadata } from "./Library.js"
import { mergeDownloadTaskRow, reconcileFinishedTaskState } from "./DownloadTasks.js"
import type { DownloadTask } from "@pwe/shared"

const baseTask = (patch: Partial<DownloadTask> = {}): DownloadTask => ({
  workshop_id: "123",
  title: "Test",
  preview_url: "",
  content_rating: null,
  rating_sex: null,
  adult_hint: 0,
  stage: "starting",
  message: "",
  started_at: 1,
  finished_at: null,
  percent: null,
  bytes_done: null,
  bytes_total: null,
  ...patch,
})

describe("mergeDownloadTaskRow", () => {
  test("ignores late progress updates after terminal error", () => {
    const task = baseTask({
      stage: "error",
      message: "Download did not finalize",
      finished_at: 10,
    })

    const merged = mergeDownloadTaskRow(task, {
      stage: "downloading",
      message: "Connecting…",
      percent: 12,
    })

    expect(merged).toEqual(task)
  })

  test("ignores late finalizing updates after terminal success", () => {
    const task = baseTask({
      stage: "complete",
      message: "Library updated",
      finished_at: 10,
    })

    const merged = mergeDownloadTaskRow(task, {
      stage: "finalizing",
      message: "Validating files…",
    })

    expect(merged).toEqual(task)
  })

  test("allows a fresh retry to reset finished_at", () => {
    const task = baseTask({
      stage: "error",
      message: "Download did not finalize",
      finished_at: 10,
    })

    const merged = mergeDownloadTaskRow(task, {
      stage: "starting",
      message: "Queued",
      started_at: 20,
      finished_at: null,
    })

    expect(merged.stage).toBe("starting")
    expect(merged.message).toBe("Queued")
    expect(merged.started_at).toBe(20)
    expect(merged.finished_at).toBeNull()
  })
})

describe("reconcile helpers", () => {
  test("marks inconsistent finished task complete when library row exists", () => {
    expect(reconcileFinishedTaskState(true)).toEqual({
      stage: "complete",
      message: "Library updated",
    })
  })

  test("marks inconsistent finished task error when library row is missing", () => {
    expect(reconcileFinishedTaskState(false)).toEqual({
      stage: "error",
      message: "Download did not finalize",
    })
  })

  test("flags placeholder library metadata as suspect", () => {
    expect(hasSuspectSourceMetadata("unknown", "0x0")).toBe(true)
    expect(hasSuspectSourceMetadata("h264", "0x0")).toBe(true)
    expect(hasSuspectSourceMetadata("unknown", "1920x1080")).toBe(true)
    expect(hasSuspectSourceMetadata("h264", "1920x1080")).toBe(false)
  })
})

describe("decideSourcePathRepair", () => {
  const DOWNLOADS = "source/42/steamapps/workshop/downloads/431960/42/video.mp4"
  const CONTENT = "source/42/steamapps/workshop/content/431960/42/video.mp4"

  test("leaves row untouched when current path exists", () => {
    expect(decideSourcePathRepair(CONTENT, (rel) => rel === CONTENT)).toBeNull()
  })

  test("repairs downloads/ → content/ when content/ exists", () => {
    expect(decideSourcePathRepair(DOWNLOADS, (rel) => rel === CONTENT)).toBe(CONTENT)
  })

  test("repairs content/ → downloads/ when downloads/ exists", () => {
    expect(decideSourcePathRepair(CONTENT, (rel) => rel === DOWNLOADS)).toBe(DOWNLOADS)
  })

  test("leaves row untouched when neither side exists", () => {
    expect(decideSourcePathRepair(DOWNLOADS, () => false)).toBeNull()
  })

  test("leaves row untouched when path has no swap pair", () => {
    expect(decideSourcePathRepair("source/42/other/video.mp4", () => true)).toBeNull()
  })
})
