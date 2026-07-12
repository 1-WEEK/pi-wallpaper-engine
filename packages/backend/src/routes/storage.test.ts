import { describe, expect, test } from "bun:test"
import {
  safeDirName,
  hasControlChars,
  expandHome,
  displayPath,
  isFinishedTask,
  uniqueByPath,
} from "./storage.js"
import { homedir } from "node:os"
import { resolve } from "node:path"

describe("safeDirName", () => {
  test("returns trimmed name for valid input", () => {
    expect(safeDirName("my-folder")).toBe("my-folder")
  })

  test("trims whitespace", () => {
    expect(safeDirName("  hello  ")).toBe("hello")
  })

  test("rejects empty string", () => {
    expect(safeDirName("")).toBeNull()
  })

  test("rejects whitespace-only", () => {
    expect(safeDirName("   ")).toBeNull()
  })

  test('rejects "."', () => {
    expect(safeDirName(".")).toBeNull()
  })

  test('rejects ".."', () => {
    expect(safeDirName("..")).toBeNull()
  })

  test("rejects name containing /", () => {
    expect(safeDirName("foo/bar")).toBeNull()
  })

  test("rejects name containing \\", () => {
    expect(safeDirName("foo\\bar")).toBeNull()
  })

  test("rejects name with control chars", () => {
    expect(safeDirName("foo\nbar")).toBeNull()
    expect(safeDirName("foo\rbar")).toBeNull()
    expect(safeDirName("foo\0bar")).toBeNull()
  })
})

describe("hasControlChars", () => {
  test("detects \\n", () => {
    expect(hasControlChars("hello\nworld")).toBe(true)
  })

  test("detects \\r", () => {
    expect(hasControlChars("hello\rworld")).toBe(true)
  })

  test("detects \\0", () => {
    expect(hasControlChars("hello\0world")).toBe(true)
  })

  test("returns false for normal string", () => {
    expect(hasControlChars("hello world")).toBe(false)
  })

  test("returns false for empty string", () => {
    expect(hasControlChars("")).toBe(false)
  })
})

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

  test("running stage with null finishedAt is not finished", () => {
    expect(isFinishedTask("running", null)).toBe(false)
  })
})

describe("uniqueByPath", () => {
  test("removes duplicate paths", () => {
    const items = [
      { path: "/a", name: "first" },
      { path: "/b", name: "second" },
      { path: "/a", name: "duplicate" },
    ]
    const result = uniqueByPath(items)
    expect(result).toHaveLength(2)
    expect(result[0]!.name).toBe("first")
    expect(result[1]!.name).toBe("second")
  })

  test("preserves order of first occurrence", () => {
    const items = [
      { path: "/c" },
      { path: "/a" },
      { path: "/b" },
      { path: "/a" },
    ]
    expect(uniqueByPath(items).map((i) => i.path)).toEqual(["/c", "/a", "/b"])
  })

  test("returns empty array for empty input", () => {
    expect(uniqueByPath([])).toEqual([])
  })
})

describe("expandHome", () => {
  test("expands ~/ to homedir", () => {
    expect(expandHome("~/Documents")).toBe(resolve(homedir(), "Documents"))
  })

  test("resolves absolute path without change", () => {
    expect(expandHome("/usr/local")).toBe("/usr/local")
  })

  test("resolves relative path against cwd", () => {
    expect(expandHome("relative")).toBe(resolve("relative"))
  })
})

describe("displayPath", () => {
  test("shortens homedir prefix to ~", () => {
    const home = homedir()
    expect(displayPath(`${home}/Documents`)).toBe("~/Documents")
  })

  test("returns non-home path unchanged", () => {
    expect(displayPath("/usr/local")).toBe("/usr/local")
  })
})
