import { Context, Effect, Layer } from "effect"
import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { resolveStateRoot } from "../statePath.js"
import { Logger, type LoggerImpl } from "./Logger.js"

const WE_APPID = "431960"
const REGISTRY_DIR = "download-processes"

export interface SteamCmdWorkshopCommandOptions {
  readonly steamcmdPath: string
  readonly installDir: string
  readonly username: string
  readonly workshopId: string
}

export const steamCmdWorkshopCommand = ({
  steamcmdPath,
  installDir,
  username,
  workshopId,
}: SteamCmdWorkshopCommandOptions): string[] => [
  steamcmdPath,
  "+force_install_dir",
  installDir,
  "+login",
  username,
  "+workshop_download_item",
  WE_APPID,
  workshopId,
  "+quit",
]

export interface DownloadProcessEntry {
  readonly workshopId: string
  readonly pid: number
  readonly argv: readonly string[]
  readonly registered_at: number
}

export interface ProcessCommandLine {
  readonly pid: number
  readonly argv: readonly string[]
}

export interface ProcessRegistryPlatform {
  readonly readCommandLine: (pid: number) => Promise<readonly string[] | null>
  readonly listProcesses: () => Promise<ReadonlyArray<ProcessCommandLine>>
  readonly kill: (pid: number) => void
  readonly now: () => number
}

export type DownloadProcessStopResult =
  | { readonly _tag: "Stopped"; readonly workshopId: string; readonly source: "registry" | "scan" }
  | { readonly _tag: "NotFound"; readonly workshopId: string }

export interface DownloadProcessRegistryImpl {
  readonly register: (
    workshopId: string,
    pid: number,
    argv: readonly string[]
  ) => Effect.Effect<void>
  readonly unregister: (workshopId: string) => Effect.Effect<void>
  readonly stop: (workshopId: string) => Effect.Effect<DownloadProcessStopResult>
  readonly sweep: () => Effect.Effect<void>
}

export class DownloadProcessRegistry extends Context.Tag("DownloadProcessRegistry")<
  DownloadProcessRegistry,
  DownloadProcessRegistryImpl
>() {}

export const downloadProcessRegistryDir = (stateRoot = resolveStateRoot()): string =>
  resolve(stateRoot, REGISTRY_DIR)

export const downloadProcessRegistryPath = (workshopId: string, stateRoot = resolveStateRoot()): string =>
  resolve(downloadProcessRegistryDir(stateRoot), `${encodeURIComponent(workshopId)}.json`)

const hasSteamCmdExecutable = (argv: readonly string[]): boolean =>
  argv.some((part) => basename(part).toLowerCase().includes("steamcmd"))

export const matchesSteamCmdWorkshopCommand = (
  argv: readonly string[],
  workshopId: string
): boolean => {
  if (!workshopId || !hasSteamCmdExecutable(argv)) return false

  const marker = argv.indexOf("+workshop_download_item")
  if (marker < 0) return false
  if (argv[marker + 1] !== WE_APPID || argv[marker + 2] !== workshopId) return false

  return (
    argv.includes("+force_install_dir") &&
    argv.includes("+login") &&
    argv.includes("+quit")
  )
}

const parseRegistryEntry = (raw: string): DownloadProcessEntry | null => {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const workshopId = parsed["workshopId"]
    const pid = parsed["pid"]
    const argv = parsed["argv"]
    const registeredAt = parsed["registered_at"]
    if (
      typeof workshopId !== "string" ||
      typeof pid !== "number" ||
      !Number.isInteger(pid) ||
      pid <= 0 ||
      !Array.isArray(argv) ||
      !argv.every((part) => typeof part === "string") ||
      typeof registeredAt !== "number"
    ) {
      return null
    }
    return {
      workshopId,
      pid,
      argv,
      registered_at: registeredAt,
    }
  } catch {
    return null
  }
}

const readProcCommandLine = async (pid: number): Promise<readonly string[] | null> => {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`)
    const argv = raw.toString("utf8").split("\0").filter(Boolean)
    return argv.length > 0 ? argv : null
  } catch {
    return null
  }
}

const splitPsCommand = (command: string): readonly string[] =>
  command.trim().split(/\s+/).filter(Boolean)

const readPsCommandLine = async (pid: number): Promise<readonly string[] | null> => {
  const child = Bun.spawn(["ps", "-p", String(pid), "-o", "command="], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  })
  const [code, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ])
  if (code !== 0) return null
  const argv = splitPsCommand(stdout)
  return argv.length > 0 ? argv : null
}

const readCommandLine = async (pid: number): Promise<readonly string[] | null> =>
  (await readProcCommandLine(pid)) ?? (await readPsCommandLine(pid))

const listProcProcesses = async (): Promise<ReadonlyArray<ProcessCommandLine> | null> => {
  try {
    const entries = await readdir("/proc")
    const rows: ProcessCommandLine[] = []
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue
      const pid = Number(entry)
      const argv = await readProcCommandLine(pid)
      if (argv) rows.push({ pid, argv })
    }
    return rows
  } catch {
    return null
  }
}

const listPsProcesses = async (): Promise<ReadonlyArray<ProcessCommandLine>> => {
  const child = Bun.spawn(["ps", "-eo", "pid=,command="], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  })
  const [code, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ])
  if (code !== 0) return []

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .flatMap((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/)
      if (!match) return []
      const pid = Number(match[1])
      if (!Number.isInteger(pid) || pid <= 0) return []
      const argv = splitPsCommand(match[2] ?? "")
      return argv.length > 0 ? [{ pid, argv }] : []
    })
}

const defaultPlatform = (): ProcessRegistryPlatform => ({
  readCommandLine,
  listProcesses: async () => (await listProcProcesses()) ?? (await listPsProcesses()),
  kill: (pid) => process.kill(pid, "SIGTERM"),
  now: () => Date.now(),
})

const noopLogger: LoggerImpl = {
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
  debug: () => Effect.void,
}

export const makeDownloadProcessRegistryImpl = (
  opts: {
    readonly stateRoot?: string
    readonly platform?: ProcessRegistryPlatform
    readonly logger?: LoggerImpl
  } = {}
): DownloadProcessRegistryImpl => {
  const stateRoot = opts.stateRoot ?? resolveStateRoot()
  const platform = opts.platform ?? defaultPlatform()
  const logger = opts.logger ?? noopLogger
  const dir = downloadProcessRegistryDir(stateRoot)

  const pathFor = (workshopId: string) => downloadProcessRegistryPath(workshopId, stateRoot)

  const removeEntry = (workshopId: string) =>
    Effect.tryPromise({
      try: () => rm(pathFor(workshopId), { force: true }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(
      Effect.catchAll((error) =>
        logger.warn(`Failed to remove download process registry entry ${workshopId}: ${error.message}`)
      )
    )

  const readEntry = (workshopId: string): Effect.Effect<DownloadProcessEntry | null> =>
    Effect.tryPromise({
      try: async () => {
        const path = pathFor(workshopId)
        if (!existsSync(path)) return null
        return parseRegistryEntry(await readFile(path, "utf8"))
      },
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(
      Effect.flatMap((entry) => (entry ? Effect.succeed(entry) : removeEntry(workshopId).pipe(Effect.as(null)))),
      Effect.catchAll((error) =>
        logger.warn(`Failed to read download process registry entry ${workshopId}: ${error.message}`).pipe(
          Effect.as(null)
        )
      )
    )

  const killProcess = (pid: number): Effect.Effect<boolean> =>
    Effect.try({
      try: () => platform.kill(pid),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(
      Effect.as(true),
      Effect.catchAll((error) =>
        logger.warn(`Failed to stop SteamCMD process ${pid}: ${error.message}`).pipe(Effect.as(false))
      )
    )

  const stopRegistryEntry = (
    entry: DownloadProcessEntry,
    source: "registry"
  ): Effect.Effect<DownloadProcessStopResult | null> =>
    Effect.gen(function* () {
      const argv = yield* Effect.tryPromise({
        try: () => platform.readCommandLine(entry.pid),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      }).pipe(Effect.catchAll(() => Effect.succeed(null)))

      if (!argv || !matchesSteamCmdWorkshopCommand(argv, entry.workshopId)) {
        yield* removeEntry(entry.workshopId)
        yield* logger.info(`Removed stale SteamCMD registry entry for ${entry.workshopId}`)
        return null
      }

      const killed = yield* killProcess(entry.pid)
      if (!killed) return null

      yield* removeEntry(entry.workshopId)
      yield* logger.info(`Stopped SteamCMD process for ${entry.workshopId} via ${source}`)
      return { _tag: "Stopped", workshopId: entry.workshopId, source }
    })

  const scanAndStop = (workshopId: string): Effect.Effect<DownloadProcessStopResult | null> =>
    Effect.gen(function* () {
      const processes = yield* Effect.tryPromise({
        try: () => platform.listProcesses(),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      }).pipe(Effect.catchAll(() => Effect.succeed<ReadonlyArray<ProcessCommandLine>>([])))
      const matches = processes.filter((row) => matchesSteamCmdWorkshopCommand(row.argv, workshopId))
      if (matches.length === 0) return null

      let killed = false
      for (const match of matches) {
        killed = (yield* killProcess(match.pid)) || killed
      }
      if (!killed) return null

      yield* removeEntry(workshopId)
      yield* logger.info(`Stopped SteamCMD process for ${workshopId} via process-table scan`)
      return { _tag: "Stopped", workshopId, source: "scan" }
    })

  return {
    register: (workshopId, pid, argv) =>
      Effect.gen(function* () {
        if (!Number.isInteger(pid) || pid <= 0) {
          yield* logger.warn(`Skipping SteamCMD registry entry for ${workshopId}: invalid pid ${pid}`)
          return
        }

        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(dir, { recursive: true })
            const entry: DownloadProcessEntry = {
              workshopId,
              pid,
              argv: [...argv],
              registered_at: platform.now(),
            }
            const path = pathFor(workshopId)
            const tmp = `${path}.${process.pid}.tmp`
            await writeFile(tmp, `${JSON.stringify(entry, null, 2)}\n`)
            await rename(tmp, path)
          },
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        }).pipe(
          Effect.catchAll((error) =>
            logger.warn(`Failed to register SteamCMD process for ${workshopId}: ${error.message}`)
          )
        )
      }),

    unregister: removeEntry,

    stop: (workshopId) =>
      Effect.gen(function* () {
        const entry = yield* readEntry(workshopId)
        if (entry) {
          const stopped = yield* stopRegistryEntry(entry, "registry")
          if (stopped) return stopped
        }

        const scanned = yield* scanAndStop(workshopId)
        return scanned ?? { _tag: "NotFound", workshopId }
      }),

    sweep: () =>
      Effect.gen(function* () {
        const files = yield* Effect.tryPromise({
          try: async () => {
            if (!existsSync(dir)) return []
            return readdir(dir)
          },
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        }).pipe(Effect.catchAll(() => Effect.succeed<string[]>([])))

        for (const file of files) {
          if (!file.endsWith(".json")) continue
          const raw = yield* Effect.tryPromise({
            try: () => readFile(resolve(dir, file), "utf8"),
            catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
          }).pipe(Effect.catchAll(() => Effect.succeed("")))
          const entry = parseRegistryEntry(raw)
          if (!entry) {
            yield* Effect.tryPromise({
              try: () => rm(resolve(dir, file), { force: true }),
              catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
            }).pipe(Effect.catchAll(() => Effect.void))
            continue
          }
          yield* stopRegistryEntry(entry, "registry")
        }
      }),
  }
}

export const makeDownloadProcessRegistryLive = (
  opts: {
    readonly stateRoot?: string
    readonly platform?: ProcessRegistryPlatform
  } = {}
) =>
  Layer.effect(
    DownloadProcessRegistry,
    Effect.gen(function* () {
      const logger = yield* Logger
      const registry = makeDownloadProcessRegistryImpl({ ...opts, logger })
      yield* registry.sweep()
      return registry
    })
  )

export const DownloadProcessRegistryLive = makeDownloadProcessRegistryLive()
