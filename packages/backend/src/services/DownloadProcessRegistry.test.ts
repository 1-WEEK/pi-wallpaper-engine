import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  downloadProcessRegistryPath,
  makeDownloadProcessRegistryImpl,
  matchesSteamCmdWorkshopCommand,
  steamCmdWorkshopCommand,
  type ProcessCommandLine,
  type ProcessRegistryPlatform,
} from "./DownloadProcessRegistry.js"
import type { LoggerImpl } from "./Logger.js"

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.length = 0
})

const tempStateRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), "pwe-process-registry-"))
  tempDirs.push(dir)
  return dir
}

const steamCmdArgs = (workshopId: string): string[] =>
  steamCmdWorkshopCommand({
    steamcmdPath: "/usr/local/bin/steamcmd",
    installDir: `/media/source/${workshopId}`,
    username: "steam-user",
    workshopId,
  })

const makePlatform = (
  opts: {
    readonly commandLines?: ReadonlyMap<number, readonly string[] | null>
    readonly processes?: ReadonlyArray<ProcessCommandLine>
  } = {}
) => {
  const kills: number[] = []
  const platform: ProcessRegistryPlatform = {
    readCommandLine: async (pid) => opts.commandLines?.get(pid) ?? null,
    listProcesses: async () => opts.processes ?? [],
    kill: (pid) => {
      kills.push(pid)
    },
    now: () => 123,
  }
  return { platform, kills }
}

const makeLogger = () => {
  const lines: string[] = []
  const logger: LoggerImpl = {
    info: (message) => Effect.sync(() => void lines.push(`INFO ${message}`)),
    warn: (message) => Effect.sync(() => void lines.push(`WARN ${message}`)),
    error: (message) => Effect.sync(() => void lines.push(`ERROR ${message}`)),
    debug: () => Effect.void,
  }
  return { logger, lines }
}

describe("matchesSteamCmdWorkshopCommand", () => {
  test("matches the expected SteamCMD workshop download command", () => {
    expect(matchesSteamCmdWorkshopCommand(steamCmdArgs("123"), "123")).toBe(true)
  })

  test("rejects the wrong workshop id", () => {
    expect(matchesSteamCmdWorkshopCommand(steamCmdArgs("123"), "456")).toBe(false)
  })

  test("rejects SteamCMD commands without the workshop marker", () => {
    expect(
      matchesSteamCmdWorkshopCommand(
        ["/usr/local/bin/steamcmd", "+force_install_dir", "/media/source/123", "+login", "u", "+quit"],
        "123"
      )
    ).toBe(false)
  })
})

describe("DownloadProcessRegistry", () => {
  test("stores entries under the local state root", async () => {
    const stateRoot = tempStateRoot()
    const { platform } = makePlatform()
    const registry = makeDownloadProcessRegistryImpl({ stateRoot, platform })

    await Effect.runPromise(registry.register("123", 42, steamCmdArgs("123")))

    const path = downloadProcessRegistryPath("123", stateRoot)
    expect(existsSync(path)).toBe(true)
    expect(path.startsWith(stateRoot)).toBe(true)
    const entry = JSON.parse(readFileSync(path, "utf8"))
    expect(entry).toMatchObject({
      workshopId: "123",
      pid: 42,
      registered_at: 123,
    })
  })

  test("treats PID reuse as stale evidence and does not kill", async () => {
    const stateRoot = tempStateRoot()
    const { platform, kills } = makePlatform({
      commandLines: new Map([[42, steamCmdArgs("456")]]),
    })
    const registry = makeDownloadProcessRegistryImpl({ stateRoot, platform })
    await Effect.runPromise(registry.register("123", 42, steamCmdArgs("123")))

    const result = await Effect.runPromise(registry.stop("123"))

    expect(result).toEqual({ _tag: "NotFound", workshopId: "123" })
    expect(kills).toEqual([])
    expect(existsSync(downloadProcessRegistryPath("123", stateRoot))).toBe(false)
  })

  test("removes stale entries for missing processes", async () => {
    const stateRoot = tempStateRoot()
    const { platform, kills } = makePlatform({
      commandLines: new Map([[42, null]]),
    })
    const registry = makeDownloadProcessRegistryImpl({ stateRoot, platform })
    await Effect.runPromise(registry.register("123", 42, steamCmdArgs("123")))

    const result = await Effect.runPromise(registry.stop("123"))

    expect(result).toEqual({ _tag: "NotFound", workshopId: "123" })
    expect(kills).toEqual([])
    expect(existsSync(downloadProcessRegistryPath("123", stateRoot))).toBe(false)
  })

  test("falls back to process-table scanning when the registry entry is stale", async () => {
    const stateRoot = tempStateRoot()
    const { platform, kills } = makePlatform({
      commandLines: new Map([[42, steamCmdArgs("456")]]),
      processes: [{ pid: 99, argv: steamCmdArgs("123") }],
    })
    const registry = makeDownloadProcessRegistryImpl({ stateRoot, platform })
    await Effect.runPromise(registry.register("123", 42, steamCmdArgs("123")))

    const result = await Effect.runPromise(registry.stop("123"))

    expect(result).toEqual({ _tag: "Stopped", workshopId: "123", source: "scan" })
    expect(kills).toEqual([99])
    expect(existsSync(downloadProcessRegistryPath("123", stateRoot))).toBe(false)
  })

  test("falls back to process-table scanning when the registry entry is missing", async () => {
    const stateRoot = tempStateRoot()
    const { platform, kills } = makePlatform({
      processes: [{ pid: 99, argv: steamCmdArgs("123") }],
    })
    const registry = makeDownloadProcessRegistryImpl({ stateRoot, platform })

    const result = await Effect.runPromise(registry.stop("123"))

    expect(result).toEqual({ _tag: "Stopped", workshopId: "123", source: "scan" })
    expect(kills).toEqual([99])
  })

  test("startup sweep removes stale entries without killing unrelated processes", async () => {
    const stateRoot = tempStateRoot()
    const { platform, kills } = makePlatform({
      commandLines: new Map([[42, null]]),
      processes: [{ pid: 99, argv: steamCmdArgs("999") }],
    })
    const { logger, lines } = makeLogger()
    const registry = makeDownloadProcessRegistryImpl({ stateRoot, platform, logger })
    await Effect.runPromise(registry.register("123", 42, steamCmdArgs("123")))

    await Effect.runPromise(registry.sweep())

    expect(kills).toEqual([])
    expect(existsSync(downloadProcessRegistryPath("123", stateRoot))).toBe(false)
    expect(lines).toContain("INFO Startup sweeping 1 download process registry entry")
    expect(lines).toContain("INFO Startup sweep removed stale SteamCMD registry entry for 123")
  })

  test("startup sweep kills verified leftover SteamCMD processes", async () => {
    const stateRoot = tempStateRoot()
    const { platform, kills } = makePlatform({
      commandLines: new Map([[42, steamCmdArgs("123")]]),
    })
    const { logger, lines } = makeLogger()
    const registry = makeDownloadProcessRegistryImpl({ stateRoot, platform, logger })
    await Effect.runPromise(registry.register("123", 42, steamCmdArgs("123")))

    await Effect.runPromise(registry.sweep())

    expect(kills).toEqual([42])
    expect(existsSync(downloadProcessRegistryPath("123", stateRoot))).toBe(false)
    expect(lines).toContain(
      "INFO Startup sweep stopped leftover SteamCMD process for 123 via registry"
    )
    expect(lines).toContain(
      "INFO Startup download process registry sweep complete: stopped=1, invalid=0"
    )
  })

  test("startup sweep treats mismatched PIDs as stale evidence and does not kill", async () => {
    const stateRoot = tempStateRoot()
    const { platform, kills } = makePlatform({
      commandLines: new Map([[42, ["/bin/sleep", "1000"]]]),
    })
    const registry = makeDownloadProcessRegistryImpl({ stateRoot, platform })
    await Effect.runPromise(registry.register("123", 42, steamCmdArgs("123")))

    await Effect.runPromise(registry.sweep())

    expect(kills).toEqual([])
    expect(existsSync(downloadProcessRegistryPath("123", stateRoot))).toBe(false)
  })
})
