import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MigrateFailure, copyTree, estimateSize, moveTree, removeTree, verifyTree } from "./index.js"

const tempDirs: string[] = []

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "pwe-migrate-"))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

describe("estimateSize", () => {
  test("counts bytes under a directory", async () => {
    const root = await makeTempDir()
    await writeFile(join(root, "a.bin"), Buffer.alloc(4096, 1))
    await mkdir(join(root, "sub"))
    await writeFile(join(root, "sub", "b.bin"), Buffer.alloc(2048, 1))

    const size = await estimateSize(root)
    expect(size).toBeGreaterThanOrEqual(6144)
  })

  test("returns 0 for a missing directory", async () => {
    expect(await estimateSize(join(tmpdir(), "pwe-migrate-does-not-exist-xyz"))).toBe(0)
  })
})

describe("moveTree", () => {
  test("copies the tree, then removes the source", async () => {
    const root = await makeTempDir()
    const from = join(root, "from")
    const to = join(root, "to")
    await mkdir(join(from, "source", "123"), { recursive: true })
    await writeFile(join(from, "source", "123", "video.mp4"), "fake-video-bytes")
    await writeFile(join(from, "top.txt"), "hello")

    await moveTree({ from, to })

    expect(await readFile(join(to, "source", "123", "video.mp4"), "utf-8")).toBe("fake-video-bytes")
    expect(await readFile(join(to, "top.txt"), "utf-8")).toBe("hello")
    expect(existsSync(from)).toBe(false)
  })

  test("is a no-op when the source does not exist", async () => {
    const root = await makeTempDir()
    await moveTree({ from: join(root, "missing"), to: join(root, "to") })
    expect(existsSync(join(root, "to"))).toBe(false)
  })

  test("reports progress and reaches the source size", async () => {
    const root = await makeTempDir()
    const from = join(root, "from")
    await mkdir(from, { recursive: true })
    await writeFile(join(from, "big.bin"), Buffer.alloc(256 * 1024, 7))

    let lastMoved = 0
    await moveTree({
      from,
      to: join(root, "to"),
      onProgress: (movedBytes) => {
        lastMoved = Math.max(lastMoved, movedBytes)
      },
    })
    expect(lastMoved).toBeGreaterThan(0)
  })

  test("can copy and verify without deleting the source before commit", async () => {
    const root = await makeTempDir()
    const from = join(root, "from")
    const to = join(root, "to")
    await mkdir(join(from, "nested"), { recursive: true })
    await writeFile(join(from, "nested", "video.mp4"), "fake-video-bytes")

    await copyTree({ from, to })
    await verifyTree({ from, to })

    expect(await readFile(join(to, "nested", "video.mp4"), "utf-8")).toBe("fake-video-bytes")
    expect(existsSync(from)).toBe(true)

    await removeTree(from)
    expect(existsSync(from)).toBe(false)
  })

  test("throws Cancelled when the signal is already aborted", async () => {
    const root = await makeTempDir()
    const from = join(root, "from")
    await mkdir(from, { recursive: true })
    await writeFile(join(from, "a.txt"), "x")

    const controller = new AbortController()
    controller.abort()

    let caught: unknown
    try {
      await moveTree({ from, to: join(root, "to"), signal: controller.signal })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(MigrateFailure)
    expect((caught as MigrateFailure).code).toBe("Cancelled")
    expect(existsSync(from)).toBe(true)
  })
})
