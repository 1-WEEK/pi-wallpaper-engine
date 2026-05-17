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

export class Display extends Context.Tag("Display")<Display, DisplayImpl>() {}

interface SpawnResult {
  readonly exitCode: number | null
  readonly stderr: string
}

const runCommand = (
  argv: readonly string[],
  logger: { warn: (msg: string) => Effect.Effect<void> }
): Effect.Effect<SpawnResult, DisplayError> =>
  Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn([...argv], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      })

      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        try {
          child.kill()
        } catch {
          // ignore
        }
      }, TIMEOUT_MS)

      try {
        const [stderrBuf, exitCode] = await Promise.all([
          new Response(child.stderr).text(),
          child.exited,
        ])

        if (timedOut) {
          throw new DisplayError({
            kind: "Timeout",
            message: `Command timed out after ${TIMEOUT_MS / 1000}s: ${argv.join(" ")}`,
          })
        }

        return { exitCode, stderr: stderrBuf.slice(-500) }
      } finally {
        clearTimeout(timer)
      }
    },
    catch: (cause) => {
      if (cause instanceof DisplayError) return cause
      const msg = cause instanceof Error ? cause.message : String(cause)
      // Bun.spawn throws synchronously inside the async fn when the binary
      // is missing — surface that distinctly so the user knows to fix PATH.
      Effect.runFork(logger.warn(`Display command spawn failed: ${msg}`))
      return new DisplayError({
        kind: "SpawnFailed",
        message: `Failed to spawn ${argv.join(" ")}: ${msg}`,
      })
    },
  })

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
