import { Context, Effect, Layer, Ref } from "effect"
import { DisplayError } from "@pwe/shared"
import { Config } from "./Config.js"
import { Logger } from "./Logger.js"

const TIMEOUT_MS = 5_000

export type DisplayState = "on" | "off" | "unknown"
export type DisplayStateSource = "probed" | "cached" | "default"

export interface DisplayStatus {
  readonly state: DisplayState
  readonly source: DisplayStateSource
}

export interface DisplayImpl {
  readonly on: () => Effect.Effect<void, DisplayError>
  readonly off: () => Effect.Effect<void, DisplayError>
  readonly status: () => Effect.Effect<DisplayStatus, DisplayError>
}

export class Display extends Context.Service<Display, DisplayImpl>()("Display") {}

interface SpawnResult {
  readonly exitCode: number | null
  readonly stderr: string
}

const runCommand = (
  argv: readonly string[],
  logger: { warn: (msg: string) => Effect.Effect<void> }
): Effect.Effect<SpawnResult, DisplayError> => {
  const spawnError = (cause: unknown) => new DisplayError({
    kind: "SpawnFailed",
    message: `Failed to spawn ${argv.join(" ")}: ${cause instanceof Error ? cause.message : String(cause)}`,
  })
  const timeoutError = () => new DisplayError({
    kind: "Timeout",
    message: `Command timed out after ${TIMEOUT_MS / 1000}s: ${argv.join(" ")}`,
  })

  return Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const child = Bun.spawn([...argv], { stdout: "ignore", stderr: "pipe", stdin: "ignore" })
        return { child, reader: child.stderr.getReader() }
      },
      catch: spawnError,
    }).pipe(Effect.tapError(error => logger.warn(error.message))),
    ({ child, reader }) => Effect.raceFirst(Effect.all([
      Effect.tryPromise({
        try: async () => {
          const decoder = new TextDecoder()
          let tail = ""
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) return (tail + decoder.decode()).slice(-500)
            tail = (tail + decoder.decode(chunk.value, { stream: true })).slice(-500)
          }
        },
        catch: spawnError,
      }),
      Effect.tryPromise({ try: () => child.exited, catch: spawnError }),
    ], { concurrency: "unbounded" }).pipe(
      // The caller may mask interruption to preserve power-command ordering.
      // Deadline losers still need to be interruptible for cleanup to begin.
      Effect.map(([stderr, exitCode]) => ({ stderr, exitCode })),
      Effect.interruptible,
    ), Effect.sleep(TIMEOUT_MS).pipe(
      Effect.andThen(Effect.fail(timeoutError())),
      Effect.interruptible,
    )),
    ({ child, reader }) => Effect.gen(function* () {
      const bounded = <A>(wait: Effect.Effect<A>) => Effect.raceFirst(
        wait.pipe(Effect.as(true), Effect.interruptible),
        Effect.sleep("1 second").pipe(Effect.as(false), Effect.interruptible),
      )
      const signal = (name: NodeJS.Signals) => Effect.sync(() => {
        try { child.kill(name) } catch { /* The child may have exited between checks. */ }
      })
      if (child.exitCode === null) {
        yield* signal("SIGTERM")
        if (!(yield* bounded(Effect.promise(() => child.exited)))) {
          yield* signal("SIGKILL")
          if (!(yield* bounded(Effect.promise(() => child.exited)))) {
            yield* logger.warn(`Display command process ${child.pid} did not exit after SIGKILL`)
          }
        }
      }
      // An exited command can leave stderr open in a descendant. Closing our
      // reader bounds cleanup without waiting for that descendant's lifetime.
      if (!(yield* bounded(Effect.promise(() => reader.cancel().catch(() => undefined))))) {
        yield* logger.warn(`Display command stderr cleanup did not settle for process ${child.pid}`)
      }
    }),
  )
}

const requireConfigured = (
  cmd: readonly string[] | undefined,
  action: string
): Effect.Effect<readonly string[], DisplayError> =>
  cmd
    ? Effect.succeed(cmd)
    : Effect.fail(
        new DisplayError({
          kind: "NotConfigured",
          message: `display.${action}_command is not configured`,
        })
      )

export const DisplayLive = Layer.effect(
  Display,
  Effect.gen(function* () {
    const config = yield* Config
    const logger = yield* Logger
    const cache = yield* Ref.make<DisplayState>("unknown")

    const runForAction = (cmd: readonly string[], label: "on" | "off") =>
      Effect.gen(function* () {
        const result = yield* runCommand(cmd, logger)
        if (result.exitCode !== 0) {
          return yield* Effect.fail(
            new DisplayError({
              kind: "NonZeroExit",
              message: `${label}_command exited with ${result.exitCode}`,
              exitCode: result.exitCode ?? undefined,
              stderr: result.stderr || undefined,
            })
          )
        }
        yield* Ref.set(cache, label)
        yield* logger.info(`Display ${label} command succeeded`)
      })

    return {
      on: () =>
        Effect.gen(function* () {
          const cmd = yield* requireConfigured(config.display?.on_command, "on")
          yield* runForAction(cmd, "on")
        }),

      off: () =>
        Effect.gen(function* () {
          const cmd = yield* requireConfigured(config.display?.off_command, "off")
          yield* runForAction(cmd, "off")
        }),

      status: () =>
        Effect.gen(function* () {
          const probeCmd = config.display?.status_command
          if (probeCmd) {
            const result = yield* runCommand(probeCmd, logger)
            const state: DisplayState = result.exitCode === 0 ? "on" : "off"
            yield* Ref.set(cache, state)
            return { state, source: "probed" }
          }
          const cached = yield* Ref.get(cache)
          if (cached === "unknown") {
            return { state: "unknown", source: "default" }
          }
          return { state: cached, source: "cached" }
        }),
    }
  })
)
