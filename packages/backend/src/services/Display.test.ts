import { describe, expect, test } from "bun:test"
import { Effect, Either, Layer, ManagedRuntime } from "effect"
import { Config, type RuntimeConfig } from "./Config.js"
import { Logger } from "./Logger.js"
import { Display, DisplayLive } from "./Display.js"

const silentLogger = Layer.succeed(Logger, {
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
  debug: () => Effect.void,
})

// DisplayLive only reads `config.display?.{on,off,status}_command`, so a
// partial config cast is enough — mirrors the mock style in auth-guard.test.ts.
const makeRuntime = (display: unknown) => {
  const configLayer = Layer.succeed(Config, { display } as unknown as RuntimeConfig)
  return ManagedRuntime.make(DisplayLive.pipe(Layer.provide(Layer.merge(configLayer, silentLogger))))
}

describe("DisplayLive", () => {
  test("fails with NotConfigured when the command is absent", async () => {
    const rt = makeRuntime(undefined)
    try {
      const res = await rt.runPromise(Effect.either(Effect.flatMap(Display, (d) => d.on())))
      expect(Either.isLeft(res)).toBe(true)
      if (Either.isLeft(res)) {
        expect(res.left._tag).toBe("DisplayError")
        expect(res.left.kind).toBe("NotConfigured")
      }
    } finally {
      await rt.dispose()
    }
  })

  test("runs a configured command and caches the resulting state", async () => {
    const rt = makeRuntime({ on_command: ["sh", "-c", "exit 0"] })
    try {
      await rt.runPromise(Effect.flatMap(Display, (d) => d.on()))
      const status = await rt.runPromise(Effect.flatMap(Display, (d) => d.status()))
      expect(status).toEqual({ state: "on", source: "cached" })
    } finally {
      await rt.dispose()
    }
  })

  test("surfaces a non-zero exit as NonZeroExit with the exit code", async () => {
    const rt = makeRuntime({ off_command: ["sh", "-c", "exit 3"] })
    try {
      const res = await rt.runPromise(Effect.either(Effect.flatMap(Display, (d) => d.off())))
      expect(Either.isLeft(res)).toBe(true)
      if (Either.isLeft(res)) {
        expect(res.left.kind).toBe("NonZeroExit")
        expect(res.left.exitCode).toBe(3)
      }
    } finally {
      await rt.dispose()
    }
  })

  test("reports default unknown when no probe command and no cache", async () => {
    const rt = makeRuntime(undefined)
    try {
      const status = await rt.runPromise(Effect.flatMap(Display, (d) => d.status()))
      expect(status).toEqual({ state: "unknown", source: "default" })
    } finally {
      await rt.dispose()
    }
  })

  test("reports probed on/off from the status command exit code", async () => {
    const onRt = makeRuntime({ status_command: ["sh", "-c", "exit 0"] })
    try {
      expect(await onRt.runPromise(Effect.flatMap(Display, (d) => d.status()))).toEqual({
        state: "on",
        source: "probed",
      })
    } finally {
      await onRt.dispose()
    }

    const offRt = makeRuntime({ status_command: ["sh", "-c", "exit 1"] })
    try {
      expect(await offRt.runPromise(Effect.flatMap(Display, (d) => d.status()))).toEqual({
        state: "off",
        source: "probed",
      })
    } finally {
      await offRt.dispose()
    }
  })
})
