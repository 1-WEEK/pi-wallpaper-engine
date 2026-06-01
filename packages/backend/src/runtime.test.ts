import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { transcodeMode } from "./runtime.js"

const ENV = "PWE_WORKER_API_KEY"
const original = process.env[ENV]

const restore = () => {
  if (original === undefined) delete process.env[ENV]
  else process.env[ENV] = original
}

afterEach(restore)

describe("transcodeMode", () => {
  beforeEach(restore)

  test("returns 'noop' when PWE_WORKER_API_KEY is unset", () => {
    delete process.env[ENV]
    expect(transcodeMode()).toBe("noop")
  })

  test("returns 'noop' when key is shorter than 8 chars", () => {
    process.env[ENV] = "short"
    expect(transcodeMode()).toBe("noop")
  })

  test("returns 'noop' when key is empty", () => {
    process.env[ENV] = ""
    expect(transcodeMode()).toBe("noop")
  })

  test("returns 'live' when key is at least 8 chars", () => {
    process.env[ENV] = "secret-key-1234"
    expect(transcodeMode()).toBe("live")
  })
})
