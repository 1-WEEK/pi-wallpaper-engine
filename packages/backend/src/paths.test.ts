import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { expandHome } from "./paths.js"

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
