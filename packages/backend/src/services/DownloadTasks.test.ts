import { describe, expect, test } from "bun:test"
import { isFinishedTask } from "./DownloadTasks.js"

describe("isFinishedTask", () => {
  test("complete stage with null finishedAt is finished", () => {
    expect(isFinishedTask("complete", null)).toBe(true)
  })

  test("error stage with null finishedAt is finished", () => {
    expect(isFinishedTask("error", null)).toBe(true)
  })

  test("downloading stage with null finishedAt is not finished", () => {
    expect(isFinishedTask("downloading", null)).toBe(false)
  })

  test("downloading stage with finishedAt timestamp is finished", () => {
    expect(isFinishedTask("downloading", Date.now())).toBe(true)
  })
})
